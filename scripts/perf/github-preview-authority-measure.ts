/**
 * Synthetic preview-owner measurement; no network, real credentials, or Gateway.
 * node --import ./scripts/tsx.mjs scripts/perf/github-preview-authority-measure.ts
 *   [iterations=3000] [identity-owner.ts] [--allocations]
 * --cold: issue/PR cold, warm and refresh latency against 200/500/800ms mocks,
 *   plus mixed-credential concurrent viewers; --samples=5 and --delays=... tune it.
 * --personal-display: real synthetic managed-profile I/O with 120 synthetic env
 *   fields, cold account checks plus warm owner CPU; --allocations measures warm
 *   sampled allocation separately. Results include stable display-fact digests.
 * --shared-options: the same display workload across 40 agents with a shared OAuth
 *   profile and real synthetic OAuth-record worker reads; publication expiry is unused.
 * --service-preview --api-owner=src/gateway/<frozen-base>.ts: alternate five
 *   base/candidate samples through the host facade and real preview cache, with
 *   64 concurrent synthetic clients sharing 200 links over 10k session references.
 *   Warm reads must issue zero HTTP requests and preserve the response digest;
 *   compare main-thread CPU and, in a separate --allocations pass, bytes/call.
 * Cold p95 with five samples is context only. Mock delays honor the real preview
 * 2s deadline, so failures at 800ms/hop are reported rather than excluded.
 * Run base/candidate AB/BA. The optional owner is a frozen source file adjacent to
 * github-tool-identity.ts so its relative imports retain the same dependency graph.
 * Acceptance: byte-identical previews and unchanged upstream/auth counts, lower
 * CPU/allocation per warm read. Timing and allocation passes remain separate.
 * Default mode: 10k synthetic session references share 200 issue/PR links across eight repos and
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
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { loadControlUiGitHubPreview } from "../../extensions/github/api.js";
import type { ControlUiGitHubPreviewIdentity } from "../../extensions/github/src/preview-contract.js";
import type { ControlUiGitHubPreviewTarget } from "../../extensions/github/src/preview.js";
import { githubPreviewView } from "../../extensions/github/src/view-model.js";
import { clearGitHubCredentialVerificationCache } from "../../src/agents/github-oauth-client.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../src/config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";

const iterations = Number(process.argv[2] ?? 3000);
assert(Number.isSafeInteger(iterations) && iterations > 0);
const owner = process.argv[3]?.startsWith("--") ? undefined : process.argv[3];
const identityApi: typeof import("../../src/agents/github-tool-identity.js") = await import(
  pathToFileURL(path.resolve(owner ?? "src/agents/github-tool-identity.ts")).href
);
const allocations = process.argv.includes("--allocations");
const sharedOptions = process.argv.includes("--shared-options");
if (
  process.argv.includes("--cold") ||
  process.argv.includes("--personal-display") ||
  process.argv.includes("--service-preview") ||
  sharedOptions
) {
  const args = process.argv.slice(2);
  const value = (name: string, fallback: string) =>
    args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
  const samples = Number(value("samples", "5"));
  const delays = value("delays", "200,500,800").split(",").map(Number);
  assert(Number.isSafeInteger(samples) && samples > 0);
  assert(delays.length && delays.every((ms) => Number.isFinite(ms) && ms >= 0));
  const digest = (values: unknown[]) =>
    createHash("sha256").update(JSON.stringify(values)).digest("hex");
  const percentiles = (values: number[]) => {
    const sorted = values.toSorted((a, b) => a - b);
    return {
      samples: sorted.length,
      p50Ms: sorted[Math.ceil(sorted.length * 0.5) - 1],
      p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
      p95ContextOnly: sorted.length < 200,
      p99Ms: sorted[Math.ceil(sorted.length * 0.99) - 1],
      p99ContextOnly: sorted.length < 1000,
    };
  };

  function previewIdentity(account: string): ControlUiGitHubPreviewIdentity {
    return {
      token: `synthetic-${account}`,
      cacheScope: `synthetic-account:${account}`,
      assertSelected() {},
      revalidate: async () => {},
    };
  }

  function previewTransport(initialDelay: number) {
    let latency = initialDelay;
    let calls: Array<{ path: string; account: string; conditional: boolean; status?: number }> = [];
    const fetcher: typeof fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      assert.equal(url.origin, "https://api.github.com");
      const headers = new Headers(init?.headers);
      const account = headers.get("authorization")?.replace("Bearer synthetic-", "") ?? "anonymous";
      const etag = `"${account}:${url.pathname}"`;
      const conditional = headers.get("if-none-match") === etag;
      const call = {
        path: url.pathname,
        account,
        conditional,
        status: undefined as number | undefined,
      };
      calls.push(call);
      if (latency) {
        await delay(latency, undefined, { signal: init?.signal ?? undefined });
      }
      init?.signal?.throwIfAborted();
      call.status = conditional ? 304 : 200;
      const responseHeaders = {
        etag,
        "x-ratelimit-limit": "5000",
        "x-ratelimit-remaining": conditional ? "5000" : "4999",
        "x-ratelimit-reset": "2000000000",
      };
      if (conditional) {
        return new Response(null, { status: 304, headers: responseHeaders });
      }
      const parts = url.pathname.split("/");
      assert.equal(parts[1], "repos");
      if (parts.length === 4) {
        return Response.json(
          { private: false, visibility: "public" },
          { headers: responseHeaders },
        );
      }
      if (parts[6] === "commits") {
        return Response.json([], { headers: responseHeaders });
      }
      const repositoryUrl = `https://api.github.com/repos/${parts[2]}/${parts[3]}`;
      return Response.json(
        {
          title: `Synthetic item ${parts[5]}`,
          state: "open",
          user: { login: account },
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-01T00:00:00Z",
          comments: 3,
          additions: 10,
          deletions: 2,
          repository_url: repositoryUrl,
          base: { repo: { url: repositoryUrl } },
        },
        { headers: responseHeaders },
      );
    };
    return {
      fetcher,
      reset(ms: number) {
        calls = [];
        latency = ms;
      },
      counts() {
        return {
          requests: calls.length,
          completed200: calls.filter((call) => call.status === 200).length,
          completed304: calls.filter((call) => call.status === 304).length,
          conditionalRequests: calls.filter((call) => call.conditional).length,
          paths: calls.map((call) => call.path),
        };
      },
    };
  }

  async function measurePreviews() {
    for (const kind of ["issue", "pull"] as const) {
      const target = { owner: "synthetic", repo: "fixture", kind, number: 123 };
      for (const latency of delays) {
        for (const mode of ["cold", "warm", "refresh"] as const) {
          const timings: number[] = [];
          const responses: unknown[] = [];
          const counts = [];
          const hostLoad = loadavg();
          const cpu = process.threadCpuUsage();
          for (let index = 0; index < samples; index++) {
            const transport = previewTransport(0);
            const identity = previewIdentity("a");
            if (mode !== "cold") {
              await loadControlUiGitHubPreview(target, identity, transport.fetcher);
            }
            transport.reset(latency);
            const started = performance.now();
            try {
              responses.push(
                await loadControlUiGitHubPreview(
                  target,
                  identity,
                  transport.fetcher,
                  mode === "refresh",
                ),
              );
            } catch (error) {
              responses.push({ error: error instanceof Error ? error.name : "UnknownError" });
            }
            timings.push(performance.now() - started);
            counts.push(transport.counts());
          }
          const used = process.threadCpuUsage(cpu);
          console.log(
            JSON.stringify({
              workload: "preview",
              kind,
              mode,
              mockLatencyMs: latency,
              ...percentiles(timings),
              failures: responses.filter(
                (response) =>
                  response !== null && typeof response === "object" && "error" in response,
              ).length,
              cpuUsPerSampleIncludingSeed: (used.user + used.system) / samples,
              counts,
              responseDigest: digest(responses),
              hostLoad,
            }),
          );
        }
      }
    }
    const transport = previewTransport(200);
    const target: ControlUiGitHubPreviewTarget = {
      owner: "synthetic",
      repo: "fixture",
      kind: "pull",
      number: 123,
    };
    // Same resource joins; a new credential in the same declared scope cannot join it.
    const first = previewIdentity("a");
    const second = { ...previewIdentity("b"), cacheScope: first.cacheScope };
    const readers = Array.from({ length: 12 }, (_, index) => (index % 2 ? first : second));
    const responses = await Promise.all(
      readers.map((identity) => loadControlUiGitHubPreview(target, identity, transport.fetcher)),
    );
    for (let index = 0; index < readers.length; index++) {
      assert.equal(responses[index]!.login, index % 2 ? "a" : "b");
    }
    assert.equal(transport.counts().requests, 8);
    console.log(
      JSON.stringify({
        workload: "preview-concurrent-credential-isolation",
        readers: readers.length,
        ...transport.counts(),
        responseDigest: digest(responses),
      }),
    );
  }

  async function measurePersonalDisplay() {
    const originalEnv = { ...process.env };
    const originalFetch = globalThis.fetch;
    await fs.mkdir(".local", { recursive: true });
    const stateDir = await fs.mkdtemp(path.resolve(".local/github-cold-measure-"));
    const inspector = new Session();
    let fetches = 0;
    let latency = 0;
    let closeState: (() => Promise<void>) | undefined;
    try {
      // Keep Node's native environment object: replacing it with a plain object
      // removes the enumeration/access cost that this workload measures.
      for (const name of Object.keys(process.env)) {
        delete process.env[name];
      }
      Object.assign(process.env, {
        ...Object.fromEntries(
          Array.from({ length: 120 }, (_, index) => [
            `SYNTHETIC_ENV_${index}`,
            `synthetic-value-${index}-${"x".repeat(64)}`,
          ]),
        ),
        OPENCLAW_STATE_DIR: stateDir,
      });
      setRuntimeConfigSnapshot({});
      globalThis.fetch = async (input) => {
        assert.equal(
          input instanceof Request ? input.url : String(input),
          "https://api.github.com/user",
        );
        fetches++;
        if (latency) {
          await delay(latency);
        }
        return Response.json(
          { id: 123, login: "synthetic-display", avatar_url: null },
          {
            headers: { "x-ratelimit-limit": "5000", "x-ratelimit-remaining": "4999" },
          },
        );
      };
      const profileId = `ghp_${"1".repeat(32)}`;
      const config: OpenClawConfig = {
        tools: { github: { profileId, kind: "oauth" } },
        agents: {
          entries: Object.fromEntries(
            Array.from({ length: 40 }, (_, index) => [`agent-${index}`, {}]),
          ),
        },
      };
      if (sharedOptions) {
        const state = await import("../../src/state/openclaw-state-db.js");
        const records = await import("../../src/agents/github-oauth-records.js");
        state.openOpenClawStateDatabase();
        closeState = state.closeOpenClawStateDatabaseAsync;
        const now = Date.now();
        await records.writeGitHubOAuthRecord({
          version: 1,
          profileId,
          agentId: "agent-0",
          scope: "system",
          accountId: 123,
          login: "synthetic-display",
          refreshToken: "synthetic-shared-refresh",
          scopes: ["repo"],
          accessExpiresAtMs: now + 3_600_000,
          refreshExpiresAtMs: now + 86_400_000,
          createdAtMs: now,
        });
        setRuntimeConfigSnapshot(config);
      }
      const directory = identityApi.resolveManagedGitHubProfileDir({
        agentId: "",
        scope: sharedOptions ? "system" : "personal",
        profileId,
      });
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      await fs.writeFile(
        path.join(directory, "hosts.yml"),
        "github.com:\n  oauth_token: synthetic-personal-measure\n",
        { mode: 0o600 },
      );
      await fs.writeFile(path.join(directory, "config.yml"), "{}\n", { mode: 0o600 });
      let reads = 0;
      const read = async () => {
        const identity = sharedOptions
          ? await identityApi.prepareGitHubPublicationOptionsIdentity({
              config,
              agentId: `agent-${reads++ % 40}`,
              assertCurrent() {},
            })
          : await identityApi.preparePersonalGitHubPublicationIdentity({
              profileId,
              accountId: 123,
              assertCurrent() {},
              forDisplay: true,
            });
        return { account: identity.account, stale: identity.stale ?? false };
      };
      if (!allocations) {
        for (const mockLatencyMs of delays) {
          latency = mockLatencyMs;
          const timings: number[] = [];
          const responses: unknown[] = [];
          fetches = 0;
          for (let index = 0; index < samples; index++) {
            clearGitHubCredentialVerificationCache();
            const started = performance.now();
            responses.push(await read());
            timings.push(performance.now() - started);
          }
          console.log(
            JSON.stringify({
              workload: sharedOptions ? "shared-options-cold" : "personal-display-cold",
              mockLatencyMs,
              ...percentiles(timings),
              fetches,
              responseDigest: digest(responses),
            }),
          );
        }
      }
      latency = 0;
      clearGitHubCredentialVerificationCache();
      for (let index = 0; index < 1_000; index++) {
        await read();
      }
      // Start the timed warm pass with the same verification-cache age in both arms.
      clearGitHubCredentialVerificationCache();
      await read();
      fetches = 0;
      if (allocations) {
        inspector.connect();
        await inspector.post("HeapProfiler.startSampling", {
          samplingInterval: 32768,
          includeObjectsCollectedByMajorGC: true,
          includeObjectsCollectedByMinorGC: true,
        });
      }
      const resultDigest = createHash("sha256");
      const hostLoad = loadavg();
      const cpu = process.threadCpuUsage();
      const started = performance.now();
      const timings: number[] = [];
      for (let index = 0; index < iterations; index++) {
        const callStarted = performance.now();
        resultDigest.update(JSON.stringify(await read()));
        timings.push(performance.now() - callStarted);
      }
      const elapsedMs = performance.now() - started;
      const used = process.threadCpuUsage(cpu);
      const sampledBytes = allocations
        ? (await inspector.post("HeapProfiler.stopSampling")).profile.samples.reduce(
            (sum, entry) => sum + entry.size,
            0,
          )
        : undefined;
      console.log(
        JSON.stringify({
          workload: sharedOptions ? "shared-options-warm" : "personal-display-warm",
          owner: owner ?? "src/agents/github-tool-identity.ts",
          cpuKind: "main-thread",
          iterations,
          allocations,
          hostLoad,
          elapsedMs,
          ...percentiles(timings),
          fetches,
          cpuUsPerCall: (used.user + used.system) / iterations,
          sampledBytesPerCall: sampledBytes === undefined ? undefined : sampledBytes / iterations,
          responseDigest: resultDigest.digest("hex"),
          memory: process.memoryUsage(),
        }),
      );
    } finally {
      inspector.disconnect();
      await closeState?.();
      globalThis.fetch = originalFetch;
      for (const name of Object.keys(process.env)) {
        delete process.env[name];
      }
      Object.assign(process.env, originalEnv);
      clearRuntimeConfigSnapshot();
      clearGitHubCredentialVerificationCache();
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  }

  if (process.argv.includes("--service-preview")) {
    const baseline = value("api-owner", "");
    assert(baseline, "--service-preview requires --api-owner=<frozen-base.ts>");
    const apis: Array<{
      arm: string;
      api: typeof import("../../src/gateway/github-public-api.js");
    }> = [
      { arm: "base", api: await import(pathToFileURL(path.resolve(baseline)).href) },
      { arm: "candidate", api: await import("../../src/gateway/github-public-api.js") },
    ];
    const sessions = Array.from(
      { length: 10_000 },
      (_, index) =>
        ({
          owner: "synthetic",
          repo: `repo-${index % 8}`,
          kind: index % 2 ? "pull" : "issue",
          number: (index % 100) + 1,
        }) satisfies ControlUiGitHubPreviewTarget,
    );
    const inspector = new Session();
    let expectedDigest: string | undefined;
    let workerPosts = 0;
    // eslint-disable-next-line @typescript-eslint/unbound-method -- The probe forwards the original Worker receiver and restores the method afterward.
    const postMessage = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (this: Worker, ...messageArgs) {
      workerPosts++;
      return postMessage.apply(this, messageArgs);
    };
    setRuntimeConfigSnapshot({
      gateway: { controlUi: { github: { token: "synthetic-service-preview" } } },
    });
    try {
      if (allocations) {
        inspector.connect();
      }
      for (let sample = 0; sample < samples; sample++) {
        for (const { arm, api } of sample % 2 ? apis.toReversed() : apis) {
          const transport = previewTransport(0);
          const read = (index: number) =>
            api.gitHubPublicApi.loadControlUiGitHubPreview(
              sessions[index % sessions.length]!,
              undefined,
              transport.fetcher,
            );
          // Populate every key and warm JIT separately from the measured work.
          for (let index = 0; index < 1_000; index++) {
            await read(index);
          }
          transport.reset(0);
          workerPosts = 0;
          if (allocations) {
            await inspector.post("HeapProfiler.startSampling", {
              samplingInterval: 4096,
              includeObjectsCollectedByMajorGC: true,
              includeObjectsCollectedByMinorGC: true,
            });
          }
          const hostLoad = loadavg();
          const responseDigest = createHash("sha256");
          const cpu = process.threadCpuUsage();
          const started = performance.now();
          for (let index = 0; index < iterations; index += 64) {
            const replies = await Promise.all(
              Array.from({ length: Math.min(64, iterations - index) }, (_, offset) =>
                read(index + offset),
              ),
            );
            for (const reply of replies) {
              responseDigest.update(JSON.stringify(reply));
            }
          }
          const elapsedMs = performance.now() - started;
          const used = process.threadCpuUsage(cpu);
          const sampledBytes = allocations
            ? (await inspector.post("HeapProfiler.stopSampling")).profile.samples.reduce(
                (sum, entry) => sum + entry.size,
                0,
              )
            : undefined;
          assert.equal(transport.counts().requests, 0, "warm preview unexpectedly fetched");
          assert.equal(workerPosts, 0, "warm preview unexpectedly posted to a worker");
          const resultDigest = responseDigest.digest("hex");
          expectedDigest ??= resultDigest;
          assert.equal(resultDigest, expectedDigest, "preview payload changed between samples");
          console.log(
            JSON.stringify({
              workload: "service-preview",
              arm,
              sample,
              iterations,
              allocations,
              hostLoad,
              elapsedMs,
              cpuUsPerCall: (used.user + used.system) / iterations,
              sampledBytesPerCall:
                sampledBytes === undefined ? undefined : sampledBytes / iterations,
              fetches: transport.counts().requests,
              workerPosts,
              responseDigest: resultDigest,
              memory: process.memoryUsage(),
            }),
          );
        }
      }
    } finally {
      Worker.prototype.postMessage = postMessage;
      inspector.disconnect();
      clearRuntimeConfigSnapshot();
    }
  }
  if (process.argv.includes("--cold")) {
    await measurePreviews();
  }
  if (process.argv.includes("--personal-display") || sharedOptions) {
    await measurePersonalDisplay();
  }
} else {
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
}
