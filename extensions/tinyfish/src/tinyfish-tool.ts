import { Type } from "@sinclair/typebox";
import { jsonResult, readStringParam, ToolInputError } from "openclaw/plugin-sdk/agent-runtime";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import {
  fetchWithSsrFGuard,
  resolvePinnedHostname,
  SsrFBlockedError,
} from "openclaw/plugin-sdk/infra-runtime";
import {
  normalizeResolvedSecretInputString,
  normalizeSecretInput,
} from "openclaw/plugin-sdk/secret-input";

const DEFAULT_BASE_URL = "https://agent.tinyfish.ai";
const RUN_STREAM_PATH = "v1/automation/run-sse";
const API_INTEGRATION = "openclaw";
const STREAM_TIMEOUT_MS = 15 * 60 * 1000;
const MAX_ERROR_TEXT_BYTES = 2048;

type TinyFishConfig = {
  apiKey: string;
  baseUrl: string;
};

type TinyFishBrowserProfile = "lite" | "stealth";

type TinyFishProxyConfig = {
  enabled: boolean;
  country_code?: string;
};

type TinyFishToolParams = {
  url: string;
  goal: string;
  browser_profile?: TinyFishBrowserProfile;
  proxy_config?: TinyFishProxyConfig;
};

type TinyFishRunResult = {
  run_id: string | null;
  status: string;
  result: unknown;
  error: unknown;
  help_url: string | null;
  help_message: string | null;
  streaming_url: string | null;
};

type TinyFishSseEvent = Record<string, unknown> & {
  type?: unknown;
  run_id?: unknown;
  status?: unknown;
  result?: unknown;
  resultJson?: unknown;
  error?: unknown;
  streaming_url?: unknown;
  url?: unknown;
  help_url?: unknown;
  help_message?: unknown;
};

type GuardedFetch = typeof fetchWithSsrFGuard;
type ResolveHostname = typeof resolvePinnedHostname;

type TinyFishToolDeps = {
  env?: NodeJS.ProcessEnv;
  fetchWithGuard?: GuardedFetch;
  resolveHostname?: ResolveHostname;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function buildBaseUrl(rawBaseUrl: unknown): string {
  const value = readOptionalString(rawBaseUrl) ?? DEFAULT_BASE_URL;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("TinyFish base URL is invalid. Check plugins.entries.tinyfish.config.baseUrl.");
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error(
      "TinyFish base URL must use http or https. Check plugins.entries.tinyfish.config.baseUrl.",
    );
  }
  if (parsed.username || parsed.password) {
    throw new Error(
      "TinyFish base URL must not include embedded credentials. Check plugins.entries.tinyfish.config.baseUrl.",
    );
  }
  if (parsed.search || parsed.hash) {
    throw new Error(
      "TinyFish base URL must not include query parameters or fragments. Check plugins.entries.tinyfish.config.baseUrl.",
    );
  }
  parsed.pathname = parsed.pathname.endsWith("/") ? parsed.pathname : `${parsed.pathname}/`;
  return parsed.toString();
}

function resolveTinyFishConfig(
  pluginConfig: Record<string, unknown> | undefined,
  env: NodeJS.ProcessEnv,
): TinyFishConfig {
  const configRecord = asRecord(pluginConfig) ?? {};
  const apiKey =
    normalizeSecretInput(
      normalizeResolvedSecretInputString({
        value: configRecord.apiKey,
        path: "plugins.entries.tinyfish.config.apiKey",
      }),
    ) ||
    normalizeSecretInput(env.TINYFISH_API_KEY) ||
    undefined;
  if (!apiKey) {
    throw new Error(
      "TinyFish API key missing. Set plugins.entries.tinyfish.config.apiKey or TINYFISH_API_KEY.",
    );
  }
  return {
    apiKey,
    baseUrl: buildBaseUrl(configRecord.baseUrl),
  };
}

function validateTargetUrl(rawUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new ToolInputError("url must be a valid http or https URL");
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new ToolInputError("url must be a valid http or https URL");
  }
  if (parsed.username || parsed.password) {
    throw new ToolInputError("url must not include embedded credentials");
  }
  return parsed.toString();
}

async function assertPublicTargetUrl(
  rawUrl: string,
  resolveHostname: ResolveHostname,
): Promise<void> {
  const parsed = new URL(rawUrl);
  if (parsed.hostname === "") {
    throw new ToolInputError("url must target a public website");
  }
  try {
    await resolveHostname(parsed.hostname);
  } catch (error) {
    if (error instanceof SsrFBlockedError) {
      throw new ToolInputError("url must target a public website");
    }
    throw error;
  }
}

function readBrowserProfile(params: Record<string, unknown>): TinyFishBrowserProfile | undefined {
  const value = readStringParam(params, "browser_profile");
  if (!value) {
    return undefined;
  }
  if (value === "lite" || value === "stealth") {
    return value;
  }
  throw new ToolInputError("browser_profile must be one of: lite, stealth");
}

