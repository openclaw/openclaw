import { execFile, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { extractErrorCode } from "openclaw/plugin-sdk/error-runtime";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createQaGatewayChild } from "./gateway-child.js";
import { buildFailedResponseEvents } from "./providers/mock-openai/mock-openai-events.js";
import { attachQaMockResponsesWebSocketServer } from "./providers/mock-openai/mock-openai-responses-websocket.js";
import { MockResponseStream } from "./providers/mock-openai/mock-openai-stream.js";
import { listMockCodexModelInfos } from "./providers/shared/mock-model-config.js";

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const PLUGIN_ID = "qa-native-hook-pressure";
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const startedAt = performance.now();

function reportPhase(phase: string, selection?: string) {
  // Console is silent in E2E runs; emit only completed boundaries, never timer heartbeats.
  process.stderr.write(
    "NATIVE_HOOK_PHASE " +
      JSON.stringify({ phase, selection, elapsedMs: Math.round(performance.now() - startedAt) }) +
      "\n",
  );
}

type Tool = {
  type?: string;
  name?: string;
  tools?: Tool[];
  parameters?: { properties?: Record<string, unknown> };
};
type Scenario = {
  id: string;
  count: number;
  mode: "allow" | "deny";
  failedResponses: number;
  unacknowledgedRetries: number;
  outputs: unknown[];
};
type ProcessIdentity = { pid: number; startTimeTicks: number };
type ProcessRow = ProcessIdentity & {
  state: string;
  comm: string;
  argv: string[];
  rss: number;
  ticks: number;
};

const processKey = (row: ProcessIdentity) => `${row.pid}:${row.startTimeTicks}`;
const isRelay = (row: ProcessRow) =>
  row.comm === "openclaw-hooks" ||
  row.argv.some((arg) => arg.endsWith("/native-hook-relay/entry.js"));

async function readProcess(pid: number): Promise<ProcessRow | undefined> {
  try {
    const [stat, status, cmdline] = await Promise.all([
      fs.readFile(`/proc/${pid}/stat`, "utf8"),
      fs.readFile(`/proc/${pid}/status`, "utf8"),
      fs.readFile(`/proc/${pid}/cmdline`, "utf8"),
    ]);
    const end = stat.lastIndexOf(")");
    const fields = stat.slice(end + 2).split(" ");
    return {
      pid,
      startTimeTicks: Number(fields[19]),
      state: fields[0]!,
      comm: stat.slice(stat.indexOf("(") + 1, end),
      argv: cmdline.split("\0"),
      rss: Number(/VmRSS:\s+(\d+)/.exec(status)?.[1] ?? 0) * 1024,
      ticks: Number(fields[11]) + Number(fields[12]),
    };
  } catch (error) {
    const code = extractErrorCode(error);
    if (code !== "ENOENT" && code !== "ESRCH") {
      throw error;
    }
    return undefined;
  }
}

async function processTree(root: number): Promise<ProcessRow[]> {
  const rows: ProcessRow[] = [];
  const pending = [root];
  const seen = new Set<number>();
  while (pending.length) {
    const pid = pending.pop()!;
    if (seen.has(pid)) {
      continue;
    }
    seen.add(pid);
    const row = await readProcess(pid);
    if (!row) {
      continue;
    }
    rows.push(row);
    try {
      // Rust can spawn from any executor thread, not only the process leader.
      for (const tid of await fs.readdir(`/proc/${pid}/task`)) {
        const children = await fs
          .readFile(`/proc/${pid}/task/${tid}/children`, "utf8")
          .catch((error: unknown) => {
            const code = extractErrorCode(error);
            if (code === "ENOENT" || code === "ESRCH") {
              return "";
            }
            throw error;
          });
        pending.push(...children.trim().split(/\s+/).filter(Boolean).map(Number));
      }
    } catch (error) {
      const code = extractErrorCode(error);
      if (code !== "ENOENT" && code !== "ESRCH") {
        throw error;
      }
    }
  }
  return rows;
}

