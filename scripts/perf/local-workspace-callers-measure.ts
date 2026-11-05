/**
 * Count real local-workspace manifest requests by user action and async caller.
 * Node 26: node --import ./scripts/tsx.mjs scripts/perf/local-workspace-callers-measure.ts <new-scratch-dir> [files=24000]
 * Uses an isolated source Gateway, loopback mock provider and synthetic Git tree.
 * Capture the three owner files below from the baseline into <baseline-dir>/<path>,
 * then set OPENCLAW_BENCH_BASELINE_DIR=<baseline-dir> for the baseline run.
 * Both sides must use the same file count; compare each phase's final resultingRoot.
 * After each run: append `manifest <scratch-dir>` instead of `<new-scratch-dir>`
 * to materialize accepted-manifest.json; compare those files byte-for-byte.
 * Five warm write/add samples must remove one scan each, with identical roots
 * and fresh guest bytes visible to the subsequent file preview. Timings are context.
 * Counts, not timings, decide redundant work on a busy host. Each manifest request
 * retains its action, caller stack and accepted root. Never target a live Gateway.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import { createServer } from "node:http";
import { registerHooks } from "node:module";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { transformSync } from "esbuild";
import { isRecord } from "../../packages/normalization-core/src/record-coerce.ts";
import type { OpenClawConfig } from "../../src/config/types.openclaw.ts";
import { applyMockOpenAiModelConfig } from "../e2e/lib/fixtures/mock-openai-config.mjs";
import { readBody, writeJson, writeSse } from "../e2e/lib/mock-openai-http.mjs";
import { BASE_GATEWAY_BENCH_CONFIG, createGatewayBenchEnv } from "../lib/gateway-bench-runtime.ts";

// Materialize accepted bytes after shutdown, separately from the measured requests.
if (process.argv[2] === "manifest") {
  const directory = path.resolve(process.argv[3]!);
  assert(
    fs.existsSync(path.join(directory, "report.json")),
    "Expected a completed synthetic measurement",
  );
  process.env = createGatewayBenchEnv(
    path.join(directory, "home"),
    path.join(directory, "openclaw.json"),
    {
      startupTrace: false,
      caseEnv: {
        OPENCLAW_STATE_DIR: path.join(directory, "state"),
        TMPDIR: path.join(directory, "tmp"),
      },
    },
  );
  const ids = fs
    .readdirSync(path.join(directory, "state", "worktree-projections"))
    .filter((id) => /^[a-f0-9-]{36}$/.test(id));
  assert.equal(ids.length, 1);
  const { openOpenClawStateDatabase, closeOpenClawStateDatabaseAsync } =
    await import("../../src/state/openclaw-state-db.js");
  const { withLocalWorkspaceStore } =
    await import("../../src/gateway/worker-environments/local-workspace-store.js");
  openOpenClawStateDatabase();
  try {
    await withLocalWorkspaceStore({ worktreeId: ids[0]! }, async (store) => {
      const row = store.get();
      assert(row && !row.pending_ref && !row.journal_json);
      const manifest = await store.manifest(row, { kind: "materialize" });
      assert.equal(manifest.kind, "materialize");
      if (manifest.kind === "materialize") {
        fs.writeFileSync(path.join(directory, "accepted-manifest.json"), manifest.rawManifest);
        console.log(
          JSON.stringify({
            acceptedRoot: row.baseline_ref,
            manifestRef: manifest.manifestRef,
            entries: JSON.parse(manifest.rawManifest).entries.length,
          }),
        );
      }
    });
  } finally {
    await closeOpenClawStateDatabaseAsync();
  }
  process.exit(0);
}

const baseline = process.env.OPENCLAW_BENCH_BASELINE_DIR;
const sourceRoot = fileURLToPath(new URL("../../", import.meta.url));
const ownerFiles = [
  "src/agents/sessions/tools/write.ts",
  "src/agents/agent-tools.read.ts",
  "src/agents/apply-patch-file-ops.ts",
];
const ownerSources = new Map(
  ownerFiles.map((file) => [
    file,
    fs.readFileSync(path.join(baseline ?? sourceRoot, file), "utf8"),
  ]),
);
const loadedOwners = new Set<string>();
const root = path.resolve(process.argv[2]!);
const files = Number(process.argv[3] ?? 24000);
assert(process.argv[2] && Number.isSafeInteger(files) && files > 0);
fs.mkdirSync(root);
const port = 44934;
const mockPort = port + 1;
for (const name of ["home", "tmp", "repo"]) {
  fs.mkdirSync(path.join(root, name));
}
const repo = path.join(root, "repo");
const canonical = path.join(root, "canonical");
const configPath = path.join(root, "openclaw.json");
let phase = "setup";
const counts: Array<Record<string, unknown>> = [];
const steps: Array<Record<string, unknown>> = [];
const probe = (action: { kind: string; target?: string }, stack: string, value?: unknown) => {
  counts.push({
    phase,
    action: { kind: action.kind, ...(action.target ? { target: action.target } : {}) },
    stack,
    value,
  });
};
Object.assign(globalThis, { __workspaceCallerProbe: probe });
const storeFile = fileURLToPath(
  new URL("../../src/gateway/worker-environments/local-workspace-store.ts", import.meta.url),
);
registerHooks({
  load(url, context, nextLoad) {
    const relative = url.startsWith("file:") ? path.relative(sourceRoot, fileURLToPath(url)) : "";
    if (ownerFiles.includes(relative)) {
      loadedOwners.add(relative);
      return {
        format: "module",
        source: transformSync(ownerSources.get(relative)!, {
          loader: "ts",
          format: "esm",
          target: "esnext",
        }).code,
        shortCircuit: true,
      };
    }
    if (url.startsWith("file:") && fileURLToPath(url) === storeFile) {
      let source = fs.readFileSync(storeFile, "utf8");
      const anchor =
        'const readManifest: LocalWorkspaceStore["manifest"] = async (previous, action) => {';
      assert(source.includes(anchor));
      source = source.replace(
        "const env = params.env ?? process.env;",
        "const callerTrace = new Error().stack;\nconst env = params.env ?? process.env;",
      );
      source = source.replace(anchor, anchor + "\nconst callerStack = new Error().stack;");
      source = source.replace(
        "return result.value;",
        'globalThis.__workspaceCallerProbe(action, [callerTrace, callerStack].join("\\n"), result.value.kind === "scan" ? { previousRoot: result.value.previousRoot, resultingRoot: result.value.resultingRoot } : undefined);\nreturn result.value;',
      );
      return {
        format: "module",
        source: transformSync(source, { loader: "ts", format: "esm", target: "esnext" }).code,
        shortCircuit: true,
      };
    }
    return nextLoad(url, context);
  },
});
process.env = createGatewayBenchEnv(path.join(root, "home"), configPath, {
  startupTrace: false,
  caseEnv: {
    OPENCLAW_STATE_DIR: path.join(root, "state"),
    TMPDIR: path.join(root, "tmp"),
    OPENCLAW_SKIP_CHANNELS: "1",
    OPENAI_API_KEY: "synthetic-loopback-only",
    DEVELOPER_DIR: "/Applications/Xcode.app/Contents/Developer",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
    GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
  },
});
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: process.env }).trim();
git(repo, "init", "--quiet", "-b", "main");
git(repo, "config", "user.name", "Synthetic fixture");
git(repo, "config", "user.email", "fixture@example.invalid");
for (let i = 0; i < files; i++) {
  const directory = path.join(repo, `dir${Math.floor(i / 1000)}`);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, `file${i}.txt`), `synthetic ${i}\n`);
}
git(repo, "add", ".");
git(repo, "commit", "--quiet", "-m", "Synthetic workspace");
git(repo, "worktree", "add", "--quiet", "-b", "fixture", canonical);
const config: OpenClawConfig = {
  ...BASE_GATEWAY_BENCH_CONFIG,
  worktreeAcceleration: false,
  gateway: {
    ...BASE_GATEWAY_BENCH_CONFIG.gateway,
    controlUi: { enabled: false, allowedOrigins: [`http://127.0.0.1:${port}`] },
  },
  agents: {
    defaults: {
      sandbox: {
        mode: "all",
        backend: "docker",
        scope: "session",
        workspaceAccess: "rw",
        docker: {
          image: "openclaw-sandbox:bookworm-slim",
          containerPrefix: "openclaw-buf34-",
          network: "none",
        },
      },
    },
    entries: { main: { workspace: repo } },
  },
  cron: { enabled: false },
  tools: { codeMode: { enabled: false }, exec: { applyPatch: { enabled: true } } },
};
applyMockOpenAiModelConfig(config, {
  mockPort,
  modelRef: "openai/workspace-fixture",
  utilityModelRef: "openai/workspace-utility",
});
config.plugins = { enabled: true, allow: ["openai"], slots: { memory: "none" } };
fs.writeFileSync(configPath, JSON.stringify(config));
type Call = { name: string; arguments: Record<string, unknown> };
let pendingCalls: Call[] = [];
const mock = createServer((request, response) => {
  void (async () => {
    try {
      const body: unknown = JSON.parse(await readBody(request));
      assert(isRecord(body));
      const call =
        body.model === "workspace-fixture" && Array.isArray(body.tools) && body.tools.length
          ? pendingCalls.shift()
          : undefined;
      const text = "FIXTURE_DONE";
      const item = call
        ? {
            type: "function_call",
            id: `fc_${randomUUID()}`,
            call_id: `call_${randomUUID()}`,
            name: call.name,
            arguments: JSON.stringify(call.arguments),
          }
        : {
            type: "message",
            id: `msg_${randomUUID()}`,
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text, annotations: [] }],
          };
      const result = {
        id: `resp_${randomUUID()}`,
        object: "response",
        status: "completed",
        output: [item],
        usage: {
          input_tokens: 64,
          output_tokens: 16,
          total_tokens: 80,
          input_tokens_details: { cached_tokens: 0 },
        },
      };
      if (!body.stream) {
        writeJson(response, 200, result);
        return;
      }
      writeSse(response, [
        {
          type: "response.output_item.added",
          output_index: 0,
          item: call ? { ...item, arguments: "" } : { ...item, content: [] },
        },
        call
          ? {
              type: "response.function_call_arguments.delta",
              delta: JSON.stringify(call.arguments),
            }
          : {
              type: "response.output_text.delta",
              item_id: item.id,
              output_index: 0,
              content_index: 0,
              delta: text,
            },
        { type: "response.output_item.done", output_index: 0, item },
        { type: "response.completed", response: result },
      ]);
    } catch (error) {
      writeJson(response, 500, { error: { message: String(error) } });
    }
  })();
});
await new Promise<void>((resolve, reject) => {
  mock.once("error", reject);
  mock.listen(mockPort, "127.0.0.1", resolve);
});
const containers: string[] = [];
let server: { close: (options?: { reason?: string }) => Promise<void> } | undefined;
let peer: { stop: () => void } | undefined;
try {
  const { startGatewayServer } = await import("../../src/gateway/server.js");
  const { GatewayClient } = await import("../../src/gateway/client.js");
  const { insertRegistryWorktree } = await import("../../src/agents/worktrees/registry.js");
  const { upsertSessionEntryCore } = await import("../../src/config/sessions/session-accessor.js");
  (await import("../../src/config/runtime-snapshot.js")).setRuntimeConfigSnapshot(config);
  (await import("../../src/state/openclaw-agent-db.js")).openOpenClawAgentDatabase({
    agentId: "main",
  });
  const sessionKey = `agent:main:dashboard:buf34-${randomUUID()}`;
  const worktree = {
    id: randomUUID(),
    name: "fixture",
    repoFingerprint: "fixture",
    repoRoot: repo,
    path: canonical,
    branch: "fixture",
    baseRef: "main",
    ownerKind: "session" as const,
    ownerId: sessionKey,
    createdAt: Date.now(),
    lastActiveAt: Date.now(),
  };
  await insertRegistryWorktree(process.env, worktree);
  await upsertSessionEntryCore(
    { agentId: "main", sessionKey },
    {
      sessionId: randomUUID(),
      label: "Synthetic workspace",
      updatedAt: Date.now(),
      spawnedCwd: canonical,
      worktree: { id: worktree.id, branch: worktree.branch, repoRoot: repo },
    },
  );
  await (await import("../../src/state/openclaw-agent-db.js")).closeOpenClawAgentDatabasesAsync();
  await (await import("../../src/state/openclaw-state-db.js")).closeOpenClawStateDatabaseAsync();
  server = await startGatewayServer(port, { bind: "loopback", controlUiEnabled: false });
  const ready = Promise.withResolvers<void>();
  const client = new GatewayClient({
    url: `ws://127.0.0.1:${port}`,
    origin: `http://127.0.0.1:${port}`,
    clientName: "openclaw-control-ui",
    mode: "webchat",
    platform: "web",
    instanceId: "synthetic-workspace-callers",
    scopes: ["operator.admin"],
    requestTimeoutMs: 120_000,
    onHelloOk: () => ready.resolve(),
    onConnectError: (e) => ready.reject(e),
  });
  peer = client;
  client.start();
  await ready.promise;
  async function measure<T>(name: string, run: () => Promise<T>) {
    phase = name;
    const before = counts.length;
    const start = performance.now();
    const result = await run();
    const measured = counts.slice(before);
    const step = {
      name,
      ms: performance.now() - start,
      counts: measured.reduce<Record<string, number>>((all, item) => {
        const action = item.action as { kind: string; target?: string };
        const key = `${action.kind}${action.target ? `:${action.target}` : ""}`;
        all[key] = (all[key] ?? 0) + 1;
        return all;
      }, {}),
      result,
    };
    steps.push(step);
    console.log(JSON.stringify({ step: { ...step, result: undefined } }));
    fs.writeFileSync(
      path.join(root, "report.json"),
      JSON.stringify(
        {
          files,
          baseline: Boolean(baseline),
          sources: Object.fromEntries(
            ownerFiles.map((file) => [
              file,
              createHash("sha256").update(ownerSources.get(file)!).digest("hex"),
            ]),
          ),
          steps,
          counts,
        },
        null,
        2,
      ),
    );
    return result;
  }
  async function turn(name: string, calls: Call[] = []) {
    pendingCalls = [...calls];
    await measure(name, async () => {
      const runId = randomUUID();
      await client.request("agent", {
        sessionKey,
        message: `Synthetic ${name}`,
        deliver: false,
        idempotencyKey: runId,
      });
      const result = await client.request<{
        status: string;
        terminalReceipt?: { successfulToolNames?: string[] };
      }>("agent.wait", { runId, timeoutMs: 110_000 });
      assert.equal(result.status, "ok", JSON.stringify(result));
      for (const call of calls) {
        assert(
          result.terminalReceipt?.successfulToolNames?.includes(call.name),
          `Tool did not succeed: ${call.name}: ${JSON.stringify(result)}`,
        );
      }
      assert.equal(pendingCalls.length, 0, "Mock calls were not consumed");
      return result;
    });
  }
  await turn("prepare-and-no-tool-turn");
  const { readRegistry } = await import("../../src/agents/sandbox/registry.js");
  const runtimes = (await readRegistry()).entries;
  for (const runtime of runtimes) {
    assert(runtime.containerName.startsWith("openclaw-buf34-"));
    containers.push(runtime.containerName);
  }
  assert.equal(containers.length, 1);
  await turn("read-turn", [{ name: "read", arguments: { path: "dir0/file0.txt" } }]);
  for (let sample = 0; sample < 5; sample++) {
    await turn(`write-turn-${sample}`, [
      {
        name: "write",
        arguments: { path: `nested/new/file${sample}.txt`, content: "guest write\n" },
      },
    ]);
    assert.equal(
      fs.readFileSync(path.join(canonical, `nested/new/file${sample}.txt`), "utf8"),
      "guest write\n",
    );
    await turn(`patch-turn-${sample}`, [
      {
        name: "apply_patch",
        arguments: {
          input: `*** Begin Patch\n*** Add File: patch/nested/file${sample}.txt\n+patch write\n*** End Patch`,
        },
      },
    ]);
    assert.equal(
      fs.readFileSync(path.join(canonical, `patch/nested/file${sample}.txt`), "utf8"),
      "patch write\n",
    );
  }
  await turn("exec-turn", [
    { name: "exec", arguments: { command: "printf 'exec write\\n' > exec.txt" } },
  ]);
  await turn("mixed-turn", [
    { name: "exec", arguments: { command: "printf 'first\\n' > first.txt" } },
    { name: "write", arguments: { path: "mixed/nested/one.txt", content: "one\n" } },
    { name: "read", arguments: { path: "mixed/nested/one.txt" } },
    { name: "exec", arguments: { command: "printf 'second\\n' > second.txt" } },
    { name: "write", arguments: { path: "mixed/nested/two.txt", content: "two\n" } },
  ]);
  await measure("file-list", () => client.request("sessions.files.list", { sessionKey }));
  await measure("file-preview", () =>
    client.request("sessions.files.get", { sessionKey, path: "nested/new/file0.txt" }),
  );
  await measure("refresh-three-directories", async () => {
    for (const directory of ["", "dir0", "nested"]) {
      await client.request("sessions.files.list", {
        sessionKey,
        ...(directory ? { path: directory } : {}),
      });
    }
  });
  await measure("concurrent-identical-lists", () =>
    Promise.all(
      Array.from({ length: 3 }, () =>
        client.request("sessions.files.list", { sessionKey, path: "dir0" }),
      ),
    ),
  );
  // A real guest write immediately precedes the read; it has no DB revision signal.
  execFileSync(
    "docker",
    ["exec", containers[0]!, "sh", "-c", "printf 'fresh guest bytes\\n' > /workspace/fresh.txt"],
    { env: process.env },
  );
  const fresh = await measure("preview-after-guest-write", () =>
    client.request<{ file: { content: string } }>("sessions.files.get", {
      sessionKey,
      path: "fresh.txt",
    }),
  );
  assert.equal(fresh.file.content, "fresh guest bytes\n");
  await measure("idle-open-client-65s", () => delay(65_000));
  assert.equal(loadedOwners.size, ownerFiles.length);
} finally {
  peer?.stop();
  await server?.close({ reason: "synthetic workspace measurement complete" });
  mock.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    mock.close((error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
  for (const container of containers) {
    execFileSync("docker", ["rm", "--force", container], { env: process.env });
  }
}
