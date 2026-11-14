import assert from "node:assert/strict";
import { gunzipSync } from "node:zlib";
import type { PluginBlobEntry } from "openclaw/plugin-sdk/plugin-state-runtime";
import { afterEach, expect, it, vi } from "vitest";
import {
  activateMemoryWikiCompiledCacheOwner as activateOwner,
  configureMemoryWikiCompiledCacheStore,
  createMemoryWikiCompiledCacheStore,
  loadMemoryWikiCompiledCache as loadCache,
  writeMemoryWikiCompiledCache as writeCache,
  type MemoryWikiCompiledCacheSnapshot,
} from "./compiled-cache.js";
import { resolveMemoryWikiConfig } from "./config.js";
import {
  buildMemoryWikiImportInsights,
  projectMemoryWikiImportInsight,
} from "./import-insights.js";
import type { WikiPageSummary } from "./markdown.js";
import { createCompiledDigestPage, createCompiledSnapshot } from "./test-helpers.js";
import { buildMemoryWikiOverview, projectMemoryWikiOverviewItem } from "./wiki-overview.js";

function createSnapshot(body: string): MemoryWikiCompiledCacheSnapshot {
  const text = body.slice(0, 700);
  const digest = createCompiledDigestPage({
    aliases: [text],
    personCard: {
      handles: [text],
      socials: [],
      emails: [],
      askFor: [],
      avoidAskingFor: [],
      bestUsedFor: [],
      notEnoughFor: [],
    },
    topRelationships: [{ targetTitle: text, note: text }],
    topClaims: [{ text, status: "supported", freshnessLevel: "fresh" }],
  });
  const page: WikiPageSummary = {
    ...digest,
    absolutePath: "/wiki/entities/snapshot.md",
    relativePath: digest.path,
    hasFrontmatter: true,
    linkTargets: [],
    bridgeAgentIds: [],
    claims: [{ text, evidence: [] }],
    relationships: digest.topRelationships,
    questions: [text],
  };
  const insight = projectMemoryWikiImportInsight(
    { ...page, pageType: "source" },
    {
      frontmatter: { sourceType: "chatgpt-export" },
      body: "## Auto Digest\n- Preference signals:\n  - " + text,
    },
  );
  assert.ok(insight);
  const snapshot = createCompiledSnapshot({
    claimCount: 1,
    contradictionCount: 0,
    pages: [digest],
  });
  snapshot.claims = [
    {
      pageTitle: page.title,
      pageKind: page.kind,
      pagePath: page.relativePath,
      evidenceKinds: [text],
      text,
    },
  ];
  snapshot.dashboards = {
    overview: buildMemoryWikiOverview([page], [projectMemoryWikiOverviewItem(page, body)]),
    importInsights: buildMemoryWikiImportInsights([insight]),
  };
  return snapshot;
}

afterEach(() => configureMemoryWikiCompiledCacheStore(undefined));

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
  activateOwner(config, "vault");
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
  const identity = { vaultGeneration: "vault", compiledCachePublicationId: "publication" };
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
  expect(JSON.stringify(cached)).toBe(serialized);
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

  // Reload must preserve Unicode, lone surrogates, and the durable generation.
  configureMemoryWikiCompiledCacheStore(undefined);
  configureMemoryWikiCompiledCacheStore(store);
  activateOwner(config, identity.vaultGeneration, identity.compiledCachePublicationId);
  const reloaded = await loadCache(config);
  expect(JSON.stringify(reloaded)).toBe(serialized);
});
