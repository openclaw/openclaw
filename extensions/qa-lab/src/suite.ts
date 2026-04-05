import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import type { QaBusState } from "./bus-state.js";
import { extractQaToolPayload } from "./extract-tool-payload.js";
import { startQaGatewayChild } from "./gateway-child.js";
import { startQaLabServer } from "./lab-server.js";
import { startQaMockOpenAiServer } from "./mock-openai-server.js";
import { renderQaMarkdownReport, type QaReportCheck, type QaReportScenario } from "./report.js";
import { qaChannelPlugin, type QaBusMessage } from "./runtime-api.js";
import { readQaBootstrapScenarioCatalog } from "./scenario-catalog.js";

type QaSuiteStep = {
  name: string;
  run: () => Promise<string | void>;
};

type QaSuiteScenarioResult = {
  name: string;
  status: "pass" | "fail";
  steps: QaReportCheck[];
  details?: string;
};

type QaSuiteEnvironment = {
  lab: Awaited<ReturnType<typeof startQaLabServer>>;
  mock: Awaited<ReturnType<typeof startQaMockOpenAiServer>>;
  gateway: Awaited<ReturnType<typeof startQaGatewayChild>>;
  cfg: OpenClawConfig;
};

export type QaSuiteResult = {
  outputDir: string;
  reportPath: string;
  summaryPath: string;
  report: string;
  scenarios: QaSuiteScenarioResult[];
};

function createQaActionConfig(baseUrl: string): OpenClawConfig {
  return {
    channels: {
      "qa-channel": {
        enabled: true,
        baseUrl,
        botUserId: "openclaw",
        botDisplayName: "OpenClaw QA",
        allowFrom: ["*"],
      },
    },
  };
}

async function waitForCondition<T>(
  check: () => T | Promise<T | null | undefined> | null | undefined,
  timeoutMs = 15_000,
  intervalMs = 100,
): Promise<T> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const value = await check();
    if (value !== null && value !== undefined) {
      return value;
    }
    await sleep(intervalMs);
  }
  throw new Error(`timed out after ${timeoutMs}ms`);
}

async function waitForOutboundMessage(
  state: QaBusState,
  predicate: (message: QaBusMessage) => boolean,
  timeoutMs = 15_000,
) {
  return await waitForCondition(
    () =>
      state
        .getSnapshot()
        .messages.filter((message) => message.direction === "outbound")
        .find(predicate),
    timeoutMs,
  );
}

async function waitForNoOutbound(state: QaBusState, timeoutMs = 1_200) {
  await sleep(timeoutMs);
  const outbound = state
    .getSnapshot()
    .messages.filter((message) => message.direction === "outbound");
  if (outbound.length > 0) {
    throw new Error(`expected no outbound messages, saw ${outbound.length}`);
  }
}

async function runScenario(name: string, steps: QaSuiteStep[]): Promise<QaSuiteScenarioResult> {
  const stepResults: QaReportCheck[] = [];
  for (const step of steps) {
    try {
      const details = await step.run();
      stepResults.push({
        name: step.name,
        status: "pass",
        ...(details ? { details } : {}),
      });
    } catch (error) {
      const details = error instanceof Error ? error.message : String(error);
      stepResults.push({
        name: step.name,
        status: "fail",
        details,
      });
      return {
        name,
        status: "fail",
        steps: stepResults,
        details,
      };
    }
  }
  return {
    name,
    status: "pass",
    steps: stepResults,
  };
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`request failed ${response.status}: ${url}`);
  }
  return (await response.json()) as T;
}

