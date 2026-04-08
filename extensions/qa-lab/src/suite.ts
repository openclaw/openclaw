import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import {
  formatMemoryDreamingDay,
  resolveSessionTranscriptsDirForAgent,
} from "openclaw/plugin-sdk/memory-core";
import { buildAgentSessionKey } from "openclaw/plugin-sdk/routing";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/text-runtime";
import type { QaBusState } from "./bus-state.js";
import { waitForCronRunCompletion } from "./cron-run-wait.js";
import {
  hasDiscoveryLabels,
  reportsDiscoveryScopeLeak,
  reportsMissingDiscoveryFiles,
} from "./discovery-eval.js";
import { extractQaToolPayload } from "./extract-tool-payload.js";
import { startQaGatewayChild } from "./gateway-child.js";
import { startQaLabServer } from "./lab-server.js";
import type { QaLabLatestReport, QaLabScenarioOutcome } from "./lab-server.js";
import { resolveQaLiveTurnTimeoutMs } from "./live-timeout.js";
import { startQaMockOpenAiServer } from "./mock-openai-server.js";
import {
  defaultQaModelForMode,
  isQaFastModeEnabled,
  normalizeQaProviderMode,
  type QaProviderMode,
} from "./model-selection.js";
import { hasModelSwitchContinuityEvidence } from "./model-switch-eval.js";
import type { QaThinkingLevel } from "./qa-gateway-config.js";
import { extractQaFailureReplyText } from "./reply-failure.js";
import { renderQaMarkdownReport, type QaReportCheck, type QaReportScenario } from "./report.js";
import { qaChannelPlugin, type QaBusMessage } from "./runtime-api.js";
import { readQaBootstrapScenarioCatalog } from "./scenario-catalog.js";
import { runScenarioFlow } from "./scenario-flow-runner.js";

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
  mock: Awaited<ReturnType<typeof startQaMockOpenAiServer>> | null;
  gateway: Awaited<ReturnType<typeof startQaGatewayChild>>;
  cfg: OpenClawConfig;
  repoRoot: string;
  providerMode: "mock-openai" | "live-frontier";
  primaryModel: string;
  alternateModel: string;
};

const _QA_IMAGE_UNDERSTANDING_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAQAAAAEACAYAAABccqhmAAAAAklEQVR4AewaftIAAAK4SURBVO3BAQEAMAwCIG//znsQgXfJBZjUALMaYFYDzGqAWQ0wqwFmNcCsBpjVALMaYFYDzGqAWQ0wqwFmNcCsBpjVALMaYFYDzGqAWQ0wqwFmNcCsBpjVALMaYFYDzGqAWQ0wqwFmNcCsBpjVALMaYFYDzGqAWQ0wqwFmNcCsBpjVALMaYFYDzGqAWQ0wqwFmNcCsBpjVALMaYFYDzGqAWQ0wqwFmNcCsBpjVALMaYFYDzGqAWQ0wqwFmNcCsBpjVALMaYFYDzGqAWQ0wqwFmNcCsBpjVALMaYFYDzGqAWQ0wqwFmNcCsBpjVALMaYFYDzGqAWQ0wqwFmNcCsBpjVALMaYFYDzGqAWQ0wqwFmNcCsBpjVALMaYFYDzGqAWQ0wqwFmNcCsBpjVALMaYFYDzGqAWQ0wqwFmNcCsBpjVALMaYFYDzGqAWQ0wqwFmNcCsBpjVALMaYFYDzGqAWQ0wqwFmNcCsBpjVALMaYFYDzGqAWQ0wqwFmNcCsl9wFmNQAsxpgVgPMaoBZDTCrAWY1wKwGmNUAsxpgVgPMaoBZDTCrAWY1wKwGmNUAsxpgVgPMaoBZDTCrAWY1wKwGmNUAsxpgVgPMaoBZDTCrAWY1wKwGmNUAsxpgVgPMaoBZDTCrAWY1wKwGmNUAsxpgVgPMaoBZDTCrAWY1wKwGmNUAsxpgVgPMaoBZDTCrAWY1wKwGmNUAsxpgVgPMaoBZDTCrAWY1wKwGmNUAsxpgVgPMaoBZDTCrAWY1wKwGmNUAsxpgVgPMaoBZDTCrAWY1wKwGmNUAsxpgVgPMaoBZDTCrAWY1wKwGmNUAsxpgVgPMaoBZDTCrAWY1wKwGmNUAsxpgVgPMaoBZDTCrAWY1wKwGmNUAsxpgVgPMaoBZDTCrAWY1wKwGmNUAsxpgVgPMaoBZDTCrAWY1wKwP4TIF+7ciPkoAAAAASUVORK5CYII=";
const _QA_IMAGE_UNDERSTANDING_LARGE_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAQAAAAEACAYAAABccqhmAAACuklEQVR4Ae3BAQEAMAwCIG//znsQgXfJBZjUALMaYFYDzGqAWQ0wqwFmNcCsBpjVALMaYFYDzGqAWQ0wqwFmNcCsBpjVALMaYFYDzGqAWQ0wqwFmNcCsBpjVALMaYFYDzGqAWQ0wqwFmNcCsBpjVALMaYFYDzGqAWQ0wqwFmNcCsBpjVALMaYFYDzGqAWQ0wqwFmNcCsBpjVALMaYFYDzGqAWQ0wqwFmNcCsBpjVALMaYFYDzGqAWQ0wqwFmNcCsBpjVALMaYFYDzGqAWQ0wqwFmNcCsBpjVALMaYFYDzGqAWQ0wqwFmNcCsBpjVALMaYFYDzGqAWQ0wqwFmNcCsBpjVALMaYFYDzGqAWQ0wqwFmNcCsBpjVALMaYFYDzGqAWQ0wqwFmNcCsBpjVALMaYFYDzGqAWQ0wqwFmNcCsBpjVALMaYFYDzGqAWQ0wqwFmNcCsBpjVALMaYFYDzGqAWQ0wqwFmNcCsl9wFmNQAsxpgVgPMaoBZDTCrAWY1wKwGmNUAsxpgVgPMaoBZDTCrAWY1wKwGmNUAsxpgVgPMaoBZDTCrAWY1wKwGmNUAsxpgVgPMaoBZDTCrAWY1wKwGmNUAsxpgVgPMaoBZDTCrAWY1wKwGmNUAsxpgVgPMaoBZDTCrAWY1wKwGmNUAsxpgVgPMaoBZDTCrAWY1wKwGmNUAsxpgVgPMaoBZDTCrAWY1wKwGmNUAsxpgVgPMaoBZDTCrAWY1wKwGmNUAsxpgVgPMaoBZDTCrAWY1wKwGmNUAsxpgVgPMaoBZDTCrAWY1wKwGmNUAsxpgVgPMaoBZDTCrAWY1wKwGmNUAsxpgVgPMaoBZDTCrAWY1wKwP4TIF+2YE/z8AAAAASUVORK5CYII=";