async function inspectOwnedRelays(root: number, observed: Map<string, ProcessIdentity>) {
  // Keep observed identities after reparenting; also discover any remaining descendants.
  for (const row of await processTree(root)) {
    if (isRelay(row)) {
      observed.set(processKey(row), { pid: row.pid, startTimeTicks: row.startTimeTicks });
    }
  }
  const live: ProcessIdentity[] = [];
  const zombies: ProcessIdentity[] = [];
  for (const identity of observed.values()) {
    const row = await readProcess(identity.pid);
    if (!row || row.startTimeTicks !== identity.startTimeTicks) {
      continue;
    }
    (row.state === "Z" ? zombies : live).push(identity);
  }
  return { live, zombies };
}

function toolsIn(body: Record<string, unknown>): Array<{ tool: Tool; namespace?: string }> {
  const entries: Array<{ tool: Tool; namespace?: string }> = [];
  for (const tool of (Array.isArray(body.tools) ? body.tools : []) as Tool[]) {
    if (tool.type === "namespace") {
      for (const child of tool.tools ?? []) {
        entries.push({ tool: child, namespace: tool.name });
      }
    } else {
      entries.push({ tool });
    }
  }
  return entries;
}

describe.skipIf(process.platform !== "linux")(
  "Codex native-hook pressure real Gateway proof",
  () => {
    let sandboxSkipReason: string | undefined;
    beforeAll(async () => {
      reportPhase("sandbox-probe-start");
      try {
        const cwd = tempDirs.make("openclaw-codex-sandbox-probe-");
        const codexHome = path.join(cwd, "codex-home");
        await fs.mkdir(codexHome);
        const require = createRequire(path.join(REPO_ROOT, "extensions/codex/package.json"));
        const launcher = require.resolve("@openai/codex/bin/codex.js");
        // Exercise Codex's workspace-write sandbox, including Bubblewrap's loopback setup.
        const result = spawnSync(
          process.execPath,
          [
            launcher,
            "sandbox",
            "-c",
            'sandbox_mode="workspace-write"',
            "-c",
            "sandbox_workspace_write.network_access=false",
            "--",
            "true",
          ],
          {
            cwd,
            env: { ...process.env, CODEX_HOME: codexHome },
            stdio: ["ignore", "pipe", "pipe"],
            encoding: "utf8",
            timeout: 20_000,
            killSignal: "SIGKILL",
          },
        );
        if (result.error || result.status === null || result.status === 0) {
          return;
        }
        // Mirror Codex's own USER_NAMESPACE_FAILURES (codex-rs/sandboxing/src/bwrap.rs);
        // other namespace errors such as ENOSPC exhaustion must still fail the suite.
        const denial = `${result.stdout}\n${result.stderr}`
          .split(/\r?\n/)
          .find((line) =>
            /^bwrap: (?:loopback: Failed RTM_NEW(?:ADDR|LINK)|setting up uid map: Permission denied|No permissions to create a new namespace)\b/.test(
              line,
            ),
          );
        if (denial) {
          sandboxSkipReason = `Codex Bubblewrap sandbox cannot configure an unprivileged network namespace on this host (${denial})`;
        }
      } catch {
        // Unknown probe failures must leave the real Gateway test enabled.
      } finally {
        reportPhase(sandboxSkipReason ? "sandbox-probe-denied" : "sandbox-probe-complete");
      }
    });

    it.for(["matched", "unmatched", "none"] as const)(
      "records %s policy work through the real Gateway",
      { timeout: 480_000 },
      async (selection, context) => {
        if (sandboxSkipReason) {
          context.skip(sandboxSkipReason);
        }
        expect(process.platform).toBe("linux");
        reportPhase("fixture-start", selection);
        const root = tempDirs.make("openclaw-native-hook-pressure-");
        const pluginDir = path.join(root, "plugin");
        await fs.mkdir(pluginDir);
        await fs.writeFile(
          path.join(pluginDir, "openclaw.plugin.json"),
          JSON.stringify({
            id: PLUGIN_ID,
            activation: { onStartup: true },
            configSchema: { type: "object", additionalProperties: false, properties: {} },
          }),
        );
        await fs.writeFile(
          path.join(pluginDir, "index.js"),
          `
import { hasBeforeToolCallPolicy, nativeHookRelayTesting } from "openclaw/plugin-sdk/agent-harness-runtime";
// Plugin generation modules have distinct instances; the fixture observer is process-owned.
const key = Symbol.for("openclaw.test.native-hook-pressure.${randomUUID()}");
const calls = globalThis[key] ??= [];
export default {
  id: "${PLUGIN_ID}",
  register(api) {
    if ("${selection}" !== "none") api.on("before_tool_call", async (event) => {
      const serialized = JSON.stringify(event.params);
      calls.push({ toolName: event.toolName, denied: serialized.includes("PRESSURE_DENIED") });
      await new Promise((resolve) => setTimeout(resolve, 75));
      return serialized.includes("PRESSURE_DENIED")
        ? { block: true, blockReason: "PRESSURE_POLICY_DENIED" }
        : undefined;
    }, { matcher: ["${selection === "unmatched" ? "web_fetch" : "exec"}"] });
    api.registerHttpRoute({
      path: "/qa/native-hook-pressure", auth: "gateway", match: "exact",
      gatewayRuntimeScopeSurface: "trusted-operator",
      async handler(_req, res) { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ calls, pid: process.pid, nodeVersion: process.version, hasPolicy: hasBeforeToolCallPolicy(), invocations: nativeHookRelayTesting.getNativeHookRelayInvocationsForTests() })); return true; }
    });
  }
};`,
        );
        let scenario: Scenario | undefined;
        const wireTools = new Map<string, Tool>();
        const dispatch = async ({ body }: { body: Record<string, unknown> }) => {
          if (!scenario) {
            throw new Error("provider request outside scenario");
          }
          const current = scenario;
          const stream = new MockResponseStream(`resp_${current.id}_${randomUUID()}`);
          const tools = toolsIn(body);
          for (const { tool } of tools) {
            wireTools.set(tool.name ?? "unknown", tool);
          }
          const input = Array.isArray(body.input) ? body.input : [];
          current.outputs.push(
            ...input.filter(
              (item) => item && typeof item === "object" && String(item.type).endsWith("_output"),
            ),
          );
          if (current.failedResponses > 0 && current.outputs.length === 0) {
            current.unacknowledgedRetries++;
          }
          const acknowledged = new Set(
            current.outputs.flatMap((item) =>
              item &&
              typeof item === "object" &&
              "type" in item &&
              item.type === "function_call_output" &&
              "call_id" in item &&
              typeof item.call_id === "string"
                ? [item.call_id]
                : [],
            ),
          );
          const pending = Array.from({ length: current.count }, (_, i) => i).filter(
            (i) => !acknowledged.has(`call_${current.id}_${i}`),
          );
          // Retry only missing calls; constructing or sending a response does not prove execution.
          if (pending.length > 0) {
            const native = tools.find(({ tool }) =>
              ["exec_command", "shell_command", "shell"].includes(tool.name ?? ""),
            );
            if (!native) {
              throw new Error(
                `native shell tool unavailable: ${JSON.stringify(tools.map(({ tool }) => ({ name: tool.name, type: tool.type })))}`,
              );
            }
            const properties = native.tool.parameters?.properties ?? {};
            for (const i of pending) {
              const command =
                current.mode === "deny"
                  ? "printf PRESSURE_DENIED > pressure-denied.txt"
                  : `printf PRESSURE_ALLOW_${current.id}_${i}_END; printf PRESSURE_ALLOW_${current.id}_${i}_END > pressure-${current.id}-${i}.txt`;
              // Codex omits login when the host already enforces non-login shells.
              const args = {
                ...(Object.hasOwn(properties, "cmd")
                  ? { cmd: command }
                  : { command: native.tool.name === "shell" ? ["sh", "-c", command] : command }),
                ...(Object.hasOwn(properties, "login") ? { login: false } : {}),
              };
              stream.tool({
                type: "function_call",
                id: `fc_${current.id}_${i}`,
                call_id: `call_${current.id}_${i}`,
                name: native.tool.name!,
                ...(native.namespace ? { namespace: native.namespace } : {}),
                arguments: JSON.stringify(args),
              });
            }
          } else {
            stream.message({ id: `msg_${current.id}`, text: `PRESSURE_DONE_${current.id}` });
          }
          let events = stream.complete(16);
          if (selection === "matched" && current.count === 20 && current.failedResponses === 0) {
            // Drop the entire tool response before delivery; issuing it is not an acknowledgment.
            current.failedResponses++;
            events = buildFailedResponseEvents();
          }
          return {
            events,
            model: typeof body.model === "string" ? body.model : "",
          };
        };
        const server = createServer((req, res) => {
          const handle = async () => {
            if (req.method === "GET" && req.url?.startsWith("/v1/models")) {
              res.setHeader("Content-Type", "application/json");
              res.end(
                JSON.stringify({
                  data: [{ id: "gpt-5.6-luna", object: "model" }],
                  models: listMockCodexModelInfos(),
                }),
              );
              return;
            }
            if (req.method !== "POST" || req.url !== "/v1/responses") {
              res.writeHead(404).end();
              return;
            }
            const chunks: Buffer[] = [];
            for await (const chunk of req) {
              chunks.push(Buffer.from(chunk));
            }
            const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
            const { events } = await dispatch({ body });
            res.writeHead(200, { "Content-Type": "text/event-stream" });
            res.end(
              events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") +
                "data: [DONE]\n\n",
            );
          };
          void handle().catch((error: unknown) => {
            res
              .writeHead(500, { "Content-Type": "application/json" })
              .end(JSON.stringify({ error: String(error) }));
          });
        });
        const sockets = attachQaMockResponsesWebSocketServer({ server, dispatch });
        await once(server.listen(0, "127.0.0.1"), "listening");
        const address = server.address();
        if (!address || typeof address === "string") {
          throw new Error("mock provider failed to bind");
        }
        const owner = createQaGatewayChild();
        const reports: unknown[] = [];
        const observedRelays = new Map<string, ProcessIdentity>();
        let gatewayPid: number | undefined;
        try {
          reportPhase("gateway-start", selection);
          const gateway = await owner.start({
            repoRoot: REPO_ROOT,
            command: {
              executablePath: process.execPath,
              argsPrefix: [path.join(REPO_ROOT, "dist/index.js")],
              cwd: REPO_ROOT,
              usePackagedPlugins: true,
            },
            providerBaseUrl: `http://127.0.0.1:${address.port}/v1`,
            transportBaseUrl: "",
            providerMode: "mock-openai",
            primaryModel: "mock-openai/gpt-5.6-luna",
            alternateModel: "mock-openai/gpt-5.6-luna-alt",
            forcedRuntime: "codex",
            controlUiEnabled: false,
            mutateConfig: (config) => ({
              ...config,
              plugins: {
                ...config.plugins,
                allow: [...(config.plugins?.allow ?? []), PLUGIN_ID],
                load: { paths: [pluginDir] },
                entries: {
                  ...config.plugins?.entries,
                  codex: {
                    enabled: true,
                    config: {
                      appServer: {
                        // Keep the QA sandbox; isolate policy work from optional loop detection.
                        sandbox: "workspace-write",
                        loopDetectionPreToolUseRelay: false,
                      },
                    },
                  },
                  [PLUGIN_ID]: { enabled: true },
                },
              },
            }),
          });
          reportPhase("gateway-ready", selection);
          if (!gateway.pid) {
            throw new Error("Gateway has no PID");
          }
          gatewayPid = gateway.pid;
          const readCalls = async () =>
            (
              (await (
                await fetch(`${gateway.baseUrl}/qa/native-hook-pressure`, {
                  headers: { Authorization: `Bearer ${gateway.token}` },
                })
              ).json()) as { calls: Array<{ denied: boolean }> }
            ).calls;
          const registry = (await (
            await fetch(`${gateway.baseUrl}/qa/native-hook-pressure`, {
              headers: { Authorization: `Bearer ${gateway.token}` },
            })
          ).json()) as { hasPolicy: boolean; pid: number; nodeVersion: string };
          expect(registry.hasPolicy).toBe(selection !== "none");
          expect(registry.pid).toBe(gateway.pid);
          const cpuTickRate = Number((await execFileAsync("getconf", ["CLK_TCK"])).stdout.trim());
          expect(cpuTickRate).toBeGreaterThan(0);
          const status = await fs.readFile(`/proc/${gateway.pid}/status`, "utf8");
          reportPhase("hardware-ready", selection);
          console.log(
            "NATIVE_HOOK_HARDWARE " +
              JSON.stringify({
                node: registry.nodeVersion,
                kernel: os.release(),
                cpuModel: os.cpus()[0]?.model,
                logicalCpus: os.cpus().length,
                availableParallelism: os.availableParallelism(),
                affinity: /Cpus_allowed_list:\s*(.+)/.exec(status)?.[1],
                cpuTickRate,
                compileCacheConfigured: Boolean(process.env.NODE_COMPILE_CACHE),
                compileCacheDisabled: process.env.NODE_DISABLE_COMPILE_CACHE === "1",
              }),
          );
          for (const count of selection === "matched" ? [1, 5, 20, 1] : [5]) {
            const mode = selection === "matched" && reports.length === 3 ? "deny" : "allow";
            reportPhase(`wave-${count}-${mode}-start`, selection);
            scenario = {
              id: randomUUID(),
              count,
              mode,
              outputs: [],
              failedResponses: 0,
              unacknowledgedRetries: 0,
            };
            const callsBefore = (await readCalls()).length;
            const monitoring = new AbortController();
            let peakRelays = 0;
            let peakRelayRss = 0;
            let peakTreeRss = 0;
            const relayIdentities = new Set<string>();
            const relaySamples = new Map<
              string,
              {
                firstAtMs: number;
                lastAtMs: number;
                peakRss: number;
                firstTicks: number;
                lastTicks: number;
              }
            >();
            let gatewayFirstTicks: number | undefined;
            let gatewayLastTicks: number | undefined;
            const healthMs: number[] = [];
            const healthErrors: string[] = [];
            const processSampler = (async () => {
              while (!monitoring.signal.aborted) {
                const tree = await processTree(gateway.pid!);
                const relays = tree.filter(isRelay);
                const sampledAtMs = performance.now();
                const gatewayRow = tree.find((row) => row.pid === gateway.pid);
                gatewayFirstTicks ??= gatewayRow?.ticks;
                gatewayLastTicks = gatewayRow?.ticks ?? gatewayLastTicks;
                for (const relay of relays) {
                  const key = processKey(relay);
                  observedRelays.set(key, { pid: relay.pid, startTimeTicks: relay.startTimeTicks });
                  relayIdentities.add(key);
                  const previous = relaySamples.get(key);
                  relaySamples.set(key, {
                    firstAtMs: previous?.firstAtMs ?? sampledAtMs,
                    lastAtMs: sampledAtMs,
                    peakRss: Math.max(previous?.peakRss ?? 0, relay.rss),
                    firstTicks: previous?.firstTicks ?? relay.ticks,
                    lastTicks: relay.ticks,
                  });
                }
                peakRelays = Math.max(peakRelays, relays.filter((row) => row.state !== "Z").length);
                peakRelayRss = Math.max(
                  peakRelayRss,
                  relays.filter((row) => row.state !== "Z").reduce((sum, row) => sum + row.rss, 0),
                );
                peakTreeRss = Math.max(
                  peakTreeRss,
                  tree.filter((row) => row.state !== "Z").reduce((sum, row) => sum + row.rss, 0),
                );
                await sleep(20);
              }
            })();
            const healthSampler = (async () => {
              while (!monitoring.signal.aborted) {
                const started = performance.now();
                try {
                  await gateway.call("health", {}, { timeoutMs: 5_000 });
                  healthMs.push(performance.now() - started);
                } catch (error) {
                  healthErrors.push(String(error));
                }
                await sleep(25);
              }
            })();
            // Observe both failures immediately and join both samplers before retiring the Gateway.
            const observers = Promise.allSettled([processSampler, healthSampler]);
            const failures: unknown[] = [];
            const started = performance.now();
            let turnElapsedMs = 0;
            try {
              const turn = (await gateway.call("chat.send", {
                sessionKey: `agent:qa:pressure-${scenario.id}`,
                message: "Run the bounded native shell pressure fixture.",
                deliver: false,
                idempotencyKey: randomUUID(),
              })) as { runId: string; status: string };
              expect(turn.status).toBe("started");
              const terminal = (await gateway.call(
                "agent.wait",
                { runId: turn.runId, timeoutMs: 90_000 },
                { timeoutMs: 95_000 },
              )) as { status: string };
              turnElapsedMs = Math.round(performance.now() - started);
              expect(terminal.status, gateway.logs()).toBe("ok");
            } catch (error) {
              failures.push(error);
            } finally {
              monitoring.abort();
              for (const result of await observers) {
                if (result.status === "rejected") {
                  failures.push(result.reason);
                }
              }
            }
            if (failures.length > 0) {
              throw new AggregateError(failures, "native hook pressure scenario failed");
            }
            const calls = (await readCalls()).slice(callsBefore);
            const expectedCalls = selection === "matched" ? count : 0;
            if (calls.length !== expectedCalls) {
              console.log(
                "NATIVE_HOOK_PRESSURE_FAILURE " +
                  JSON.stringify({
                    scenario,
                    tools: [...wireTools.values()].map(({ name, type }) => ({ name, type })),
                    peakRelays,
                    registry: await (
                      await fetch(`${gateway.baseUrl}/qa/native-hook-pressure`, {
                        headers: { Authorization: `Bearer ${gateway.token}` },
                      })
                    ).json(),
                    logs: gateway.logs(),
                  }),
              );
            }
            expect(calls).toHaveLength(expectedCalls);
            if (selection === "matched" && count === 20) {
              expect(scenario.failedResponses).toBe(1);
              expect(scenario.unacknowledgedRetries).toBeGreaterThan(0);
            }
            expect(healthErrors).toEqual([]);
            if (selection !== "matched") {
              expect(peakRelays).toBe(0);
            }
            expect(calls.every((call) => call.denied === (mode === "deny"))).toBe(true);
            if (mode === "deny") {
              await expect(
                fs.access(path.join(gateway.workspaceDir, "pressure-denied.txt")),
              ).rejects.toMatchObject({ code: "ENOENT" });
              expect(JSON.stringify(scenario.outputs)).toContain("PRESSURE_POLICY_DENIED");
            } else {
              for (let i = 0; i < count; i++) {
                const output = scenario.outputs.find(
                  (value) =>
                    value !== null &&
                    typeof value === "object" &&
                    "call_id" in value &&
                    value.call_id === `call_${scenario!.id}_${i}`,
                );
                expect(output).toBeDefined();
                const marker = `PRESSURE_ALLOW_${scenario.id}_${i}_END`;
                console.log(
                  "NATIVE_HOOK_TOOL_RESULT " +
                    JSON.stringify({ output, workspaceDir: gateway.workspaceDir }),
                );
                try {
                  expect(output).toMatchObject({
                    output: expect.stringContaining("\nProcess exited with code 0\n"),
                  });
                  expect(JSON.stringify(output)).toContain(marker);
                  const content = await fs.readFile(
                    path.join(gateway.workspaceDir, `pressure-${scenario.id}-${i}.txt`),
                    "utf8",
                  );
                  expect(content).toBe(marker);
                } catch (error) {
                  console.log(
                    "NATIVE_HOOK_PRESSURE_FAILURE " +
                      JSON.stringify({
                        output,
                        workspaceDir: gateway.workspaceDir,
                        gatewayLogs: gateway.logs(),
                      }),
                  );
                  throw error;
                }
              }
            }
            const binaryIdentities: Array<ProcessIdentity & { sha256: string; version: string }> =
              [];
            for (const row of await processTree(gateway.pid)) {
              if (row.state === "Z" || !row.argv.includes("app-server")) {
                continue;
              }
              const executable = `/proc/${row.pid}/exe`;
              if (path.basename(await fs.readlink(executable)) !== "codex") {
                continue;
              }
              const sha256 = createHash("sha256")
                .update(await fs.readFile(executable))
                .digest("hex");
              const version = (
                await execFileAsync(executable, ["--version"], { timeout: 10_000 })
              ).stdout.trim();
              const current = await readProcess(row.pid);
              expect(current?.startTimeTicks).toBe(row.startTimeTicks);
              expect(version).toBe("codex-cli 0.160.0");
              binaryIdentities.push({
                pid: row.pid,
                startTimeTicks: row.startTimeTicks,
                sha256,
                version,
              });
            }
            expect(binaryIdentities.length).toBeGreaterThan(0);
            await expect
              .poll(() => inspectOwnedRelays(gateway.pid!, observedRelays), {
                timeout: 3_000,
                interval: 25,
              })
              .toEqual({ live: [], zombies: [] });
            healthMs.sort((a, b) => a - b);
            reports.push({
              selection,
              count,
              mode,
              binaries: binaryIdentities,
              syntheticPolicyDelayMs: 75,
              injectedResponseFailures: scenario.failedResponses,
              sampling:
                "Non-atomic /proc snapshots; RSS can count shared pages; CPU omits work outside samples; elapsed windows are observation intervals, not process lifetimes.",
              // /proc sampling misses short-lived children and shares pages between RSS values.
              sampledRelayWindows: [...relaySamples.values()].map((sample) => ({
                observedWindowMs: sample.lastAtMs - sample.firstAtMs,
                peakRss: sample.peakRss,
                observedCpuMs: ((sample.lastTicks - sample.firstTicks) * 1000) / cpuTickRate,
              })),
              observedGatewayCpuMs:
                gatewayFirstTicks === undefined || gatewayLastTicks === undefined
                  ? undefined
                  : ((gatewayLastTicks - gatewayFirstTicks) * 1000) / cpuTickRate,
              turnElapsedMs,
              policyCalls: calls.length,
              uniqueSampledRelayProcesses: relayIdentities.size,
              peakRelays,
              peakRelayRss,
              peakTreeRss,
              healthSamples: healthMs.length,
              healthErrors,
              healthMedianMs: healthMs[Math.floor(healthMs.length / 2)],
              healthP95Ms: healthMs[Math.floor(healthMs.length * 0.95)],
              healthMaxMs: healthMs.at(-1),
              remainingObservedOrDescendantRelays: { live: 0, zombies: 0 },
            });
            console.log("NATIVE_HOOK_PRESSURE " + JSON.stringify(reports.at(-1)));
            reportPhase(`wave-${count}-${mode}-complete`, selection);
          }
        } finally {
          reportPhase("cleanup-start", selection);
          const stopped = await owner.stop();
          reportPhase("gateway-stopped", selection);
          await sockets.close();
          await new Promise<void>((resolve, reject) => {
            server.close((error) => (error ? reject(error) : resolve()));
          });
          if (gatewayPid) {
            await expect
              .poll(() => inspectOwnedRelays(gatewayPid!, observedRelays), {
                timeout: 3_000,
                interval: 25,
              })
              .toEqual({ live: [], zombies: [] });
            console.log("NATIVE_HOOK_CLEANUP " + JSON.stringify({ live: [], zombies: [] }));
          }
          expect(stopped.errors).toEqual([]);
          reportPhase("cleanup-complete", selection);
        }
      },
    );
  },
);