async function runAgentPrompt(
  env: QaSuiteEnvironment,
  params: {
    sessionKey: string;
    message: string;
    to?: string;
    threadId?: string;
    provider?: string;
    model?: string;
    timeoutMs?: number;
  },
) {
  const target = params.to ?? "dm:qa-operator";
  const started = (await env.gateway.call(
    "agent",
    {
      idempotencyKey: randomUUID(),
      agentId: "qa",
      sessionKey: params.sessionKey,
      message: params.message,
      deliver: true,
      channel: "qa-channel",
      to: target,
      replyChannel: "qa-channel",
      replyTo: target,
      ...(params.threadId ? { threadId: params.threadId } : {}),
      ...(params.provider ? { provider: params.provider } : {}),
      ...(params.model ? { model: params.model } : {}),
    },
    {
      timeoutMs: params.timeoutMs ?? 30_000,
    },
  )) as { runId?: string; status?: string };
  if (!started.runId) {
    throw new Error(`agent call did not return a runId: ${JSON.stringify(started)}`);
  }
  const waited = (await env.gateway.call(
    "agent.wait",
    {
      runId: started.runId,
      timeoutMs: params.timeoutMs ?? 30_000,
    },
    {
      timeoutMs: (params.timeoutMs ?? 30_000) + 5_000,
    },
  )) as { status?: string; error?: string };
  if (waited.status !== "ok") {
    throw new Error(
      `agent.wait returned ${String(waited.status ?? "unknown")}: ${waited.error ?? "no error"}`,
    );
  }
  return {
    started,
    waited,
  };
}

type QaActionName = "delete" | "edit" | "react" | "thread-create";

async function handleQaAction(params: {
  env: QaSuiteEnvironment;
  action: QaActionName;
  args: Record<string, unknown>;
}) {
  const result = await qaChannelPlugin.actions?.handleAction?.({
    channel: "qa-channel",
    action: params.action,
    cfg: params.env.cfg,
    accountId: "default",
    params: params.args,
  });
  return extractQaToolPayload(result);
}

