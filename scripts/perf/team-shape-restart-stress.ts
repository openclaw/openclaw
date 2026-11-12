/**
 * Opt-in process/reliability scenario for team-shape-stress.ts; never scheduled in CI.
 * Dry: node --import ./scripts/tsx.mjs scripts/perf/team-shape-stress.ts --restart-chaos
 *   --dry --output /absolute/new-report-directory
 * Live: replace --dry with --live-model openai/<approved-model> --key-file /secure/key
 * See team-shape-stress.md for evidence limits and candidate replay.
 */
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { appendFile, cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { isGatewayProtocolResponseError } from "../../packages/gateway-client/src/protocol-request.ts";
import { GATEWAY_STARTUP_ADMISSION_WAIT_MS } from "../../packages/gateway-protocol/src/startup-unavailable.ts";
import { isRecord } from "../../packages/normalization-core/src/record-coerce.ts";
import { connectRestartClient } from "../../test/gateway-restart.test-support.ts";
import { createOpenClawTestInstance } from "../../test/helpers/openclaw-test-instance.ts";
import { BASE_GATEWAY_BENCH_CONFIG } from "../lib/gateway-bench-runtime.ts";
import { runManagedCommand } from "../lib/managed-child-process.mts";
import { startRestartStressProvider } from "./team-shape-restart-provider.ts";
import {
  summarizeRestartStress,
  stressAnswerMessages,
  type StressInput,
  type StressEvent,
  type RestartRecord,
  type StressSettlement,
  type SharedRateLimitProbe,
} from "./team-shape-restart-report.ts";

export async function runRestartStress(argv: string[]) {
  const { values } = parseArgs({
    args: argv,
    options: {
      "restart-chaos": { type: "boolean" },
      dry: { type: "boolean" },
      output: { type: "string" },
      candidate: { type: "string", default: process.cwd() },
      "live-model": { type: "string" },
      "key-file": { type: "string" },
      concurrency: { type: "string", default: "8" },
      minutes: { type: "string", default: "15" },
    },
  });
  const concurrency = Number(values.concurrency);
  const minutes = Number(values.minutes);
  if (
    !Number.isInteger(concurrency) ||
    concurrency < 8 ||
    concurrency > 24 ||
    !Number.isInteger(minutes) ||
    minutes < 1 ||
    minutes > 18 ||
    !values.output
  ) {
    throw new Error("Require --output (new directory), --concurrency 8..24, --minutes 1..18");
  }
  if (!values.dry && (!values["live-model"]?.startsWith("openai/") || !values["key-file"])) {
    throw new Error("Live mode requires --live-model openai/<approved-model> and --key-file");
  }
  // The work order supplies the approved model explicitly; no live-model default.
  const model = values.dry ? "stress-mock" : values["live-model"]!.slice("openai/".length);
  const keyFile = values["key-file"] ? path.resolve(values["key-file"]) : undefined;
  if (keyFile) {
    const info = await stat(keyFile);
    if (!info.isFile() || (info.mode & 0o077) !== 0) {
      throw new Error("Key file must be a private regular file (0600)");
    }
  }
  const output = path.resolve(values.output);
  const candidate = path.resolve(values.candidate);
  await stat(path.join(candidate, "dist/entry.js")).catch(() => {
    throw new Error(
      "Build the isolated candidate first; dist/entry.js is required (see team-shape-stress.md)",
    );
  });
  await mkdir(output, { mode: 0o700 });
  const revision = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: candidate,
    encoding: "utf8",
  }).trim();
  const startedAt = Date.now();
  const deadline = startedAt + minutes * 60_000;
  const inputs: StressInput[] = [];
  const events: StressEvent[] = [];
  const restarts: RestartRecord[] = [];
  const histories: Record<string, unknown> = {};
  const errors: string[] = [];
  const activity = new Map<string, number>();
  const workspace = await mkdtemp(path.join(tmpdir(), "openclaw-restart-workspaces-"));
  const entries: Record<string, unknown> = {};
  const effects: Record<string, string[]> = {};
  let settlement: StressSettlement | undefined;
  let sharedRateLimit: SharedRateLimitProbe | undefined;
  try {
    for (let i = 0; i < concurrency; i++) {
      const directory = path.join(workspace, `stress${i}`);
      await mkdir(directory);
      execFileSync("git", ["init", "--quiet", "--template=", directory], { timeout: 20_000 });
      await writeFile(path.join(directory, "input.txt"), "Synthetic coding fixture: 2 + 2 = 4.\n");
      entries[`stress${i}`] = { workspace: directory };
    }
  } catch (error) {
    await rm(workspace, { recursive: true });
    throw error;
  }
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(new Error("Campaign deadline")), minutes * 60_000);
  const interrupt = () => abort.abort(new Error("Campaign interrupted"));
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  const provider = await startRestartStressProvider({
    dry: values.dry ?? false,
    model,
    onActivity(id, at) {
      if (!activity.has(id)) {
        activity.set(id, at);
      }
    },
    onSustainedRateLimit() {
      abort.abort(new Error("Sustained upstream 429s: stopping shared-org traffic"));
    },
  });
  const fallback = `openai/${model}`;
  const primary = "openai/stress-primary";
  const modelConfig = (id: string) => ({
    id,
    name: "Isolated stress model",
    api: "openai-responses",
    agentRuntime: { id: "openclaw" },
    reasoning: false,
    input: ["text"],
    contextWindow: 128_000,
    maxTokens: 4096,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  });
  const providerConfig = () => ({
    baseUrl: provider.baseUrl,
    api: "openai-responses",
    agentRuntime: { id: "openclaw" },
    apiKey: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
    request: { allowPrivateNetwork: true },
    models: [modelConfig("stress-primary"), modelConfig(model)],
  });
  // The launcher alone reads the staged credential, then execs the owned Gateway.
  // Neither the controller nor the report has the secret in its environment/config.
  const prefix =
    keyFile && !values.dry
      ? [
          "/bin/bash",
          "-c",
          'set +x; OPENAI_API_KEY="$(cat "$1")"; export OPENAI_API_KEY; shift; exec "$@"',
          "restart-stress",
          keyFile,
          process.execPath,
        ]
      : undefined;
  let instance: Awaited<ReturnType<typeof createOpenClawTestInstance>>;
  try {
    instance = await createOpenClawTestInstance({
      name: "restart-stress",
      gatewayToken: "synthetic-restart-stress-token",
      cwd: candidate,
      entrypoint: ["dist/entry.js"],
      state: { layout: "split" },
      gatewayCommandPrefix: prefix,
      startTimeoutMs: 120_000,
      stopTimeoutMs: 95_000,
      gracefulShutdownTimeoutMs: 95_000,
      signal: abort.signal,
      env: {
        OPENAI_API_KEY: values.dry ? "synthetic-stress-key" : undefined,
        OPENAI_BASE_URL: undefined,
        OPENAI_API_BASE: undefined,
        OPENCLAW_SKIP_PROVIDERS: undefined,
        OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
        OPENCLAW_SKIP_CRON: "1",
        OPENCLAW_PROFILE: `restart-stress-${process.pid}`,
        VITEST: undefined,
      },
      config: {
        ...BASE_GATEWAY_BENCH_CONFIG,
        gateway: {
          ...BASE_GATEWAY_BENCH_CONFIG.gateway,
          auth: { mode: "token", token: "synthetic-restart-stress-token" },
        },
        cron: { enabled: false },
        plugins: {
          enabled: true,
          entries: {
            browser: { enabled: false },
            "memory-core": { config: { dreaming: { enabled: false } } },
          },
        },
        models: {
          mode: "replace",
          providers: { openai: providerConfig() },
        },
        agents: {
          ownership: "explicit",
          defaults: {
            workspace,
            model: { primary, fallbacks: [fallback] },
            utilityModel: fallback,
            modelPolicy: { allow: [primary, fallback] },
            models: Object.fromEntries(
              [primary, fallback].map((ref) => [
                ref,
                {
                  agentRuntime: { id: "openclaw" },
                  params: { transport: "sse", openaiWsWarmup: false, maxTokens: 4096 },
                },
              ]),
            ),
            maxConcurrent: concurrency,
            subagents: { maxConcurrent: concurrency * 3 },
            skipBootstrap: true,
            skills: [],
            timeoutSeconds: 180,
            thinkingDefault: "off",
          },
          entries,
        },
        tools: {
          allow: [
            "read",
            "write",
            "edit",
            "exec",
            "process",
            "sessions_spawn",
            "sessions_yield",
            "sessions_send",
          ],
          exec: { mode: "full", host: "gateway" },
          codeMode: { enabled: false },
          toolSearch: false,
        },
      },
    });
  } catch (error) {
    clearTimeout(timer);
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
    await provider.close();
    await rm(workspace, { recursive: true });
    await writeFile(path.join(output, "setup-error.txt"), String(error));
    throw error;
  }
  let client: Awaited<ReturnType<typeof connectRestartClient>> | undefined;
  const logs: string[] = [];
  const tracked = new Set<object>();
  const trackProcess = () => {
    const child = instance.child;
    if (!child || tracked.has(child)) {
      return;
    }
    tracked.add(child);
    for (const stream of [child.stdout, child.stderr]) {
      stream.on("data", (chunk) => logs.push(String(chunk)));
    }
    child.on("exit", (code, signal) =>
      events.push({
        at: Date.now(),
        event: "process.exit",
        payload: { code, signal, pid: child.pid },
      }),
    );
  };
  const connect = async () => {
    client = await connectRestartClient(
      instance,
      {
        env: instance.env,
        deviceIdentity: null,
        caps: ["tool-events"],
        onEvent(event) {
          events.push({ at: Date.now(), event: event.event, payload: event.payload });
        },
      },
      abort.signal,
      30_000,
    );
    await client.request("sessions.subscribe", {});
  };
  const history = async (key: string) => {
    const result = await client!.request<unknown>("chat.history", {
      sessionKey: key,
      limit: 200,
      inputRunIds: inputs.filter((input) => input.sessionKey === key).map((input) => input.id),
    });
    histories[key] = result;
    return isRecord(result) ? result : {};
  };
  const createSession = async (agentId: string, label: string) => {
    const result = await client!.request<unknown>(
      "sessions.create",
      { agentId, label, idempotencyKey: `restart-stress-${label}` },
      { timeoutMs: GATEWAY_STARTUP_ADMISSION_WAIT_MS },
    );
    if (!isRecord(result) || typeof result.key !== "string" || !result.key) {
      throw new Error("sessions.create returned no key");
    }
    return result.key;
  };
  const send = async (
    key: string,
    id: string,
    phase: string,
    message: string,
    queueMode?: string,
  ) => {
    const input: StressInput = { id, sessionKey: key, sentAt: Date.now(), accepted: false, phase };
    inputs.push(input);
    try {
      const ack = await client!.request<unknown>(
        "chat.send",
        {
          sessionKey: key,
          idempotencyKey: id,
          message: `INPUT_${id}\n${message}`,
          ...(queueMode ? { queueMode } : {}),
        },
        { timeoutMs: 20_000 },
      );
      input.ack = ack;
      input.accepted = true;
    } catch (error) {
      input.error = error instanceof Error ? error.message : String(error);
      input.rejected = isGatewayProtocolResponseError(error);
    }
  };
  const waitUntil = async (
    predicate: () => boolean | Promise<boolean>,
    ms: number,
    pollMs = 500,
  ) => {
    const until = Math.min(Date.now() + ms, deadline);
    while (Date.now() < until) {
      abort.signal.throwIfAborted();
      if (await predicate()) {
        return true;
      }
      await delay(pollMs, undefined, { signal: abort.signal });
    }
    return false;
  };
  const summarize = () =>
    summarizeRestartStress({
      inputs,
      events,
      restarts,
      histories,
      log: logs.join("") || instance.logs(),
      effects,
      provider: {
        ...provider.counters,
        requests: provider.requests,
        firstActivity: Object.fromEntries(activity),
      },
      errors,
      settlement,
      sharedRateLimit,
    });
  try {
    await instance.startGateway();
    trackProcess();
    await connect();
    // A completed session is the negative control: no message after any restart.
    const idle = await createSession("stress0", "idle-control");
    await send(
      idle,
      "idle-control",
      "setup",
      "Reply exactly DONE_idle-control, with no tool calls.",
    );
    const warmedUp = await waitUntil(async () => {
      const snapshot = await history(idle);
      return (
        stressAnswerMessages(snapshot, "idle-control").length > 0 &&
        isRecord(snapshot) &&
        isRecord(snapshot.sessionInfo) &&
        snapshot.sessionInfo.hasActiveRun === false
      );
    }, 60_000);
    if (!warmedUp) {
      throw new Error(
        "Warmup did not complete an assistant turn and become idle; chaos was not started",
      );
    }
    for (const [leg, kind] of ["managed", "sigterm", "sigkill"].entries()) {
      abort.signal.throwIfAborted();
      console.log(`LEG ${kind}: ${concurrency} concurrent sessions`);
      // The Control UI publishes a created row before sends and read-marker patches.
      const keys = await Promise.all(
        Array.from({ length: concurrency }, (_, i) => createSession(`stress${i}`, `${kind}-${i}`)),
      );
      const sending = Promise.all(
        keys.map(async (key, i) => {
          const id = `${kind}-${i}`;
          const effect = path.join(workspace, `stress${i}`, `${id}.effects`);
          const scenario =
            i % 4 === 1
              ? "Read input.txt, then ask two independent helpers to check the calculation. Give each helper the calculation and all context it needs in its task so it can answer without creating a checkout or modifying files. Wait for both results and summarize whether they agree."
              : i % 4 === 2
                ? "Start a background exec (sleep 30), then keep working by reading input.txt and writing result.txt. Check the background process before finishing."
                : "Use read to inspect input.txt, edit to add an explanation, write result.txt containing the computed result, and exec to verify it.";
          await send(
            key,
            id,
            kind,
            `${scenario}\nUse only this throwaway workspace. Never inspect environment or credentials.\nEFFECT_PATH=${effect}\nAppend EFFECT_${id} to that file once (inspect it before resuming after interruption). Then run exec sleep 25 while you continue working; wait for it to finish before your final answer. Finish with exactly DONE_${id} alone on the final line of your final answer. Preserve this completion marker across steering and recovery.`,
          );
        }),
      );
      // Metadata writes contend with admitted work through the real RPC owner.
      const churn = Promise.all(
        keys.map(async (key, i) => {
          for (let round = 0; round < 3; round++) {
            try {
              await client!.request("sessions.patch", {
                key,
                label: `stress-${leg}-${i}-${round}`,
                unread: false,
              });
            } catch (error) {
              errors.push(`churn ${key}: ${String(error)}`);
            }
          }
        }),
      );
      await sending;
      await waitUntil(
        () =>
          keys.filter((_, i) => activity.has(`${kind}-${i}`)).length >= Math.min(4, concurrency),
        60_000,
      );
      await send(
        keys[0]!,
        `${kind}-steer`,
        `${kind}-steer`,
        `Continue your current work; also include DONE_${kind}-steer in your final answer.`,
        "steer",
      );
      await send(
        keys[1]!,
        `${kind}-queued`,
        `${kind}-queued`,
        `Reply DONE_${kind}-queued after completing the existing task.`,
        "followup",
      );
      await churn;
      const active: string[] = [];
      for (const key of keys) {
        const h = await history(key);
        const info = isRecord(h.sessionInfo) ? h.sessionInfo : {};
        if (info.hasActiveRun === true) {
          active.push(key);
        }
      }
      const record: RestartRecord = { kind, at: Date.now(), active, idle: [idle] };
      restarts.push(record);
      const child = instance.child;
      if (!child?.pid || child.exitCode !== null || child.signalCode !== null) {
        throw new Error("Owned Gateway missing before chaos injection");
      }
      // Pipe closure can wait on descendants; bounded fixture cleanup owns those.
      const exited = once(child, "exit").then(([code, signal]) => ({
        code,
        signal,
        at: Date.now(),
      }));
      if (kind === "managed") {
        // Cross-revision replay must use the candidate's own state/schema owner.
        const writer = pathToFileURL(path.join(candidate, "src/infra/restart-intent.ts")).href;
        const code = await runManagedCommand({
          bin: process.execPath,
          args: [
            "--import",
            "./scripts/tsx.mjs",
            "--input-type=module",
            "--eval",
            `const { writeGatewayRestartIntentSync } = await import(${JSON.stringify(writer)});
             if (!writeGatewayRestartIntentSync({ targetPid: ${child.pid},
               intent: { reason: "gateway.restart", force: true, waitMs: 100 } })) process.exitCode = 1;`,
          ],
          cwd: candidate,
          env: instance.env,
          signal: abort.signal,
          timeoutMs: 120_000,
        });
        if (code !== 0) {
          throw new Error(`Managed restart intent refused (exit ${code})`);
        }
      }
      record.at = Date.now();
      child.kill(kind === "sigkill" ? "SIGKILL" : "SIGTERM");
      // This send is intentionally not retried: an uncertain acknowledgment remains evidence.
      await send(
        keys[0]!,
        `${kind}-draining`,
        `${kind}-draining`,
        `Reply DONE_${kind}-draining.`,
        "followup",
      );
      const { code, signal, at: exitedAt } = await exited;
      record.exitCode = typeof code === "number" ? code : null;
      record.signal = typeof signal === "string" ? signal : null;
      record.shutdownMs = exitedAt - record.at;
      await instance.stopGateway();
      await client?.stopAndWait();
      client = undefined;
      await instance.startGateway();
      trackProcess();
      await connect();
      record.returnedAt = Date.now();
      await send(
        keys[0]!,
        `${kind}-returned`,
        `${kind}-returned`,
        `Reply DONE_${kind}-returned.`,
        "followup",
      );
      // Recovery cohort (keys 2+) receives no message after boot.
      await waitUntil(
        async () => {
          let settled = true;
          for (const key of [...keys, idle]) {
            const h = await history(key);
            const info = isRecord(h.sessionInfo) ? h.sessionInfo : {};
            if (info.hasActiveRun === true) {
              settled = false;
            }
          }
          return settled;
        },
        values.dry ? 30_000 : 150_000,
      );
    }
    console.log("LEG rate-limit: primary 429 window, real fallback configured");
    const rateKeys = await Promise.all(
      Array.from({ length: concurrency }, (_, i) => createSession(`stress${i}`, `rate-${i}`)),
    );
    const rateStartedAt = Date.now();
    const resetAt = provider.rejectFor(30_000);
    const rateSends = Promise.all(
      Array.from({ length: concurrency }, (_, i) =>
        send(rateKeys[i]!, `rate-${i}`, "rate-limit", `Reply exactly DONE_rate-${i}. No tools.`),
      ),
    );
    await waitUntil(
      () =>
        provider.requests.some(
          (request) => request.at >= rateStartedAt && request.primary && request.status === 429,
        ),
      60_000,
    );
    const first429 = provider.requests.find(
      (request) => request.at >= rateStartedAt && request.primary && request.status === 429,
    );
    if (first429) {
      sharedRateLimit = { first429At: first429.at, resetAt };
      const newcomer = await createSession("stress0", "rate-newcomer");
      sharedRateLimit.newcomerCreatedAt = Date.now();
      await send(
        newcomer,
        "rate-newcomer",
        "rate-newcomer",
        "Reply exactly DONE_rate-newcomer. No tools.",
      );
    }
    await rateSends;
    console.log("SETTLE: observe every accepted input for up to ten minutes");
    settlement = {
      startedAt: Date.now(),
      deadline: Math.min(Date.now() + 600_000, deadline),
      timedOut: false,
    };
    const settled = await waitUntil(
      async () => {
        for (const key of new Set(inputs.map((input) => input.sessionKey))) {
          await history(key);
        }
        return summarize().report.inputs.every(
          (input) =>
            !input.accepted ||
            input.outcome === "lost-on-crash" ||
            (input.outcome !== "unresolved" &&
              input.pending.length === 0 &&
              (!isRecord(input.sessionInfo) || input.sessionInfo.hasActiveRun !== true)),
        );
      },
      600_000,
      5000,
    );
    settlement.finishedAt = Date.now();
    settlement.timedOut = !settled;
    if (!settled) {
      console.log("SETTLE deadline: unresolved accepted inputs are explicitly timed out");
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  } finally {
    if (settlement && settlement.finishedAt === undefined) {
      settlement.finishedAt = Date.now();
      settlement.timedOut = settlement.finishedAt >= settlement.deadline;
    }
    clearTimeout(timer);
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
    await client
      ?.stopAndWait()
      .catch((error: unknown) => errors.push(`client cleanup: ${String(error)}`));
    const child = instance.child;
    const cleanupAt = Date.now();
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      await exited;
    }
    const shutdownMs = Date.now() - cleanupAt;
    await instance
      .stopGateway()
      .catch((error: unknown) => errors.push(`Gateway cleanup: ${String(error)}`));
    if (child) {
      restarts.push({
        kind: "final-stop",
        at: cleanupAt,
        active: [],
        idle: [],
        exitCode: child.exitCode,
        signal: child.signalCode,
        shutdownMs,
      });
    }
    await provider.close();
    // Retain requested synthetic transcripts/config/logs before the fixture removes its root.
    await cp(instance.state.root, path.join(output, "isolated-state"), { recursive: true });
    await instance
      .cleanup()
      .catch((error: unknown) => errors.push(`fixture cleanup: ${String(error)}`));
    for (const input of inputs) {
      const agent = input.sessionKey.split(":")[1] ?? "";
      const file = path.join(workspace, agent, `${input.id}.effects`);
      effects[input.id] = await readFile(file, "utf8").then(
        (text) => text.split("\n").filter(Boolean),
        () => [],
      );
    }
    await cp(workspace, path.join(output, "workspaces"), { recursive: true });
    await rm(workspace, { recursive: true });
    const log = logs.join("") || instance.logs();
    await writeFile(path.join(output, "gateway.log"), log, { mode: 0o600 });
    const { report, markdown } = summarize();
    await writeFile(
      path.join(output, "report.json"),
      JSON.stringify(
        {
          revision,
          startedAt,
          finishedAt: Date.now(),
          dry: values.dry ?? false,
          concurrency,
          ...report,
          raw: { inputs, events, restarts, histories, effects, provider: provider.requests },
        },
        null,
        2,
      ),
    );
    await writeFile(
      path.join(output, "summary.md"),
      `Baseline: ${revision}\nMode: ${values.dry ? "mock" : "live"}\n\n${markdown}`,
    );
    await appendFile(
      path.join(output, "summary.md"),
      `\nArtifacts: report.json, gateway.log, isolated-state/, workspaces/.\n`,
    );
    console.log(`REPORT ${path.join(output, "report.json")}`);
    console.log(markdown);
    if (errors.length || report.invariants.some((invariant) => invariant.status === "fail")) {
      process.exitCode = 1;
    }
  }
}
