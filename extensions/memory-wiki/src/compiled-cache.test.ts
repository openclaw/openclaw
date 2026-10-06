import assert from "node:assert/strict";
import { gunzipSync } from "node:zlib";
import type { PluginBlobEntry } from "openclaw/plugin-sdk/plugin-state-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  activateMemoryWikiCompiledCacheOwner,
  configureMemoryWikiCompiledCacheStore,
  createMemoryWikiCompiledCacheStore,
  loadMemoryWikiCompiledCache,
  readMemoryWikiDashboardState,
  reconcileMemoryWikiCompiledCacheOwner,
  resolveMemoryWikiCompiledCacheGeneration,
  writeMemoryWikiCompiledCache,
  type MemoryWikiCompiledCacheSnapshot,
} from "./compiled-cache.js";
import { resolveMemoryWikiConfig } from "./config.js";
import { buildMemoryWikiImportInsights } from "./import-insights.js";
import type { WikiPageSummary } from "./markdown.js";
import { buildMemoryWikiOverview, projectMemoryWikiOverviewItem } from "./wiki-overview.js";

function createSnapshot(body: string): MemoryWikiCompiledCacheSnapshot {
  const text = body.slice(0, 700);
  const page: WikiPageSummary = {
    absolutePath: "/wiki/entities/snapshot.md",
    relativePath: "entities/snapshot.md",
    kind: "entity",
    title: text,
    hasFrontmatter: true,
    aliases: [text],
    sourceIds: [text],
    linkTargets: [],
    claims: [{ text, evidence: [] }],
    contradictions: [text],
    questions: [text],
    relationships: [{ targetTitle: text, note: text }],
    bestUsedFor: [text],
    notEnoughFor: [text],
    bridgeAgentIds: [],
    personCard: {
      handles: [text],
      socials: [text],
      emails: [text],
      askFor: [text],
      avoidAskingFor: [text],
      bestUsedFor: [text],
      notEnoughFor: [text],
    },
  };
  return {
    digest: {
      claimCount: 1,
      contradictionCount: 1,
      pages: [
        {
          title: page.title,
          kind: page.kind,
          path: page.relativePath,
          aliases: page.aliases,
          sourceIds: page.sourceIds,
          questions: page.questions,
          contradictions: page.contradictions,
          bestUsedFor: page.bestUsedFor,
          notEnoughFor: page.notEnoughFor,
          personCard: page.personCard,
          relationshipCount: 1,
          topRelationships: page.relationships,
          claimCount: 1,
          topClaims: [{ text, status: "supported", freshnessLevel: "fresh" }],
        },
      ],
    },
    claims: [
      {
        pageTitle: page.title,
        pageKind: page.kind,
        pagePath: page.relativePath,
        aliases: page.aliases,
        sourceIds: page.sourceIds,
        evidenceKinds: [text],
        privacyTiers: [text],
        text,
      },
    ],
    dashboards: {
      overview: buildMemoryWikiOverview([page], [projectMemoryWikiOverviewItem(page, body)]),
      importInsights: buildMemoryWikiImportInsights([
        {
          pagePath: "sources/import.md",
          title: text,
          riskLevel: "low",
          riskReasons: [text],
          labels: [text],
          topicKey: "topic/testing",
          topicLabel: text,
          digestStatus: "available",
          activeBranchMessages: 2,
          userMessageCount: 1,
          assistantMessageCount: 1,
          firstUserLine: text,
          lastUserLine: text,
          assistantOpener: text,
          summary: text,
          candidateSignals: [text],
          correctionSignals: [text],
          preferenceSignals: [text],
        },
      ]),
    },
  };
}

afterEach(() => {
  configureMemoryWikiCompiledCacheStore(undefined);
});