function buildScenarioMap(env: QaSuiteEnvironment) {
  const state = env.lab.state;
  const reset = async () => {
    state.reset();
    await sleep(100);
  };

  return new Map<string, () => Promise<QaSuiteScenarioResult>>([
    [
      "channel-chat-baseline",
      async () =>
        await runScenario("Channel baseline conversation", [
          {
            name: "ignores unmentioned channel chatter",
            run: async () => {
              await reset();
              state.addInboundMessage({
                conversation: { id: "qa-room", kind: "channel", title: "QA Room" },
                senderId: "alice",
                senderName: "Alice",
                text: "hello team, no bot ping here",
              });
              await waitForNoOutbound(state);
            },
          },
          {
            name: "replies when mentioned in channel",
            run: async () => {
              state.addInboundMessage({
                conversation: { id: "qa-room", kind: "channel", title: "QA Room" },
                senderId: "alice",
                senderName: "Alice",
                text: "@openclaw explain the QA lab",
              });
              const message = await waitForOutboundMessage(
                state,
                (candidate) => candidate.conversation.id === "qa-room" && !candidate.threadId,
              );
              return message.text;
            },
          },
        ]),
    ],
    [
      "cron-one-minute-ping",
      async () =>
        await runScenario("Cron one-minute ping", [
          {
            name: "stores a reminder roughly one minute ahead",
            run: async () => {
              await reset();
              const at = new Date(Date.now() + 60_000).toISOString();
              const response = (await env.gateway.call("cron.add", {
                name: `qa-suite-${randomUUID()}`,
                enabled: true,
                schedule: { kind: "at", at },
                sessionTarget: "isolated",
                wakeMode: "next-heartbeat",
                payload: {
                  kind: "agentTurn",
                  message:
                    "A QA cron just fired. Send a one-line ping back to the room so the operator can verify delivery.",
                },
                delivery: {
                  mode: "announce",
                  channel: "qa-channel",
                  to: "channel:qa-room",
                },
              })) as { id?: string; schedule?: { at?: string } };
              const scheduledAt = response.schedule?.at ?? at;
              const delta = new Date(scheduledAt).getTime() - Date.now();
              if (delta < 45_000 || delta > 75_000) {
                throw new Error(`expected ~1 minute schedule, got ${delta}ms`);
              }
              (globalThis as typeof globalThis & { __qaCronJobId?: string }).__qaCronJobId =
                response.id;
              return scheduledAt;
            },
          },
          {
            name: "forces the reminder through QA channel delivery",
            run: async () => {
              const jobId = (globalThis as typeof globalThis & { __qaCronJobId?: string })
                .__qaCronJobId;
              if (!jobId) {
                throw new Error("missing cron job id");
              }
              await env.gateway.call(
                "cron.run",
                { id: jobId, mode: "force" },
                { timeoutMs: 30_000 },
              );
              const outbound = await waitForOutboundMessage(
                state,
                (candidate) => candidate.conversation.id === "qa-room",
                30_000,
              );
              return outbound.text;
            },
          },
        ]),
    ],
    [
      "dm-chat-baseline",
      async () =>
        await runScenario("DM baseline conversation", [
          {
            name: "replies coherently in DM",
            run: async () => {
              await reset();
              state.addInboundMessage({
                conversation: { id: "alice", kind: "direct" },
                senderId: "alice",
                senderName: "Alice",
                text: "Hello there, who are you?",
              });
              const outbound = await waitForOutboundMessage(
                state,
                (candidate) => candidate.conversation.id === "alice",
              );
              return outbound.text;
            },
          },
        ]),
    ],
    [
      "lobster-invaders-build",
      async () =>
        await runScenario("Build Lobster Invaders", [
          {
            name: "creates the artifact after reading context",
            run: async () => {
              await reset();
              await runAgentPrompt(env, {
                sessionKey: "agent:qa:lobster-invaders",
                message:
                  "Read the QA kickoff context first, then build a tiny Lobster Invaders HTML game in this workspace and tell me where it is.",
              });
              await waitForOutboundMessage(
                state,
                (candidate) => candidate.conversation.id === "qa-operator",
              );
              const artifactPath = path.join(env.gateway.workspaceDir, "lobster-invaders.html");
              const artifact = await fs.readFile(artifactPath, "utf8");
              if (!artifact.includes("Lobster Invaders")) {
                throw new Error("missing Lobster Invaders artifact");
              }
              const requests = await fetchJson<Array<{ prompt?: string; toolOutput?: string }>>(
                `${env.mock.baseUrl}/debug/requests`,
              );
              if (!requests.some((request) => (request.toolOutput ?? "").includes("QA mission"))) {
                throw new Error("expected pre-write read evidence");
              }
              return "lobster-invaders.html";
            },
          },
        ]),
    ],
    [
      "memory-recall",
      async () =>
        await runScenario("Memory recall after context switch", [
          {
            name: "stores the canary fact",
            run: async () => {
              await reset();
              await runAgentPrompt(env, {
                sessionKey: "agent:qa:memory",
                message: "Please remember this fact for later: the QA canary code is ALPHA-7.",
              });
              const outbound = await waitForOutboundMessage(
                state,
                (candidate) => candidate.conversation.id === "qa-operator",
              );
              return outbound.text;
            },
          },
          {
            name: "recalls the same fact later",
            run: async () => {
              await runAgentPrompt(env, {
                sessionKey: "agent:qa:memory",
                message: "What was the QA canary code I asked you to remember earlier?",
              });
              const outbound = await waitForCondition(
                () =>
                  state
                    .getSnapshot()
                    .messages.filter(
                      (candidate) =>
                        candidate.direction === "outbound" &&
                        candidate.conversation.id === "qa-operator" &&
                        candidate.text.includes("ALPHA-7"),
                    )
                    .at(-1),
                20_000,
              );
              return outbound.text;
            },
          },
        ]),
    ],
    [
      "model-switch-follow-up",
      async () =>
        await runScenario("Model switch follow-up", [
          {
            name: "runs on the default configured model",
            run: async () => {
              await reset();
              await runAgentPrompt(env, {
                sessionKey: "agent:qa:model-switch",
                message: "Say hello from the default configured model.",
              });
              await waitForOutboundMessage(
                state,
                (candidate) => candidate.conversation.id === "qa-operator",
              );
              const request = await fetchJson<{ body?: { model?: string } }>(
                `${env.mock.baseUrl}/debug/last-request`,
              );
              return String(request.body?.model ?? "");
            },
          },
          {
            name: "switches to the alternate model and continues",
            run: async () => {
              await runAgentPrompt(env, {
                sessionKey: "agent:qa:model-switch",
                message: "Continue the exchange after switching models and note the handoff.",
                provider: "mock-openai",
                model: "gpt-5.4-alt",
              });
              const outbound = await waitForCondition(
                () =>
                  state
                    .getSnapshot()
                    .messages.filter(
                      (candidate) =>
                        candidate.direction === "outbound" &&
                        candidate.conversation.id === "qa-operator" &&
                        candidate.text.toLowerCase().includes("switch"),
                    )
                    .at(-1),
                20_000,
              );
              const request = await fetchJson<{ body?: { model?: string } }>(
                `${env.mock.baseUrl}/debug/last-request`,
              );
              if (request.body?.model !== "gpt-5.4-alt") {
                throw new Error(`expected gpt-5.4-alt, got ${String(request.body?.model ?? "")}`);
              }
              return outbound.text;
            },
          },
        ]),
    ],
    [
      "reaction-edit-delete",
      async () =>
        await runScenario("Reaction, edit, delete lifecycle", [
          {
            name: "records reaction, edit, and delete actions",
            run: async () => {
              await reset();
              const seed = state.addOutboundMessage({
                to: "channel:qa-room",
                text: "seed message",
              });
              await handleQaAction({
                env,
                action: "react",
                args: { messageId: seed.id, emoji: "white_check_mark" },
              });
              await handleQaAction({
                env,
                action: "edit",
                args: { messageId: seed.id, text: "seed message (edited)" },
              });
              await handleQaAction({
                env,
                action: "delete",
                args: { messageId: seed.id },
              });
              const message = state.readMessage({ messageId: seed.id });
              if (
                message.reactions.length === 0 ||
                !message.deleted ||
                !message.text.includes("(edited)")
              ) {
                throw new Error("message lifecycle did not persist");
              }
              return message.text;
            },
          },
        ]),
    ],
    [
      "source-docs-discovery-report",
      async () =>
        await runScenario("Source and docs discovery report", [
          {
            name: "reads seeded material and emits a protocol report",
            run: async () => {
              await reset();
              await runAgentPrompt(env, {
                sessionKey: "agent:qa:discovery",
                message:
                  "Read the seeded docs and source plan, then report grouped into Worked, Failed, Blocked, and Follow-up.",
              });
              const outbound = await waitForCondition(
                () =>
                  state
                    .getSnapshot()
                    .messages.filter(
                      (candidate) =>
                        candidate.direction === "outbound" &&
                        candidate.conversation.id === "qa-operator" &&
                        candidate.text.includes("Worked:"),
                    )
                    .at(-1),
                20_000,
              );
              return outbound.text;
            },
          },
        ]),
    ],
    [
      "subagent-handoff",
      async () =>
        await runScenario("Subagent handoff", [
          {
            name: "delegates a bounded task and reports the result",
            run: async () => {
              await reset();
              await runAgentPrompt(env, {
                sessionKey: "agent:qa:subagent",
                message:
                  "Delegate a bounded QA task to a subagent, then summarize the delegated result clearly.",
                timeoutMs: 45_000,
              });
              const outbound = await waitForCondition(
                () =>
                  state
                    .getSnapshot()
                    .messages.filter(
                      (candidate) =>
                        candidate.direction === "outbound" &&
                        candidate.conversation.id === "qa-operator" &&
                        candidate.text.toLowerCase().includes("delegated"),
                    )
                    .at(-1),
                45_000,
              );
              const sessions = await waitForCondition(
                async () => {
                  const listed = (await env.gateway.call("sessions.list", {
                    spawnedBy: "agent:qa:subagent",
                  })) as {
                    sessions?: Array<{
                      key?: string;
                      parentSessionKey?: string;
                      spawnedBy?: string;
                    }>;
                  };
                  return (listed.sessions ?? []).length > 0 ? listed : null;
                },
                20_000,
                250,
              );
              if ((sessions.sessions ?? []).length === 0) {
                throw new Error("expected spawned child session");
              }
              return outbound.text;
            },
          },
        ]),
    ],
    [
      "thread-follow-up",
      async () =>
        await runScenario("Threaded follow-up", [
          {
            name: "keeps follow-up inside the thread",
            run: async () => {
              await reset();
              const threadPayload = (await handleQaAction({
                env,
                action: "thread-create",
                args: {
                  channelId: "qa-room",
                  title: "QA deep dive",
                },
              })) as { thread?: { id?: string } } | undefined;
              const threadId = threadPayload?.thread?.id;
              if (!threadId) {
                throw new Error("missing thread id");
              }
              state.addInboundMessage({
                conversation: { id: "qa-room", kind: "channel", title: "QA Room" },
                senderId: "alice",
                senderName: "Alice",
                text: "@openclaw continue this work inside the thread",
                threadId,
                threadTitle: "QA deep dive",
              });
              const outbound = await waitForOutboundMessage(
                state,
                (candidate) =>
                  candidate.conversation.id === "qa-room" && candidate.threadId === threadId,
              );
              const leaked = state
                .getSnapshot()
                .messages.some(
                  (candidate) =>
                    candidate.direction === "outbound" &&
                    candidate.conversation.id === "qa-room" &&
                    !candidate.threadId,
                );
              if (leaked) {
                throw new Error("thread reply leaked into root channel");
              }
              return outbound.text;
            },
          },
        ]),
    ],
  ]);
}

