import assert from "node:assert/strict";
import { gunzipSync } from "node:zlib";
import type { PluginBlobEntry } from "openclaw/plugin-sdk/plugin-state-runtime";
import { afterEach, expect, it, vi } from "vitest";
import {
  activateMemoryWikiCompiledCacheOwner as activateOwner,
  configureMemoryWikiCompiledCacheStore,
  createMemoryWikiCompiledCacheStore,
  loadMemoryWikiCompiledCache as loadCache,
  readMemoryWikiDashboardState,
  writeMemoryWikiCompiledCache as writeCache,
  type MemoryWikiCompiledCacheSnapshot,
} from "./compiled-cache.js";
import { resolveMemoryWikiConfig } from "./config.js";
import { buildMemoryWikiImportInsights } from "./import-insights.js";
import type { WikiPageSummary } from "./markdown.js";
import { buildMemoryWikiOverview, projectMemoryWikiOverviewItem } from "./wiki-overview.js";

function createSnapshot(body: string): MemoryWikiCompiledCacheSnapshot {
  const text = body.slice(0, 700);
  const usage = { bestUsedFor: [text], notEnoughFor: [text] };
  const shared = {
    ...usage,
    title: text,
    kind: "entity" as const,
    aliases: [text],
    sourceIds: [text],
    contradictions: [text],
    questions: [text],
    personCard: {
      ...structuredClone(usage),
      handles: [text],
      socials: [text],
      emails: [text],
      askFor: [text],
      avoidAskingFor: [text],
    },
  };
  const page: WikiPageSummary = {
    ...shared,
    absolutePath: "/wiki/entities/snapshot.md",
    relativePath: "entities/snapshot.md",
    hasFrontmatter: true,
    linkTargets: [],
    claims: [{ text, evidence: [] }],
    relationships: [{ targetTitle: text, note: text }],
    bridgeAgentIds: [],
  };
  return {
    digest: {
      claimCount: 1,
      contradictionCount: 1,
      pages: [
        {
          ...shared,
          path: page.relativePath,
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

it("owns every compiled branch without changing persisted text", async () => {
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
  activateOwner(config, "vault-generation");
  // The real projection slices its snippet from a much larger source page.
  const snapshot = createSnapshot(
    "漢字-é-😀-e\u0301-\ud800-x-\udc00" + "x".repeat(2 * 1024 * 1024),
  );
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
  const identity = {
    vaultGeneration: "vault-generation",
    compiledCachePublicationId: "publication",
  };
  await writeCache(
    config,
    snapshot,
    identity.compiledCachePublicationId,
    null,
    async () => {
      await expect(loadCache(config)).resolves.toBeNull();
      // Publish persisted bytes, not compiler input changed during the commit.
      claim.text = "changed during commit";
    },
    async () => identity,
  );

  const cached = await loadCache(config);
  assert.ok(cached);
  expect(cached).not.toBe(snapshot);
  expect(JSON.stringify(cached)).toBe(serialized);
  expect(blobs).toHaveLength(1);
  const [blob] = blobs;
  assert.ok(blob);
  expect(gunzipSync(blob).toString("utf8")).toBe(serialized);

  // All nested branches must detach from compiler state.
  digestPage.aliases[0] = "changed alias";
  digestPage.personCard.handles[0] = "changed handle";
  relationship.note = "changed relationship";
  topClaim.text = "changed top claim";
  claim.evidenceKinds[0] = "changed evidence";
  overview.snippet = "changed snippet";
  overview.questions[0] = "changed question";
  insight.summary = "changed summary";
  insight.preferenceSignals[0] = "changed preference";
  expect(JSON.stringify(await loadCache(config))).toBe(serialized);
  await expect(readMemoryWikiDashboardState(config)).resolves.toEqual({
    state: "ready",
    dashboards: cached.dashboards,
  });
  await expect(loadCache(config)).resolves.toBe(cached);

  // Reload must preserve Unicode, lone surrogates, and the durable generation.
  configureMemoryWikiCompiledCacheStore(undefined);
  configureMemoryWikiCompiledCacheStore(store);
  activateOwner(config, identity.vaultGeneration, identity.compiledCachePublicationId);
  const reloaded = await loadCache(config);
  assert.ok(reloaded);
  expect(reloaded).toEqual(cached);
  expect(JSON.stringify(reloaded)).toBe(serialized);
});