function readProxyConfig(params: Record<string, unknown>): TinyFishProxyConfig | undefined {
  const raw = params.proxy_config ?? params.proxyConfig;
  if (raw === undefined) {
    return undefined;
  }
  const record = asRecord(raw);
  if (!record) {
    throw new ToolInputError("proxy_config must be an object");
  }
  if (typeof record.enabled !== "boolean") {
    throw new ToolInputError("proxy_config.enabled must be true or false");
  }

  const countryCode = readOptionalString(record.country_code ?? record.countryCode);
  if (countryCode && !/^[A-Za-z]{2}$/.test(countryCode)) {
    throw new ToolInputError("proxy_config.country_code must be a 2-letter country code");
  }

  return {
    enabled: record.enabled,
    ...(countryCode ? { country_code: countryCode.toUpperCase() } : {}),
  };
}

function normalizeTinyFishParams(params: Record<string, unknown>): TinyFishToolParams {
  const browserProfile = readBrowserProfile(params);
  const proxyConfig = readProxyConfig(params);

  return {
    url: validateTargetUrl(readStringParam(params, "url", { required: true })),
    goal: readStringParam(params, "goal", { required: true }),
    ...(browserProfile ? { browser_profile: browserProfile } : {}),
    ...(proxyConfig ? { proxy_config: proxyConfig } : {}),
  };
}

function buildRunEndpoint(baseUrl: string): URL {
  return new URL(RUN_STREAM_PATH, baseUrl);
}

function extractHelpField(
  completeEvent: TinyFishSseEvent,
  field: "help_url" | "help_message",
): string | null {
  const directValue = readOptionalString(completeEvent[field]);
  if (directValue) {
    return directValue;
  }
  const errorRecord = asRecord(completeEvent.error);
  return readOptionalString(errorRecord?.[field]) ?? null;
}

function finalizeRunResult(params: {
  completeEvent: TinyFishSseEvent;
  runId?: string;
  streamingUrl?: string;
}): TinyFishRunResult {
  const status = readOptionalString(params.completeEvent.status) ?? "COMPLETED";
  return {
    run_id: readOptionalString(params.completeEvent.run_id) ?? params.runId ?? null,
    status,
    result: params.completeEvent.result ?? params.completeEvent.resultJson ?? null,
    error: params.completeEvent.error ?? null,
    help_url: extractHelpField(params.completeEvent, "help_url"),
    help_message: extractHelpField(params.completeEvent, "help_message"),
    streaming_url:
      readOptionalString(params.completeEvent.streaming_url) ?? params.streamingUrl ?? null,
  };
}

function parseEventBlock(block: string): TinyFishSseEvent | null {
  const dataLines: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    if (!line || line.startsWith(":")) {
      continue;
    }
    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart());
    }
  }

  if (dataLines.length === 0) {
    return null;
  }

  const payload = dataLines.join("\n").trim();
  if (!payload) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    throw new Error(`TinyFish SSE payload was not valid JSON: ${payload.slice(0, 120)}`);
  }

  const record = asRecord(parsed);
  if (!record) {
    throw new Error("TinyFish SSE payload must be a JSON object");
  }
  return record;
}

async function parseRunStream(
  body: ReadableStream<Uint8Array>,
  logger: OpenClawPluginApi["logger"],
): Promise<TinyFishRunResult> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let runId: string | undefined;
  let streamingUrl: string | undefined;
  let completeEvent: TinyFishSseEvent | null = null;
  let completeReceived = false;

  const handleEvent = (event: TinyFishSseEvent) => {
    const type = readOptionalString(event.type);
    if (type === "STARTED") {
      runId = readOptionalString(event.run_id) ?? runId;
      return;
    }
    if (type === "STREAMING_URL") {
      runId = readOptionalString(event.run_id) ?? runId;
      streamingUrl = readOptionalString(event.streaming_url) ?? readOptionalString(event.url);
      return;
    }
    if (type === "PROGRESS" || type === "HEARTBEAT") {
      logger.debug?.(`[tinyfish] stream event: ${type}`);
      return;
    }
    if (type === "COMPLETE") {
      completeEvent = event;
      completeReceived = true;
      runId = readOptionalString(event.run_id) ?? runId;
      streamingUrl =
        readOptionalString(event.streaming_url) ?? streamingUrl ?? readOptionalString(event.url);
      return;
    }
    logger.debug?.(`[tinyfish] ignoring unknown stream event: ${String(type ?? "unknown")}`);
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });

      let match = /\r?\n\r?\n/.exec(buffer);
      while (match) {
        const block = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        const event = parseEventBlock(block);
        if (event) {
          handleEvent(event);
          if (completeReceived) {
            break;
          }
        }
        match = /\r?\n\r?\n/.exec(buffer);
      }

      if (done || completeReceived) {
        break;
      }
    }
  } finally {
    if (completeReceived) {
      await reader.cancel().catch(() => {});
    }
    reader.releaseLock();
  }

  const finalBlock = buffer.trim();
  if (!completeReceived && finalBlock) {
    const event = parseEventBlock(finalBlock);
    if (event) {
      handleEvent(event);
    }
  }

  if (!completeEvent) {
    const runHint = runId ? ` after run_id ${runId}` : "";
    throw new Error(`TinyFish SSE stream ended before COMPLETE${runHint}. Retry the tool call.`);
  }

  return finalizeRunResult({ completeEvent, runId, streamingUrl });
}