const QA_IMAGE_UNDERSTANDING_VALID_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAALklEQVR4nO3OoQEAAAyDsP7/9HYGJgJNdtuVDQAAAAAAACAHxH8AAAAAAACAHvBX0fhq85dN7QAAAABJRU5ErkJggg==";

type QaSkillStatusEntry = {
  name?: string;
  eligible?: boolean;
  disabled?: boolean;
  blockedByAllowlist?: boolean;
};

type QaConfigSnapshot = {
  hash?: string;
  config?: Record<string, unknown>;
};

type QaDreamingStatus = {
  enabled?: boolean;
  shortTermCount?: number;
  promotedTotal?: number;
  phaseSignalCount?: number;
  lightPhaseHitCount?: number;
  remPhaseHitCount?: number;
  phases?: {
    deep?: {
      managedCronPresent?: boolean;
      nextRunAtMs?: number;
    };
  };
};

type QaRawSessionStoreEntry = {
  sessionId?: string;
  status?: string;
  spawnedBy?: string;
  label?: string;
  abortedLastRun?: boolean;
  updatedAt?: number;
};

const QA_CONTROL_PLANE_WRITE_WINDOW_MS = 60_000;
const QA_CONTROL_PLANE_WRITE_MAX_REQUESTS = 2;

const qaControlPlaneWriteTimestamps: number[] = [];

function splitModelRef(ref: string) {
  const slash = ref.indexOf("/");
  if (slash <= 0 || slash === ref.length - 1) {
    return null;
  }
  return {
    provider: ref.slice(0, slash),
    model: ref.slice(slash + 1),
  };
}

function liveTurnTimeoutMs(env: QaSuiteEnvironment, fallbackMs: number) {
  return resolveQaLiveTurnTimeoutMs(env, fallbackMs);
}

