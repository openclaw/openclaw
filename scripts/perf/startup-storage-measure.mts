// Real Gateway/model proof; only synthetic Git workspaces and fresh output directories.
// See startup-storage-measure.md. CPU/allocations include inference and settlement;
// the existing chat.send timeline separates startup from those later costs.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { PROTOCOL_VERSION } from "../../packages/gateway-protocol/src/version.ts";
import { isRecord } from "../../packages/normalization-core/src/record-coerce.ts";
import { stopChild } from "../lib/gateway-bench-child.ts";
import { getFreePort } from "../lib/gateway-bench-probes.ts";
import {
  controlGatewayProfile,
  measureGatewayAllocations,
  measureGatewayCpuUsage,
  readGatewayCpuUsage,
} from "../lib/gateway-bench-profile.ts";
import {
  BASE_GATEWAY_BENCH_CONFIG,
  buildGatewayBenchChildArgs,
  createGatewayBenchEnv,
  waitForInitialProbe,
} from "../lib/gateway-bench-runtime.ts";
import { createGatewayWsClient } from "../lib/gateway-ws-client.ts";

const { values } = parseArgs({
  options: {
    output: { type: "string" },
    workspace: { type: "string" },
    entry: { type: "string", default: "dist/entry.js" },
    samples: { type: "string", default: "5" },
    "commit-delay-ms": { type: "string", default: "250" },
    "sandbox-image": { type: "string" },
    allocations: { type: "boolean", default: false },
    "cpu-profile": { type: "boolean", default: false },
  },
});
assert(values.output && values.workspace, "--output and --workspace are required");
assert(process.env.OPENAI_API_KEY, "A scoped OpenAI live-test credential is required");
const samples = Number(values.samples),
  delayMs = Number(values["commit-delay-ms"]);
assert(Number.isSafeInteger(samples) && samples > 0);
assert(Number.isSafeInteger(delayMs) && delayMs >= 0 && delayMs <= 5_000);
assert(!(values.allocations && values["cpu-profile"]), "Profile CPU and allocations separately");
const output = path.resolve(values.output),
  workspace = path.resolve(values.workspace);
await fs.mkdir(output, { mode: 0o700 });
await fs.mkdir(path.join(output, "tmp"));
const state = path.join(output, "state"),
  control = path.join(state, "benchmark-commit-delay.json");
const configPath = path.join(output, "config.json"),
  port = await getFreePort();
