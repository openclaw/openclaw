import fs from "node:fs/promises";
import path from "node:path";
import { liveTurnTimeoutMs } from "./suite-runtime-agent-common.js";
import type { QaSuiteRuntimeEnv } from "./suite-runtime-types.js";

type QaRuntimeToolFixtureConfig = {
  toolName?: unknown;
  happyPrompt?: unknown;
  failurePrompt?: unknown;
  promptSnippet?: unknown;
  failurePromptSnippet?: unknown;
  ensureImageGeneration?: unknown;
  expectedAvailable?: unknown;
  knownBroken?: unknown;
};

type QaRuntimeToolFixtureRequest = {
  allInputText?: string;
  plannedToolName?: string;
  plannedToolArgs?: unknown;
};

type QaRuntimeToolFixtureDeps = {
  createSession: (
    env: Pick<QaSuiteRuntimeEnv, "gateway" | "primaryModel" | "alternateModel" | "providerMode">,
    label: string,
    key?: string,
  ) => Promise<string>;
  readEffectiveTools: (
    env: Pick<QaSuiteRuntimeEnv, "gateway" | "primaryModel" | "alternateModel" | "providerMode">,
    sessionKey: string,
  ) => Promise<Set<string>>;
  runAgentPrompt: (
    env: Pick<QaSuiteRuntimeEnv, "gateway" | "transport">,
    params: {
      sessionKey: string;
      message: string;
      timeoutMs?: number;
    },
  ) => Promise<unknown>;
  fetchJson: (url: string) => Promise<unknown>;
  ensureImageGenerationConfigured: (env: QaSuiteRuntimeEnv) => Promise<unknown>;
};

function readString(value: unknown, fallback = "") {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
}

function readBoolean(value: unknown, fallback: boolean) {
  return typeof value === "boolean" ? value : fallback;
}

function isKnownBroken(value: unknown) {
  return Boolean(value && typeof value === "object");
}

function isQaRuntimeToolFixtureRequest(value: unknown): value is QaRuntimeToolFixtureRequest {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function readQaRuntimeToolFixtureRequests(value: unknown): QaRuntimeToolFixtureRequest[] {
  return Array.isArray(value) ? value.filter(isQaRuntimeToolFixtureRequest) : [];
}

function requestMatchesPrompt(request: QaRuntimeToolFixtureRequest, promptSnippet: string) {
  return (request.allInputText ?? "").includes(promptSnippet);
}

function findPlannedRequest(params: {
  requests: readonly QaRuntimeToolFixtureRequest[];
  requestCountBefore: number;
  promptSnippet: string;
  toolName: string;
}) {
  return params.requests
    .slice(params.requestCountBefore)
    .find(
      (request) =>
        requestMatchesPrompt(request, params.promptSnippet) &&
        request.plannedToolName === params.toolName,
    );
}

function formatKnownBrokenDetails(
  toolName: string,
  tools: Set<string>,
  config: QaRuntimeToolFixtureConfig,
) {
  const knownBroken = isKnownBroken(config.knownBroken)
    ? (config.knownBroken as Record<string, unknown>)
    : {};
  const issue = readString(knownBroken.issue);
  const reason = readString(knownBroken.reason, "known broken runtime tool fixture");
  return [
    `known-broken ${toolName}: ${reason}`,
    issue ? `tracking: ${issue}` : undefined,
    `available tools: ${[...tools].toSorted().join(", ")}`,
  ]
    .filter(Boolean)
    .join("\n");
}

export async function runRuntimeToolFixture(
  env: QaSuiteRuntimeEnv,
  config: QaRuntimeToolFixtureConfig,
  deps: QaRuntimeToolFixtureDeps,
) {
  const toolName = readString(config.toolName);
  if (!toolName) {
    throw new Error("runtime tool fixture missing execution.config.toolName");
  }
  if (config.ensureImageGeneration === true) {
    await deps.ensureImageGenerationConfigured(env);
  }
  await fs.writeFile(
    path.join(env.gateway.workspaceDir, "runtime-tool-fixture-edit.txt"),
    "before edit\n",
    "utf8",
  );

  const sessionKey = await deps.createSession(env, `Runtime tool fixture: ${toolName}`);
  const tools = await deps.readEffectiveTools(env, sessionKey);
  const expectedAvailable = readBoolean(config.expectedAvailable, true);
  if (!tools.has(toolName)) {
    if (!expectedAvailable || isKnownBroken(config.knownBroken)) {
      return formatKnownBrokenDetails(toolName, tools, config);
    }
    throw new Error(
      `${toolName} not present in effective tools. Available tools: ${[...tools].toSorted().join(", ")}`,
    );
  }

  const happyPrompt = readString(
    config.happyPrompt,
    `tool search qa check target=${toolName}. Call exactly that tool once and then summarize.`,
  );
  const failurePrompt = readString(
    config.failurePrompt,
    `tool search qa failure target=${toolName}. Exercise the denied-input path once and then summarize.`,
  );
  const promptSnippet = readString(config.promptSnippet, `target=${toolName}`);
  const failurePromptSnippet = readString(
    config.failurePromptSnippet,
    `failure target=${toolName}`,
  );
  const requestCountBefore = env.mock
    ? readQaRuntimeToolFixtureRequests(await deps.fetchJson(`${env.mock.baseUrl}/debug/requests`))
        .length
    : 0;

  await deps.runAgentPrompt(env, {
    sessionKey: `agent:qa:runtime-tool:${toolName}:happy`,
    message: happyPrompt,
    timeoutMs: liveTurnTimeoutMs(env, 45_000),
  });
  await deps.runAgentPrompt(env, {
    sessionKey: `agent:qa:runtime-tool:${toolName}:failure`,
    message: failurePrompt,
    timeoutMs: liveTurnTimeoutMs(env, 45_000),
  });

  if (!env.mock) {
    return `${toolName} fixture completed in live provider mode`;
  }

  const requests = readQaRuntimeToolFixtureRequests(
    await deps.fetchJson(`${env.mock.baseUrl}/debug/requests`),
  );
  const happyRequest = findPlannedRequest({
    requests,
    requestCountBefore,
    promptSnippet,
    toolName,
  });
  if (!happyRequest) {
    throw new Error(`expected mock happy-path request for ${toolName}`);
  }
  const failureRequest = findPlannedRequest({
    requests,
    requestCountBefore,
    promptSnippet: failurePromptSnippet,
    toolName,
  });
  if (!failureRequest) {
    throw new Error(`expected mock failure-path request for ${toolName}`);
  }

  return [
    `${toolName} happy planned args: ${JSON.stringify(happyRequest.plannedToolArgs ?? {})}`,
    `${toolName} failure planned args: ${JSON.stringify(failureRequest.plannedToolArgs ?? {})}`,
  ].join("\n");
}