export type QaSuiteResult = {
  outputDir: string;
  reportPath: string;
  summaryPath: string;
  report: string;
  scenarios: QaSuiteScenarioResult[];
  watchUrl: string;
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

function findFailureOutboundMessage(state: QaBusState, options?: { sinceIndex?: number }) {
  return state
    .getSnapshot()
    .messages.filter((message) => message.direction === "outbound")
    .slice(options?.sinceIndex ?? 0)
    .find((message) => Boolean(extractQaFailureReplyText(message.text)));
}

function createScenarioWaitForCondition(state: QaBusState) {
  const sinceIndex = state.getSnapshot().messages.length;
  return async function waitForScenarioCondition<T>(
    check: () => T | Promise<T | null | undefined> | null | undefined,
    timeoutMs = 15_000,
    intervalMs = 100,
  ): Promise<T> {
    return await waitForCondition(
      async () => {
        const failureMessage = findFailureOutboundMessage(state, { sinceIndex });
        if (failureMessage) {
          throw new Error(extractQaFailureReplyText(failureMessage.text) ?? failureMessage.text);
        }
        return await check();
      },
      timeoutMs,
      intervalMs,
    );
  };
}

async function waitForOutboundMessage(
  state: QaBusState,
  predicate: (message: QaBusMessage) => boolean,
  timeoutMs = 15_000,
  options?: { sinceIndex?: number },
) {
  return await waitForCondition(() => {
    const failureMessage = findFailureOutboundMessage(state, options);
    if (failureMessage) {
      throw new Error(extractQaFailureReplyText(failureMessage.text) ?? failureMessage.text);
    }
    const match = state
      .getSnapshot()
      .messages.filter((message) => message.direction === "outbound")
      .slice(options?.sinceIndex ?? 0)
      .find(predicate);
    if (!match) {
      return undefined;
    }
    const failureReply = extractQaFailureReplyText(match.text);
    if (failureReply) {
      throw new Error(failureReply);
    }
    return match;
  }, timeoutMs);
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

function recentOutboundSummary(state: QaBusState, limit = 5) {
  return state
    .getSnapshot()
    .messages.filter((message) => message.direction === "outbound")
    .slice(-limit)
    .map((message) => `${message.conversation.id}:${message.text}`)
    .join(" | ");
}

function formatConversationTranscript(
  state: QaBusState,
  params: {
    conversationId: string;
    threadId?: string;
    limit?: number;
  },
) {
  const messages = state
    .getSnapshot()
    .messages.filter(
      (message) =>
        message.conversation.id === params.conversationId &&
        (params.threadId ? message.threadId === params.threadId : true),
    );
  const selected = params.limit ? messages.slice(-params.limit) : messages;
  return selected
    .map((message) => {
      const direction = message.direction === "inbound" ? "user" : "assistant";
      const speaker = message.senderName?.trim() || message.senderId;
      const attachmentSummary =
        message.attachments && message.attachments.length > 0
          ? ` [attachments: ${message.attachments
              .map((attachment) => `${attachment.kind}:${attachment.fileName ?? attachment.id}`)
              .join(", ")}]`
          : "";
      return `${direction.toUpperCase()} ${speaker}: ${message.text}${attachmentSummary}`;
    })
    .join("\n\n");
}

async function runScenario(name: string, steps: QaSuiteStep[]): Promise<QaSuiteScenarioResult> {
  const stepResults: QaReportCheck[] = [];
  for (const step of steps) {
    try {
      if (process.env.OPENCLAW_QA_DEBUG === "1") {
        console.error(`[qa-suite] start scenario="${name}" step="${step.name}"`);
      }
      const details = await step.run();
      if (process.env.OPENCLAW_QA_DEBUG === "1") {
        console.error(`[qa-suite] pass scenario="${name}" step="${step.name}"`);
      }
      stepResults.push({
        name: step.name,
        status: "pass",
        ...(details ? { details } : {}),
      });
    } catch (error) {
      const details = formatErrorMessage(error);
      if (process.env.OPENCLAW_QA_DEBUG === "1") {
        console.error(`[qa-suite] fail scenario="${name}" step="${step.name}" details=${details}`);
      }
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

async function waitForGatewayHealthy(env: QaSuiteEnvironment, timeoutMs = 45_000) {
  await waitForCondition(
    async () => {
      try {
        const response = await fetch(`${env.gateway.baseUrl}/readyz`);
        return response.ok ? true : undefined;
      } catch {
        return undefined;
      }
    },
    timeoutMs,
    250,
  );
}

async function waitForQaChannelReady(env: QaSuiteEnvironment, timeoutMs = 45_000) {
  await waitForCondition(
    async () => {
      try {
        const payload = (await env.gateway.call(
          "channels.status",
          { probe: false, timeoutMs: 2_000 },
          { timeoutMs: 5_000 },
        )) as {
          channelAccounts?: Record<
            string,
            Array<{
              accountId?: string;
              running?: boolean;
              restartPending?: boolean;
            }>
          >;
        };
        const accounts = payload.channelAccounts?.["qa-channel"] ?? [];
        const account = accounts.find((entry) => entry.accountId === "default") ?? accounts[0];
        if (account?.running && account.restartPending !== true) {
          return true;
        }
        return undefined;
      } catch {
        return undefined;
      }
    },
    timeoutMs,
    500,
  );
}

async function waitForConfigRestartSettle(
  env: QaSuiteEnvironment,
  restartDelayMs = 1_000,
  timeoutMs = 60_000,
) {
  // config.patch/config.apply can still restart asynchronously after the RPC returns
  // in reload-off or restart-required hot-mode paths. Give that window time to fire.
  await sleep(restartDelayMs + 750);
  await waitForGatewayHealthy(env, timeoutMs);
}

function isGatewayRestartRace(error: unknown) {
  const text = formatErrorMessage(error);
  return (
    text.includes("gateway closed (1012)") ||
    text.includes("gateway closed (1006") ||
    text.includes("abnormal closure") ||
    text.includes("service restart")
  );
}

function isConfigHashConflict(error: unknown) {
  return formatErrorMessage(error).includes("config changed since last load");
}

function getGatewayRetryAfterMs(error: unknown) {
  const text = formatErrorMessage(error);
  const millisecondsMatch = /retryAfterMs["=: ]+(\d+)/i.exec(text);
  if (millisecondsMatch) {
    const parsed = Number(millisecondsMatch[1]);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  const secondsMatch = /retry after (\d+)s/i.exec(text);
  if (secondsMatch) {
    const parsed = Number(secondsMatch[1]);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed * 1_000;
    }
  }
  return null;
}

async function waitForQaControlPlaneWriteBudget() {
  while (true) {
    const now = Date.now();
    while (
      qaControlPlaneWriteTimestamps.length > 0 &&
      now - qaControlPlaneWriteTimestamps[0] >= QA_CONTROL_PLANE_WRITE_WINDOW_MS
    ) {
      qaControlPlaneWriteTimestamps.shift();
    }
    if (qaControlPlaneWriteTimestamps.length < QA_CONTROL_PLANE_WRITE_MAX_REQUESTS) {
      qaControlPlaneWriteTimestamps.push(now);
      return;
    }
    const retryAfterMs =
      qaControlPlaneWriteTimestamps[0] + QA_CONTROL_PLANE_WRITE_WINDOW_MS - now + 250;
    await sleep(Math.max(250, retryAfterMs));
  }
}

async function readConfigSnapshot(env: QaSuiteEnvironment) {
  const snapshot = (await env.gateway.call(
    "config.get",
    {},
    { timeoutMs: 60_000 },
  )) as QaConfigSnapshot;
  if (!snapshot.hash || !snapshot.config) {
    throw new Error("config.get returned no hash/config");
  }
  return {
    hash: snapshot.hash,
    config: snapshot.config,
  } satisfies { hash: string; config: Record<string, unknown> };
}

async function runConfigMutation(params: {
  env: QaSuiteEnvironment;
  action: "config.patch" | "config.apply";
  raw: string;
  sessionKey?: string;
  note?: string;
  restartDelayMs?: number;
}) {
  const restartDelayMs = params.restartDelayMs ?? 1_000;
  let lastConflict: unknown = null;
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    const snapshot = await readConfigSnapshot(params.env);
    try {
      await waitForQaControlPlaneWriteBudget();
      const result = await params.env.gateway.call(
        params.action,
        {
          raw: params.raw,
          baseHash: snapshot.hash,
          ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
          ...(params.note ? { note: params.note } : {}),
          restartDelayMs,
        },
        { timeoutMs: 45_000 },
      );
      await waitForConfigRestartSettle(params.env, restartDelayMs);
      return result;
    } catch (error) {
      if (isConfigHashConflict(error)) {
        lastConflict = error;
        await waitForGatewayHealthy(params.env, Math.max(15_000, restartDelayMs + 10_000)).catch(
          () => undefined,
        );
        continue;
      }
      const retryAfterMs = getGatewayRetryAfterMs(error);
      if (retryAfterMs && attempt < 8) {
        await sleep(retryAfterMs + 500);
        await waitForGatewayHealthy(params.env, Math.max(15_000, restartDelayMs + 10_000)).catch(
          () => undefined,
        );
        continue;
      }
      if (!isGatewayRestartRace(error)) {
        throw error;
      }
      await waitForConfigRestartSettle(params.env, restartDelayMs);
      return { ok: true, restarted: true };
    }
  }
  throw lastConflict ?? new Error(`${params.action} failed after retrying config hash conflicts`);
}

async function patchConfig(params: {
  env: QaSuiteEnvironment;
  patch: Record<string, unknown>;
  sessionKey?: string;
  note?: string;
  restartDelayMs?: number;
}) {
  return await runConfigMutation({
    env: params.env,
    action: "config.patch",
    raw: JSON.stringify(params.patch, null, 2),
    sessionKey: params.sessionKey,
    note: params.note,
    restartDelayMs: params.restartDelayMs,
  });
}

async function applyConfig(params: {
  env: QaSuiteEnvironment;
  nextConfig: Record<string, unknown>;
  sessionKey?: string;
  note?: string;
  restartDelayMs?: number;
}) {
  return await runConfigMutation({
    env: params.env,
    action: "config.apply",
    raw: JSON.stringify(params.nextConfig, null, 2),
    sessionKey: params.sessionKey,
    note: params.note,
    restartDelayMs: params.restartDelayMs,
  });
}

async function createSession(env: QaSuiteEnvironment, label: string, key?: string) {
  const created = (await env.gateway.call(
    "sessions.create",
    {
      label,
      ...(key ? { key } : {}),
    },
    {
      timeoutMs: liveTurnTimeoutMs(env, 60_000),
    },
  )) as { key?: string };
  const sessionKey = created.key?.trim();
  if (!sessionKey) {
    throw new Error("sessions.create returned no key");
  }
  return sessionKey;
}

async function readEffectiveTools(env: QaSuiteEnvironment, sessionKey: string) {
  const payload = (await env.gateway.call(
    "tools.effective",
    {
      sessionKey,
    },
    {
      timeoutMs: liveTurnTimeoutMs(env, 90_000),
    },
  )) as {
    groups?: Array<{ tools?: Array<{ id?: string }> }>;
  };
  const ids = new Set<string>();
  for (const group of payload.groups ?? []) {
    for (const tool of group.tools ?? []) {
      if (tool.id?.trim()) {
        ids.add(tool.id.trim());
      }
    }
  }
  return ids;
}

async function readSkillStatus(env: QaSuiteEnvironment, agentId = "qa") {
  const payload = (await env.gateway.call(
    "skills.status",
    {
      agentId,
    },
    {
      timeoutMs: liveTurnTimeoutMs(env, 45_000),
    },
  )) as {
    skills?: QaSkillStatusEntry[];
  };
  return payload.skills ?? [];
}

async function readRawQaSessionStore(env: QaSuiteEnvironment) {
  const storePath = path.join(
    env.gateway.tempRoot,
    "state",
    "agents",
    "qa",
    "sessions",
    "sessions.json",
  );
  try {
    const raw = await fs.readFile(storePath, "utf8");
    return JSON.parse(raw) as Record<string, QaRawSessionStoreEntry>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

async function runQaCli(
  env: QaSuiteEnvironment,
  args: string[],
  opts?: { timeoutMs?: number; json?: boolean },
) {
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  const distEntryPath = path.join(env.repoRoot, "dist", "index.js");
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [distEntryPath, ...args], {
      cwd: env.gateway.tempRoot,
      env: env.gateway.runtimeEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`qa cli timed out: openclaw ${args.join(" ")}`));
    }, opts?.timeoutMs ?? 60_000);
    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `qa cli failed (${code ?? "unknown"}): ${Buffer.concat(stderr).toString("utf8").trim()}`,
        ),
      );
    });
  });
  const text = Buffer.concat(stdout).toString("utf8").trim();
  if (!opts?.json) {
    return text;
  }
  return text ? (JSON.parse(text) as unknown) : {};
}