async function readErrorText(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) {
    return "";
  }
  const decoder = new TextDecoder();
  let remainingBytes = MAX_ERROR_TEXT_BYTES;
  let text = "";
  try {
    while (remainingBytes > 0) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (!value || value.byteLength === 0) {
        continue;
      }
      const chunk = value.byteLength > remainingBytes ? value.subarray(0, remainingBytes) : value;
      text += decoder.decode(chunk, { stream: true });
      remainingBytes -= chunk.byteLength;
      if (chunk.byteLength < value.byteLength) {
        await reader.cancel().catch(() => {});
        break;
      }
    }
    text += decoder.decode();
  } catch {
    return text;
  } finally {
    reader.releaseLock();
  }
  if (!text) {
    return "";
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    const record = asRecord(parsed);
    const message =
      readOptionalString(record?.message) ??
      readOptionalString(record?.detail) ??
      readOptionalString(record?.error);
    return message ?? text;
  } catch {
    return text;
  }
}

async function runTinyFishAutomation(
  params: TinyFishToolParams,
  api: OpenClawPluginApi,
  deps: TinyFishToolDeps,
): Promise<TinyFishRunResult> {
  const env = deps.env ?? process.env;
  const config = resolveTinyFishConfig(api.pluginConfig, env);
  const endpoint = buildRunEndpoint(config.baseUrl);
  const fetchWithGuard = deps.fetchWithGuard ?? fetchWithSsrFGuard;
  const resolveHostname = deps.resolveHostname ?? resolvePinnedHostname;

  await assertPublicTargetUrl(params.url, resolveHostname);

  const requestBody: Record<string, unknown> = {
    url: params.url,
    goal: params.goal,
    api_integration: API_INTEGRATION,
  };

  if (params.browser_profile) {
    requestBody.browser_profile = params.browser_profile;
  }
  if (params.proxy_config) {
    requestBody.proxy_config = params.proxy_config;
  }

  const { response, release } = await fetchWithGuard({
    url: endpoint.toString(),
    init: {
      method: "POST",
      headers: {
        Accept: "text/event-stream",
        "Content-Type": "application/json",
        "X-API-Key": config.apiKey,
      },
      body: JSON.stringify(requestBody),
    },
    policy: {
      allowedHostnames: [endpoint.hostname],
    },
    timeoutMs: STREAM_TIMEOUT_MS,
    auditContext: "tinyfish-automation-run-sse",
  });

  try {
    if (!response.ok) {
      const errorText = await readErrorText(response);
      const suffix = errorText ? `: ${errorText}` : "";
      throw new Error(`TinyFish API request failed (${response.status})${suffix}`);
    }
    if (!response.body) {
      throw new Error("TinyFish API returned an empty SSE body");
    }
    return await parseRunStream(response.body, api.logger);
  } finally {
    await release();
  }
}

export function createTinyFishTool(api: OpenClawPluginApi, deps: TinyFishToolDeps = {}) {
  return {
    name: "tinyfish_automation",
    label: "TinyFish Automation",
    description:
      "Run TinyFish hosted browser automation for public multi-step workflows, forms, JS-heavy pages, and structured extraction.",
    parameters: Type.Object({
      url: Type.String({
        description: "Target public website URL to automate.",
      }),
      goal: Type.String({
        description: "Natural-language description of what TinyFish should accomplish.",
      }),
      browser_profile: Type.Optional(
        Type.Unsafe<TinyFishBrowserProfile>({
          type: "string",
          enum: ["lite", "stealth"],
          description: "Optional TinyFish browser profile.",
        }),
      ),
      proxy_config: Type.Optional(
        Type.Object({
          enabled: Type.Boolean({
            description: "Enable or disable TinyFish proxy routing for this run.",
          }),
          country_code: Type.Optional(
            Type.String({
              description: "Optional 2-letter country code, for example US.",
            }),
          ),
        }),
      ),
    }),
    async execute(_id: string, rawParams: Record<string, unknown>) {
      const params = normalizeTinyFishParams(rawParams);
      return jsonResult(await runTinyFishAutomation(params, api, deps));
    },
  };
}
