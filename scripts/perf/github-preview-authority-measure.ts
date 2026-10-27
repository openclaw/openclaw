/**
 * Synthetic preview-owner measurement; no network, real credentials, or Gateway.
 * node --import ./scripts/tsx.mjs scripts/perf/github-preview-authority-measure.ts
 *   [iterations=3000] [identity-owner.ts] [--allocations]
 * Run base/candidate AB/BA. The optional owner is a frozen source file adjacent to
 * github-tool-identity.ts so its relative imports retain the same dependency graph.
 * Acceptance: byte-identical previews and unchanged upstream/auth counts, lower
 * CPU/allocation per warm read. Timing and allocation passes remain separate.
 * 10k synthetic session references share 100 issue/PR links across eight repos and
 * 40 agents. Measures cache/load, live authority, mock fetch/parse and projection;
 * it does not measure sessions.list, socket churn, or whole-Gateway latency.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { loadControlUiGitHubPreview } from "../../extensions/github/api.js";
import type { ControlUiGitHubPreviewTarget } from "../../extensions/github/src/preview.js";
import { githubPreviewView } from "../../extensions/github/src/view-model.js";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";

const iterations = Number(process.argv[2] ?? 3000);
assert(Number.isSafeInteger(iterations) && iterations > 0);
const owner = process.argv[3]?.startsWith("--") ? undefined : process.argv[3];
const identityApi: typeof import("../../src/agents/github-tool-identity.js") = await import(
  pathToFileURL(path.resolve(owner ?? "src/agents/github-tool-identity.ts")).href
);
const allocations = process.argv.includes("--allocations");
await fs.mkdir(".local", { recursive: true });
const stateDir = await fs.mkdtemp(path.resolve(".local/github-preview-measure-"));
let stateDirReads = 0;
const env = {
  get OPENCLAW_STATE_DIR() {
    stateDirReads++;
    return stateDir;
  },
};
const profileId = `ghp_${"1".repeat(32)}`;
const config: OpenClawConfig = {
  tools: { github: { profileId } },
  agents: {
    entries: Object.fromEntries(
      Array.from({ length: 40 }, (_, i) => [
        `agent-${i}`,
        { tools: i % 2 ? { github: { profileId } } : {} },
      ]),
    ),
  },
};
const stamp = "2026-01-01T00:00:00Z";
let fetches = 0;
let fetchMs = 0;
let authorityCalls = 0;
let authorityMs = 0;
let parses = 0;
let parseMs = 0;
const mockFetch: typeof fetch = async (input) => {
  const started = performance.now();
  fetches++;
  try {
    const url = new URL(input instanceof Request ? input.url : String(input));
    assert.equal(url.origin, "https://api.github.com");
    if (url.pathname === "/user") {
      return Response.json({ id: 123, login: "synthetic", avatar_url: null });
    }
    const parts = url.pathname.split("/");
    assert.equal(parts[1], "repos");
    if (parts.length === 4) {
      return Response.json({ private: false, visibility: "public" });
    }
    if (parts[6] === "commits") {
      return Response.json([]);
    }
    const repositoryUrl = `https://api.github.com/repos/${parts[2]}/${parts[3]}`;
    return Response.json({
      title: `Synthetic item ${parts[5]}`,
      state: "open",
      user: { login: "synthetic" },
      created_at: stamp,
      updated_at: stamp,
      comments: 3,
      additions: 10,
      deletions: 2,
      repository_url: repositoryUrl,
      base: { repo: { url: repositoryUrl } },
    });
  } finally {
    fetchMs += performance.now() - started;
  }
};
const originalFetch = globalThis.fetch;
const originalParse = JSON.parse;
const inspector = new Session();
try {
  globalThis.fetch = mockFetch;
  const identities: Awaited<ReturnType<typeof identityApi.prepareGitHubReadIdentity>>[] = [];
  for (let i = 0; i < 40; i++) {
    const agentId = `agent-${i}`;
    const directory = identityApi.resolveManagedGitHubProfileDir({
      agentId,
      scope: i % 2 ? "agent" : "system",
      profileId,
      env,
    });
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    await fs.writeFile(
      path.join(directory, "hosts.yml"),
      "github.com:\n  oauth_token: synthetic-preview-measure\n",
      { mode: 0o600 },
    );
    const identity = await identityApi.prepareGitHubReadIdentity({
      config,
      agentId,
      env,
      getCurrentConfig: () => config,
      assertActive: () => {},
      refresh: async () => {},
    });
    const revalidate = identity.revalidate;
    identity.revalidate = async () => {
      const started = performance.now();
      authorityCalls++;
      try {
        await revalidate();
      } finally {
        authorityMs += performance.now() - started;
      }
    };
    identities.push(identity);
  }
  const sessions = Array.from({ length: 10_000 }, (_, i) => ({
    identity: identities[i % 40]!,
    target: {
      owner: "synthetic",
      repo: `repo-${i % 8}`,
      kind: i % 2 ? "pull" : "issue",
      number: (i % 100) + 1,
    } satisfies ControlUiGitHubPreviewTarget,
  }));
  const bytes = new Map<number, string>();
  const read = async (index: number) => {
    const { identity, target } = sessions[index % sessions.length]!;
    return loadControlUiGitHubPreview(target, identity, mockFetch);
  };
  for (let i = 0; i < 200; i++) {
    bytes.set(i, JSON.stringify(githubPreviewView(await read(i))));
  }
  fetches = fetchMs = authorityCalls = authorityMs = parses = parseMs = stateDirReads = 0;
  JSON.parse = new Proxy(originalParse, {
    apply(target, receiver, args) {
      const started = performance.now();
      parses++;
      try {
        return Reflect.apply(target, receiver, args);
      } finally {
        parseMs += performance.now() - started;
      }
    },
  });
  if (allocations) {
    inspector.connect();
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 32768,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  let loadMs = 0;
  let projectionMs = 0;
  const digest = createHash("sha256");
  const hostLoad = loadavg();
  const cpu = process.cpuUsage();
  const started = performance.now();
  for (let i = 0; i < iterations; i++) {
    const loadStarted = performance.now();
    const preview = await read(i);
    loadMs += performance.now() - loadStarted;
    const projectionStarted = performance.now();
    const view = githubPreviewView(preview);
    projectionMs += performance.now() - projectionStarted;
    const result = JSON.stringify(view);
    assert.equal(result, bytes.get(i % 200));
    digest.update(result);
  }
  const elapsedMs = performance.now() - started;
  const used = process.cpuUsage(cpu);
  const sampledBytes = allocations
    ? (await inspector.post("HeapProfiler.stopSampling")).profile.samples.reduce(
        (sum, entry) => sum + entry.size,
        0,
      )
    : undefined;
  console.log(
    JSON.stringify({
      iterations,
      allocations,
      hostLoad,
      elapsedMs,
      cpuUsPerCall: (used.user + used.system) / iterations,
      sampledBytesPerCall: sampledBytes === undefined ? undefined : sampledBytes / iterations,
      phasesMs: {
        cacheAndLoad: loadMs,
        authority: authorityMs,
        fetch: fetchMs,
        parse: parseMs,
        projection: projectionMs,
      },
      fetches,
      authorityCalls,
      parses,
      stateDirReads,
      responseDigest: digest.digest("hex"),
      memory: process.memoryUsage(),
    }),
  );
} finally {
  globalThis.fetch = originalFetch;
  JSON.parse = originalParse;
  inspector.disconnect();
  await fs.rm(stateDir, { recursive: true, force: true });
}