function extractMediaPathFromText(text: string | undefined): string | undefined {
  return /MEDIA:([^\n]+)/.exec(text ?? "")?.[1]?.trim();
}

async function resolveGeneratedImagePath(params: {
  env: QaSuiteEnvironment;
  promptSnippet: string;
  startedAtMs: number;
  timeoutMs: number;
}) {
  return await waitForCondition(
    async () => {
      if (params.env.mock) {
        const requests = await fetchJson<Array<{ allInputText?: string; toolOutput?: string }>>(
          `${params.env.mock.baseUrl}/debug/requests`,
        );
        for (let index = requests.length - 1; index >= 0; index -= 1) {
          const request = requests[index];
          if (!String(request.allInputText ?? "").includes(params.promptSnippet)) {
            continue;
          }
          const mediaPath = extractMediaPathFromText(request.toolOutput);
          if (mediaPath) {
            return mediaPath;
          }
        }
      }

      const mediaDir = path.join(
        params.env.gateway.tempRoot,
        "state",
        "media",
        "tool-image-generation",
      );
      const entries = await fs.readdir(mediaDir).catch(() => []);
      const candidates = await Promise.all(
        entries.map(async (entry) => {
          const fullPath = path.join(mediaDir, entry);
          const stat = await fs.stat(fullPath).catch(() => null);
          if (!stat?.isFile()) {
            return null;
          }
          return {
            fullPath,
            mtimeMs: stat.mtimeMs,
          };
        }),
      );
      return candidates
        .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
        .filter((entry) => entry.mtimeMs >= params.startedAtMs - 1_000)
        .toSorted((left, right) => right.mtimeMs - left.mtimeMs)
        .at(0)?.fullPath;
    },
    params.timeoutMs,
    250,
  );
}