await fs.writeFile(
  configPath,
  JSON.stringify({
    ...BASE_GATEWAY_BENCH_CONFIG,
    agents: {
      defaults: {
        workspace,
        skipBootstrap: true,
        model: { primary: "openai/gpt-4.1-mini" },
        models: { "openai/gpt-4.1-mini": { agentRuntime: { id: "openclaw" } } },
        ...(values["sandbox-image"]
          ? {
              sandbox: {
                mode: "all",
                backend: "podman",
                docker: { image: values["sandbox-image"], user: "0:0" },
              },
            }
          : {}),
      },
    },
    plugins: { enabled: true, allow: ["openai"], entries: { openai: { enabled: true } } },
    worktreeAcceleration: true,
    models: {
      providers: {
        openai: {
          baseUrl: "https://api.openai.com/v1",
          apiKey: "${OPENAI_API_KEY}",
          api: "openai-responses",
          models: [
            { id: "gpt-4.1-mini", name: "GPT-4.1 mini", contextWindow: 128000, maxTokens: 4096 },
          ],
        },
      },
    },
    logging: { level: "debug", consoleLevel: "debug", file: path.join(output, "runtime.log") },
  }),
);
const child = spawn(
  process.execPath,
  buildGatewayBenchChildArgs(path.resolve(values.entry), port, [
    "--import",
    fileURLToPath(new URL("../tsx.mjs", import.meta.url)),
    "--import",
    fileURLToPath(new URL("../lib/gateway-bench-profile-preload.ts", import.meta.url)),
  ]),
  {
    detached: true,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    env: createGatewayBenchEnv(path.join(output, "home"), configPath, {
      startupTrace: false,
      caseEnv: {
        NODE_OPTIONS: `--import=${new URL("./startup-storage-delay-preload.mjs", import.meta.url).href}`,
        OPENCLAW_STATE_DIR: state,
        TMPDIR: path.join(output, "tmp"),
        OPENAI_API_KEY: process.env.OPENAI_API_KEY,
        OPENCLAW_DIAGNOSTICS: "timeline",
        OPENCLAW_DIAGNOSTICS_TIMELINE_PATH: path.join(output, "timeline.jsonl"),
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_ATTR_NOSYSTEM: "1",
      },
    }),
  },
);
let logs = "";
child.stdout?.on("data", (bytes: Buffer) => {
  logs += bytes.toString();
});
child.stderr?.on("data", (bytes: Buffer) => {
  logs += bytes.toString();
});
let client: ReturnType<typeof createGatewayWsClient> | undefined;
const terminal = new Map<string, string>();
const results: unknown[] = [];
try {
  const started = performance.now();
  const ready = await waitForInitialProbe({
    port,
    path: "/readyz",
    startAt: started,
    deadlineAt: started + 180_000,
    isDone: () => child.exitCode !== null,
  });
  assert.equal(ready.status, 200, logs);
  client = createGatewayWsClient({
    url: `ws://127.0.0.1:${port}`,
    onEvent: (event) => {
      const payload = event.payload as { runId?: string; state?: string } | undefined;
      if (
        event.event === "chat" &&
        payload?.runId &&
        payload.state &&
        ["final", "error", "aborted"].includes(payload.state)
      ) {
        terminal.set(payload.runId, payload.state);
      }
    },
  });
  await client.waitOpen();
  const rpc = async (method: string, params: Record<string, unknown>) => {
    const result = await client!.request(method, params, 120_000);
    assert(result.ok, JSON.stringify(result.error));
    return result.payload;
  };
  await rpc("connect", {
    minProtocol: PROTOCOL_VERSION,
    maxProtocol: PROTOCOL_VERSION,
    client: {
      id: "gateway-client",
      displayName: "synthetic-storage-proof",
      version: "1.0.0",
      platform: process.platform,
      mode: "backend",
    },
    role: "operator",
    scopes: ["operator.read", "operator.write", "operator.admin"],
    caps: [],
  });
  const sessionKey = "agent:main:storage-proof";
  await rpc("sessions.create", {
    key: sessionKey,
    agentId: "main",
    cwd: workspace,
    worktree: true,
    worktreeName: `storage-proof-${randomUUID()}`,
  });
  let previousRunId: string | undefined;
  for (let index = -2; index < samples; index++) {
    // A chat final can precede ownership release and change the next input's admission path.
    const settleStarted = performance.now();
    if (previousRunId) {
      const completion = (await rpc("agent.wait", {
        runId: previousRunId,
        timeoutMs: 120_000,
      })) as { status: string };
      assert.equal(completion.status, "ok");
    }
    while (true) {
      const description = (await rpc("sessions.describe", { key: sessionKey })) as {
        session: { hasActiveRun?: boolean } | null;
      };
      assert(description.session);
      if (description.session.hasActiveRun === false) {
        break;
      }
      assert(performance.now() - settleStarted < 120_000, "Session did not become idle");
      await delay(50);
    }
    const settleMs = performance.now() - settleStarted;
    const sample = `storage-${index}`,
      beforeLog = logs.length;
    const begin = performance.now(),
      startedAt = Date.now();
    const beforeCpu = await readGatewayCpuUsage(child);
    await fs.writeFile(control, JSON.stringify({ sample, delayMs: index < 0 ? 0 : delayMs }));
    const profilePath = path.join(output, `${sample}.cpuprofile`);
    if (values["cpu-profile"] && index >= 0) {
      await controlGatewayProfile(child, "cpu", "start", profilePath, { includeWorkers: true });
    }
    const send = async () => {
      const sent = (await rpc("chat.send", {
        sessionKey,
        message: `Proof sample ${sample}. Reply exactly STORAGE_PHASES_OK. Do not call any tools.`,
        idempotencyKey: sample,
      })) as { runId: string };
      assert(sent.runId);
      while (!terminal.has(sent.runId)) {
        assert(performance.now() - begin < 240_000, "Send did not settle");
        await delay(50);
      }
      assert.equal(terminal.get(sent.runId), "final");
      return sent.runId;
    };
    try {
      let runId: string | undefined;
      const allocation =
        values.allocations && index >= 0
          ? await measureGatewayAllocations(
              child,
              path.join(output, `${sample}.heapprofile`),
              1,
              async () => {
                runId = await send();
              },
            )
          : undefined;
      runId ??= await send();
      previousRunId = runId;
      const cpu = measureGatewayCpuUsage(beforeCpu, await readGatewayCpuUsage(child));
      results.push({
        sample,
        runId,
        measured: index >= 0,
        settleMs,
        startedAt,
        endedAt: Date.now(),
        durationMs: performance.now() - begin,
        cpu,
        allocation,
        load: loadavg(),
        startup: logs
          .slice(beforeLog)
          .split("\n")
          .find((line) => line.includes("slow chat send") && line.includes("stage=startup")),
      });
    } finally {
      await fs.rm(control, { force: true });
      if (values["cpu-profile"] && index >= 0) {
        await controlGatewayProfile(child, "cpu", "stop", profilePath, { includeWorkers: true });
      }
    }
  }
  const commits = (
    await Promise.all(
      (await fs.readdir(state))
        .filter((name) => /^benchmark-commits\.\d+\.jsonl$/u.test(name))
        .map(async (name) =>
          (await fs.readFile(path.join(state, name), "utf8"))
            .trim()
            .split("\n")
            .filter(Boolean)
            .map(
              (line) => JSON.parse(line) as { sample: string; threadId: number; delayMs: number },
            ),
        ),
    )
  ).flat();
  for (let index = 0; index < samples; index++) {
    assert(
      commits.some(
        (commit) =>
          commit.sample === `storage-${index}` && commit.threadId > 0 && commit.delayMs === delayMs,
      ),
      "No measured worker commits: delay proof is invalid",
    );
  }
  const history = await rpc("chat.history", { sessionKey, limit: 100 });
  assert(isRecord(history) && Array.isArray(history.messages));
  const messages = history.messages.filter(isRecord);
  const textOf = (content: unknown) =>
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .filter(isRecord)
            .filter((part) => part.type === "text" && typeof part.text === "string")
            .map((part) => part.text)
            .join("")
        : "";
  const inputs = messages.filter((message) => message.role === "user");
  const replies = messages.filter((message) => message.role === "assistant");
  assert.equal(inputs.length, samples + 2, "Every accepted input must be committed once");
  assert.equal(replies.length, samples + 2, "Every send must persist an assistant reply");
  for (let index = -2; index < samples; index++) {
    assert.equal(
      inputs.filter((message) => textOf(message.content).includes(`Proof sample storage-${index}.`))
        .length,
      1,
    );
  }
  for (const reply of replies) {
    assert.equal(textOf(reply.content).trim(), "STORAGE_PHASES_OK");
  }
  await fs.writeFile(
    path.join(output, "result.json"),
    JSON.stringify({ delayMs, samples, results, commits }, null, 2),
  );
} finally {
  await fs.rm(control, { force: true });
  client?.close();
  await stopChild(child, { teardownGraceMs: 10_000 });
  await fs.writeFile(path.join(output, "gateway.log"), logs);
}