describe("Memory Wiki compiled publication ownership", () => {
  it.each(["plain-ascii", "漢字-é-😀-e\u0301-\ud800-x-\udc00"])(
    "owns every compiled branch without changing persisted text: %s",
    async (prefix) => {
      const blobs: Uint8Array[] = [];
      const store = createMemoryWikiCompiledCacheStore(<T>() => {
        let entry: PluginBlobEntry<T> | undefined;
        return {
          register: vi.fn(async (key: string, bytes: Uint8Array, metadata: T) => {
            entry = { key, bytes, metadata, sizeBytes: bytes.byteLength, createdAt: 0 };
            blobs.push(bytes);
          }),
          lookup: vi.fn(async (key: string) => (entry?.key === key ? entry : undefined)),
          registerIfAbsent: vi.fn(),
          entries: vi.fn(),
          delete: vi.fn(),
          deleteExpiredKey: vi.fn(),
          deleteExpired: vi.fn(),
          clear: vi.fn(),
        };
      });
      configureMemoryWikiCompiledCacheStore(store);
      const config = resolveMemoryWikiConfig({ vault: { path: "/wiki" } });
      activateMemoryWikiCompiledCacheOwner(config, "vault-generation");
      // Exercise the real overview projection: its 700-character snippet can be a
      // slice of this much larger page even after JSON.stringify has visited it.
      const snapshot = createSnapshot(prefix + "x".repeat(2 * 1024 * 1024));
      const digestPage = snapshot.digest.pages[0];
      const claim = snapshot.claims[0];
      const overview = snapshot.dashboards.overview.clusters[0]?.items[0];
      const insight = snapshot.dashboards.importInsights.clusters[0]?.items[0];
      assert.ok(digestPage && claim && overview && insight);
      assert.ok(digestPage.personCard && claim.evidenceKinds);
      const relationship = digestPage.topRelationships[0];
      const topClaim = digestPage.topClaims[0];
      assert.ok(relationship && topClaim);
      const serialized = JSON.stringify(snapshot);
      const generation = resolveMemoryWikiCompiledCacheGeneration(snapshot);
      const identity = {
        vaultGeneration: "vault-generation",
        compiledCachePublicationId: "publication",
      };
      await writeMemoryWikiCompiledCache(
        config,
        snapshot,
        generation,
        identity.compiledCachePublicationId,
        null,
        async () => {
          await expect(loadMemoryWikiCompiledCache(config)).resolves.toBeNull();
          // Publication must use the already-persisted payload, not serialize a
          // possibly changed compiler input again after its asynchronous gates.
          claim.text = "changed during validation";
        },
        async () => {},
        async () => identity,
      );

      const cached = await loadMemoryWikiCompiledCache(config);
      assert.ok(cached);
      expect(cached).not.toBe(snapshot);
      expect(JSON.stringify(cached)).toBe(serialized);
      expect(blobs).toHaveLength(1);
      const [blob] = blobs;
      assert.ok(blob);
      expect(gunzipSync(blob).toString("utf8")).toBe(serialized);
      expect(resolveMemoryWikiCompiledCacheGeneration(cached)).toBe(generation);

      // Cover nested digest, claim, and both dashboard payloads, not just the
      // original overview snippet. None may remain shared with compiler state.
      digestPage.aliases[0] = "changed alias";
      digestPage.personCard.handles[0] = "changed handle";
      relationship.note = "changed relationship";
      topClaim.text = "changed top claim";
      claim.evidenceKinds[0] = "changed evidence";
      overview.snippet = "changed snippet";
      overview.questions[0] = "changed question";
      insight.summary = "changed summary";
      insight.preferenceSignals[0] = "changed preference";
      expect(JSON.stringify(await loadMemoryWikiCompiledCache(config))).toBe(serialized);
      await expect(readMemoryWikiDashboardState(config)).resolves.toEqual({
        state: "ready",
        dashboards: cached.dashboards,
      });
      await expect(loadMemoryWikiCompiledCache(config)).resolves.toBe(cached);

      // A lifecycle reload must expose the identical payload, including Unicode
      // and unpaired UTF-16 surrogates, without changing the durable generation.
      configureMemoryWikiCompiledCacheStore(undefined);
      configureMemoryWikiCompiledCacheStore(store);
      activateMemoryWikiCompiledCacheOwner(
        config,
        identity.vaultGeneration,
        identity.compiledCachePublicationId,
      );
      await reconcileMemoryWikiCompiledCacheOwner(config, async () => identity);
      const reloaded = await loadMemoryWikiCompiledCache(config);
      assert.ok(reloaded);
      expect(reloaded).toEqual(cached);
      expect(JSON.stringify(reloaded)).toBe(serialized);
      expect(resolveMemoryWikiCompiledCacheGeneration(reloaded)).toBe(generation);
    },
  );
});