async function startAgentRun(
  env: QaSuiteEnvironment,
  params: {
    sessionKey: string;
    message: string;
    to?: string;
    threadId?: string;
    provider?: string;
    model?: string;
    timeoutMs?: number;
    attachments?: Array<{
      mimeType: string;
      fileName: string;
      content: string;
    }>;
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
      ...(params.attachments ? { attachments: params.attachments } : {}),
    },
    {
      timeoutMs: params.timeoutMs ?? 30_000,
    },
  )) as { runId?: string; status?: string };
  if (!started.runId) {
    throw new Error(`agent call did not return a runId: ${JSON.stringify(started)}`);
  }
  return started;
}

async function waitForAgentRun(env: QaSuiteEnvironment, runId: string, timeoutMs = 30_000) {
  return (await env.gateway.call(
    "agent.wait",
    {
      runId,
      timeoutMs,
    },
    {
      timeoutMs: timeoutMs + 5_000,
    },
  )) as { status?: string; error?: string };
}

async function listCronJobs(env: QaSuiteEnvironment) {
  const payload = (await env.gateway.call(
    "cron.list",
    {
      includeDisabled: true,
      limit: 200,
      sortBy: "name",
      sortDir: "asc",
    },
    { timeoutMs: 30_000 },
  )) as {
    jobs?: Array<{
      id?: string;
      name?: string;
      payload?: { kind?: string; text?: string };
      state?: { nextRunAtMs?: number };
    }>;
  };
  return payload.jobs ?? [];
}

async function readDoctorMemoryStatus(env: QaSuiteEnvironment) {
  return (await env.gateway.call("doctor.memory.status", {}, { timeoutMs: 30_000 })) as {
    dreaming?: QaDreamingStatus;
  };
}

async function forceMemoryIndex(params: {
  env: QaSuiteEnvironment;
  query: string;
  expectedNeedle: string;
}) {
  await waitForGatewayHealthy(params.env, 60_000);
  await waitForQaChannelReady(params.env, 60_000);
  await runQaCli(params.env, ["memory", "index", "--agent", "qa", "--force"], {
    timeoutMs: liveTurnTimeoutMs(params.env, 60_000),
  });
  const payload = await waitForCondition(
    async () => {
      const result = (await runQaCli(
        params.env,
        ["memory", "search", "--agent", "qa", "--json", "--query", params.query],
        {
          timeoutMs: liveTurnTimeoutMs(params.env, 60_000),
          json: true,
        },
      )) as { results?: Array<{ snippet?: string; text?: string; path?: string }> };
      const haystack = JSON.stringify(result.results ?? []);
      return haystack.includes(params.expectedNeedle) ? result : undefined;
    },
    liveTurnTimeoutMs(params.env, 20_000),
    500,
  );
  const haystack = JSON.stringify(payload.results ?? []);
  if (!haystack.includes(params.expectedNeedle)) {
    throw new Error(`memory index missing expected fact after reindex: ${haystack}`);
  }
}