export async function runQaSuite(params?: { outputDir?: string }) {
  const startedAt = new Date();
  const outputDir =
    params?.outputDir ??
    path.join(process.cwd(), ".artifacts", "qa-e2e", `suite-${Date.now().toString(36)}`);
  await fs.mkdir(outputDir, { recursive: true });

  const lab = await startQaLabServer({
    host: "127.0.0.1",
    port: 0,
    embeddedGateway: "disabled",
  });
  const mock = await startQaMockOpenAiServer({
    host: "127.0.0.1",
    port: 0,
  });
  const gateway = await startQaGatewayChild({
    repoRoot: process.cwd(),
    providerBaseUrl: `${mock.baseUrl}/v1`,
    qaBusBaseUrl: lab.listenUrl,
  });
  const env: QaSuiteEnvironment = {
    lab,
    mock,
    gateway,
    cfg: createQaActionConfig(lab.listenUrl),
  };

  try {
    const catalog = readQaBootstrapScenarioCatalog();
    const scenarioMap = buildScenarioMap(env);
    const scenarios: QaSuiteScenarioResult[] = [];

    for (const scenario of catalog.scenarios) {
      const run = scenarioMap.get(scenario.id);
      if (!run) {
        scenarios.push({
          name: scenario.title,
          status: "fail",
          details: `no executable scenario registered for ${scenario.id}`,
          steps: [],
        });
        continue;
      }
      scenarios.push(await run());
    }

    const finishedAt = new Date();
    const report = renderQaMarkdownReport({
      title: "OpenClaw QA Scenario Suite",
      startedAt,
      finishedAt,
      checks: [],
      scenarios: scenarios.map((scenario) => ({
        name: scenario.name,
        status: scenario.status,
        details: scenario.details,
        steps: scenario.steps,
      })) satisfies QaReportScenario[],
      notes: [
        "Runs against qa-channel + qa-lab bus + real gateway child + mock OpenAI provider.",
        "Cron uses a one-minute schedule assertion plus forced execution for fast verification.",
      ],
    });
    const reportPath = path.join(outputDir, "qa-suite-report.md");
    const summaryPath = path.join(outputDir, "qa-suite-summary.json");
    await fs.writeFile(reportPath, report, "utf8");
    await fs.writeFile(
      summaryPath,
      `${JSON.stringify(
        {
          scenarios,
          counts: {
            total: scenarios.length,
            passed: scenarios.filter((scenario) => scenario.status === "pass").length,
            failed: scenarios.filter((scenario) => scenario.status === "fail").length,
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    return {
      outputDir,
      reportPath,
      summaryPath,
      report,
      scenarios,
    } satisfies QaSuiteResult;
  } finally {
    await gateway.stop();
    await mock.stop();
    await lab.stop();
  }
}