function findSkill(skills: QaSkillStatusEntry[], name: string) {
  return skills.find((skill) => skill.name === name);
}

async function writeWorkspaceSkill(params: {
  env: QaSuiteEnvironment;
  name: string;
  body: string;
}) {
  const skillDir = path.join(params.env.gateway.workspaceDir, "skills", params.name);
  await fs.mkdir(skillDir, { recursive: true });
  const skillPath = path.join(skillDir, "SKILL.md");
  await fs.writeFile(skillPath, `${params.body.trim()}\n`, "utf8");
  return skillPath;
}

async function callPluginToolsMcp(params: {
  env: QaSuiteEnvironment;
  toolName: string;
  args: Record<string, unknown>;
}) {
  const transportEnv = Object.fromEntries(
    Object.entries(params.env.gateway.runtimeEnv).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", "src/mcp/plugin-tools-serve.ts"],
    stderr: "pipe",
    env: transportEnv,
  });
  const client = new Client({ name: "openclaw-qa-suite", version: "0.0.0" }, {});
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    const tool = listed.tools.find((entry) => entry.name === params.toolName);
    if (!tool) {
      throw new Error(`MCP tool missing: ${params.toolName}`);
    }
    return await client.callTool({
      name: params.toolName,
      arguments: params.args,
    });
  } finally {
    await client.close().catch(() => {});
  }
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
    attachments?: Array<{
      mimeType: string;
      fileName: string;
      content: string;
    }>;
  },
) {
  const started = await startAgentRun(env, params);
  const waited = await waitForAgentRun(env, started.runId!, params.timeoutMs ?? 30_000);
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

async function ensureImageGenerationConfigured(env: QaSuiteEnvironment) {
  const imageModelRef = "openai/gpt-image-1";
  await patchConfig({
    env,
    patch:
      env.providerMode === "mock-openai"
        ? {
            plugins: {
              allow: ["memory-core", "openai", "qa-channel"],
              entries: {
                openai: {
                  enabled: true,
                },
              },
            },
            models: {
              providers: {
                openai: {
                  baseUrl: `${env.mock?.baseUrl}/v1`,
                  apiKey: "test",
                  api: "openai-responses",
                  models: [
                    {
                      id: "gpt-image-1",
                      name: "gpt-image-1",
                      api: "openai-responses",
                      reasoning: false,
                      input: ["text"],
                      cost: {
                        input: 0,
                        output: 0,
                        cacheRead: 0,
                        cacheWrite: 0,
                      },
                      contextWindow: 128_000,
                      maxTokens: 4096,
                    },
                  ],
                },
              },
            },
            agents: {
              defaults: {
                imageGenerationModel: {
                  primary: imageModelRef,
                },
              },
            },
          }
        : {
            agents: {
              defaults: {
                imageGenerationModel: {
                  primary: imageModelRef,
                },
              },
            },
          },
  });
  await waitForGatewayHealthy(env);
  await waitForQaChannelReady(env, 60_000);
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

type QaScenarioFlowApi = {
  env: QaSuiteEnvironment;
  lab: QaSuiteEnvironment["lab"];
  state: QaBusState;
  scenario: ReturnType<typeof readQaBootstrapScenarioCatalog>["scenarios"][number];
  config: Record<string, unknown>;
  fs: typeof fs;
  path: typeof path;
  sleep: typeof sleep;
  randomUUID: typeof randomUUID;
  runScenario: typeof runScenario;
  waitForCondition: typeof waitForCondition;
  waitForOutboundMessage: typeof waitForOutboundMessage;
  waitForNoOutbound: typeof waitForNoOutbound;
  recentOutboundSummary: typeof recentOutboundSummary;
  formatConversationTranscript: typeof formatConversationTranscript;
  fetchJson: typeof fetchJson;
  waitForGatewayHealthy: typeof waitForGatewayHealthy;
  waitForQaChannelReady: typeof waitForQaChannelReady;
  waitForConfigRestartSettle: typeof waitForConfigRestartSettle;
  patchConfig: typeof patchConfig;
  applyConfig: typeof applyConfig;
  readConfigSnapshot: typeof readConfigSnapshot;
  createSession: typeof createSession;
  readEffectiveTools: typeof readEffectiveTools;
  readSkillStatus: typeof readSkillStatus;
  readRawQaSessionStore: typeof readRawQaSessionStore;
  runQaCli: typeof runQaCli;
  extractMediaPathFromText: typeof extractMediaPathFromText;
  resolveGeneratedImagePath: typeof resolveGeneratedImagePath;
  startAgentRun: typeof startAgentRun;
  waitForAgentRun: typeof waitForAgentRun;
  listCronJobs: typeof listCronJobs;
  waitForCronRunCompletion: typeof waitForCronRunCompletion;
  readDoctorMemoryStatus: typeof readDoctorMemoryStatus;
  forceMemoryIndex: typeof forceMemoryIndex;
  findSkill: typeof findSkill;
  writeWorkspaceSkill: typeof writeWorkspaceSkill;
  callPluginToolsMcp: typeof callPluginToolsMcp;
  runAgentPrompt: typeof runAgentPrompt;
  ensureImageGenerationConfigured: typeof ensureImageGenerationConfigured;
  handleQaAction: typeof handleQaAction;
  extractQaToolPayload: typeof extractQaToolPayload;
  formatMemoryDreamingDay: typeof formatMemoryDreamingDay;
  resolveSessionTranscriptsDirForAgent: typeof resolveSessionTranscriptsDirForAgent;
  buildAgentSessionKey: typeof buildAgentSessionKey;
  normalizeLowercaseStringOrEmpty: typeof normalizeLowercaseStringOrEmpty;
  formatErrorMessage: typeof formatErrorMessage;
  liveTurnTimeoutMs: typeof liveTurnTimeoutMs;
  resolveQaLiveTurnTimeoutMs: typeof resolveQaLiveTurnTimeoutMs;
  splitModelRef: typeof splitModelRef;
  qaChannelPlugin: typeof qaChannelPlugin;
  hasDiscoveryLabels: typeof hasDiscoveryLabels;
  reportsDiscoveryScopeLeak: typeof reportsDiscoveryScopeLeak;
  reportsMissingDiscoveryFiles: typeof reportsMissingDiscoveryFiles;
  hasModelSwitchContinuityEvidence: typeof hasModelSwitchContinuityEvidence;
  imageUnderstandingPngBase64: string;
  imageUnderstandingLargePngBase64: string;
  imageUnderstandingValidPngBase64: string;
  resetBus: () => Promise<void>;
  reset: () => Promise<void>;
};

function createScenarioFlowApi(
  env: QaSuiteEnvironment,
  scenario: ReturnType<typeof readQaBootstrapScenarioCatalog>["scenarios"][number],
): QaScenarioFlowApi {
  return {
    env,
    lab: env.lab,
    state: env.lab.state,
    scenario,
    config: scenario.execution.config ?? {},
    fs,
    path,
    sleep,
    randomUUID,
    runScenario,
    waitForCondition: createScenarioWaitForCondition(env.lab.state),
    waitForOutboundMessage,
    waitForNoOutbound,
    recentOutboundSummary,
    formatConversationTranscript,
    fetchJson,
    waitForGatewayHealthy,
    waitForQaChannelReady,
    waitForConfigRestartSettle,
    patchConfig,
    applyConfig,
    readConfigSnapshot,
    createSession,
    readEffectiveTools,
    readSkillStatus,
    readRawQaSessionStore,
    runQaCli,
    extractMediaPathFromText,
    resolveGeneratedImagePath,
    startAgentRun,
    waitForAgentRun,
    listCronJobs,
    waitForCronRunCompletion,
    readDoctorMemoryStatus,
    forceMemoryIndex,
    findSkill,
    writeWorkspaceSkill,
    callPluginToolsMcp,
    runAgentPrompt,
    ensureImageGenerationConfigured,
    handleQaAction,
    extractQaToolPayload,
    formatMemoryDreamingDay,
    resolveSessionTranscriptsDirForAgent,
    buildAgentSessionKey,
    normalizeLowercaseStringOrEmpty,
    formatErrorMessage,
    liveTurnTimeoutMs,
    resolveQaLiveTurnTimeoutMs,
    splitModelRef,
    qaChannelPlugin,
    hasDiscoveryLabels,
    reportsDiscoveryScopeLeak,
    reportsMissingDiscoveryFiles,
    hasModelSwitchContinuityEvidence,
    imageUnderstandingPngBase64: _QA_IMAGE_UNDERSTANDING_PNG_BASE64,
    imageUnderstandingLargePngBase64: _QA_IMAGE_UNDERSTANDING_LARGE_PNG_BASE64,
    imageUnderstandingValidPngBase64: QA_IMAGE_UNDERSTANDING_VALID_PNG_BASE64,
    resetBus: async () => {
      env.lab.state.reset();
      await sleep(100);
    },
    reset: async () => {
      env.lab.state.reset();
      await sleep(100);
    },
  };
}

export const qaSuiteTesting = {
  createScenarioWaitForCondition,
  findFailureOutboundMessage,
  waitForOutboundMessage,
};

async function runScenarioDefinition(
  env: QaSuiteEnvironment,
  scenario: ReturnType<typeof readQaBootstrapScenarioCatalog>["scenarios"][number],
) {
  const api = createScenarioFlowApi(env, scenario);
  if (!scenario.execution.flow) {
    throw new Error(`scenario missing flow: ${scenario.id}`);
  }
  return await runScenarioFlow({
    api,
    flow: scenario.execution.flow,
    scenarioTitle: scenario.title,
  });
}

export async function runQaSuite(params?: {
  repoRoot?: string;
  outputDir?: string;
  providerMode?: QaProviderMode | "live-openai";
  primaryModel?: string;
  alternateModel?: string;
  fastMode?: boolean;
  thinkingDefault?: QaThinkingLevel;
  scenarioIds?: string[];
  lab?: Awaited<ReturnType<typeof startQaLabServer>>;
}) {
  const startedAt = new Date();
  const repoRoot = path.resolve(params?.repoRoot ?? process.cwd());
  const providerMode = normalizeQaProviderMode(params?.providerMode ?? "mock-openai");
  const primaryModel = params?.primaryModel ?? defaultQaModelForMode(providerMode);
  const alternateModel =
    params?.alternateModel ?? defaultQaModelForMode(providerMode, { alternate: true });
  const fastMode =
    typeof params?.fastMode === "boolean"
      ? params.fastMode
      : isQaFastModeEnabled({ primaryModel, alternateModel });
  const outputDir =
    params?.outputDir ??
    path.join(repoRoot, ".artifacts", "qa-e2e", `suite-${Date.now().toString(36)}`);
  await fs.mkdir(outputDir, { recursive: true });

  const ownsLab = !params?.lab;
  const lab =
    params?.lab ??
    (await startQaLabServer({
      repoRoot,
      host: "127.0.0.1",
      port: 0,
      embeddedGateway: "disabled",
    }));
  const mock =
    providerMode === "mock-openai"
      ? await startQaMockOpenAiServer({
          host: "127.0.0.1",
          port: 0,
        })
      : null;
  const gateway = await startQaGatewayChild({
    repoRoot,
    providerBaseUrl: mock ? `${mock.baseUrl}/v1` : undefined,
    qaBusBaseUrl: lab.listenUrl,
    controlUiAllowedOrigins: [lab.listenUrl],
    providerMode,
    primaryModel,
    alternateModel,
    fastMode,
    thinkingDefault: params?.thinkingDefault,
    controlUiEnabled: true,
  });
  lab.setControlUi({
    controlUiProxyTarget: gateway.baseUrl,
    controlUiToken: gateway.token,
  });
  const env: QaSuiteEnvironment = {
    lab,
    mock,
    gateway,
    cfg: createQaActionConfig(lab.listenUrl),
    repoRoot,
    providerMode,
    primaryModel,
    alternateModel,
  };

  try {
    // The gateway child already waits for /readyz before returning, but qa-channel
    // can still be finishing its account startup. Pay that readiness cost once here
    // so the first scenario does not race channel bootstrap.
    await waitForQaChannelReady(env, 120_000).catch(async () => {
      await waitForGatewayHealthy(env, 120_000);
      await waitForQaChannelReady(env, 120_000);
    });
    await sleep(1_000);
    const catalog = readQaBootstrapScenarioCatalog();
    const requestedScenarioIds =
      params?.scenarioIds && params.scenarioIds.length > 0 ? new Set(params.scenarioIds) : null;
    const selectedCatalogScenarios = requestedScenarioIds
      ? catalog.scenarios.filter((scenario) => requestedScenarioIds.has(scenario.id))
      : catalog.scenarios;
    if (requestedScenarioIds) {
      const foundScenarioIds = new Set(selectedCatalogScenarios.map((scenario) => scenario.id));
      const missingScenarioIds = [...requestedScenarioIds].filter(
        (scenarioId) => !foundScenarioIds.has(scenarioId),
      );
      if (missingScenarioIds.length > 0) {
        throw new Error(`unknown QA scenario id(s): ${missingScenarioIds.join(", ")}`);
      }
    }
    const scenarios: QaSuiteScenarioResult[] = [];
    const liveScenarioOutcomes: QaLabScenarioOutcome[] = selectedCatalogScenarios.map(
      (scenario) => ({
        id: scenario.id,
        name: scenario.title,
        status: "pending",
      }),
    );

    lab.setScenarioRun({
      kind: "suite",
      status: "running",
      startedAt: startedAt.toISOString(),
      scenarios: liveScenarioOutcomes,
    });

    for (const [index, scenario] of selectedCatalogScenarios.entries()) {
      liveScenarioOutcomes[index] = {
        id: scenario.id,
        name: scenario.title,
        status: "running",
        startedAt: new Date().toISOString(),
      };
      lab.setScenarioRun({
        kind: "suite",
        status: "running",
        startedAt: startedAt.toISOString(),
        scenarios: [...liveScenarioOutcomes],
      });

      const result = await runScenarioDefinition(env, scenario);
      scenarios.push(result);
      liveScenarioOutcomes[index] = {
        id: scenario.id,
        name: scenario.title,
        status: result.status,
        details: result.details,
        steps: result.steps,
        startedAt: liveScenarioOutcomes[index]?.startedAt,
        finishedAt: new Date().toISOString(),
      };
      lab.setScenarioRun({
        kind: "suite",
        status: "running",
        startedAt: startedAt.toISOString(),
        scenarios: [...liveScenarioOutcomes],
      });
    }

    const finishedAt = new Date();
    lab.setScenarioRun({
      kind: "suite",
      status: "completed",
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      scenarios: [...liveScenarioOutcomes],
    });
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
        providerMode === "mock-openai"
          ? "Runs against qa-channel + qa-lab bus + real gateway child + mock OpenAI provider."
          : `Runs against qa-channel + qa-lab bus + real gateway child + live frontier models (${primaryModel}, ${alternateModel})${fastMode ? " with fast mode enabled" : ""}.`,
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
    const latestReport = {
      outputPath: reportPath,
      markdown: report,
      generatedAt: finishedAt.toISOString(),
    } satisfies QaLabLatestReport;
    lab.setLatestReport(latestReport);

    return {
      outputDir,
      reportPath,
      summaryPath,
      report,
      scenarios,
      watchUrl: lab.baseUrl,
    } satisfies QaSuiteResult;
  } finally {
    const keepTemp = process.env.OPENCLAW_QA_KEEP_TEMP === "1" || false;
    await gateway.stop({
      keepTemp,
    });
    await mock?.stop();
    if (ownsLab) {
      await lab.stop();
    } else {
      lab.setControlUi({
        controlUiUrl: null,
        controlUiToken: null,
        controlUiProxyTarget: null,
      });
    }
  }
}
