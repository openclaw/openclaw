// Qa Lab plugin module implements Tool Search gateway flow fixture behavior.
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { clearTimeout as clearNodeTimeout, setTimeout as setNodeTimeout } from "node:timers";
import { pathToFileURL } from "node:url";
import type { QaSuiteRuntimeEnv } from "./suite-runtime-types.js";

type Lane = "normal" | "code";

type FetchJsonOptions = {
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
  maxBodyBytes?: number;
  timeoutMs?: number;
};

type LaneResult = {
  lane: Lane;
  status: string;
  providerRequestCount: number;
  providerRawBytes: number;
  providerSystemPromptChars: number;
  providerInputSnippet: string;
  providerToolOutputSnippet: string;
  providerDeclaredToolCount: number;
  providerPlannedTools: string[];
  gatewayOutputToolNames: string[];
  gatewayOutputText: string;
  sessionLogToolMentions: Record<string, number>;
};

type LaneResultSummary = Pick<
  LaneResult,
  | "providerDeclaredToolCount"
  | "providerPlannedTools"
  | "providerRawBytes"
  | "gatewayOutputText"
  | "sessionLogToolMentions"
> & {
  providerInputSnippet?: string;
  providerToolOutputSnippet?: string;
};

type ToolSearchGatewayFixture = {
  fakePluginDir: string;
  targetTool: string;
};

const FAKE_PLUGIN_ID = "tool-search-e2e-fixture";

export type ToolSearchGatewayFetchLimits = {
  bodyMaxBytes: number;
  timeoutMs: number;
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

export function readToolSearchGatewayFetchLimits(
  env: NodeJS.ProcessEnv = process.env,
): ToolSearchGatewayFetchLimits {
  return {
    bodyMaxBytes: readPositiveIntEnv(
      "OPENCLAW_TOOL_SEARCH_GATEWAY_E2E_FETCH_BODY_MAX_BYTES",
      1024 * 1024,
      env,
    ),
    timeoutMs: readPositiveIntEnv(
      "OPENCLAW_TOOL_SEARCH_GATEWAY_E2E_FETCH_TIMEOUT_MS",
      180_000,
      env,
    ),
  };
}

function readPositiveIntEnv(name: string, fallback: number, env: NodeJS.ProcessEnv) {
  const raw = env[name] ?? fallback;
  const text = raw == null ? "unset" : String(raw).trim();
  if (!/^\d+$/u.test(text)) {
    throw new Error(`invalid ${name}: ${text}`);
  }
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`invalid ${name}: ${text}`);
  }
  return value;
}

const DEFAULT_FETCH_LIMITS = readToolSearchGatewayFetchLimits();

function timeoutError(message: string) {
  return Object.assign(new Error(message), { code: "ETIMEDOUT" });
}

function bodyTooLargeErrorMessage(url: string, byteLimit: number) {
  return `HTTP response from ${url} exceeded ${byteLimit} bytes`;
}

function cancelReaderSoon(reader: ReadableStreamDefaultReader<Uint8Array>) {
  void Promise.resolve()
    .then(() => reader.cancel())
    .catch(() => undefined);
}

async function readBoundedResponseText(params: {
  response: Response;
  url: string;
  maxBytes: number;
  timeoutPromise: Promise<never>;
  signal: AbortSignal;
}) {
  const tooLargeError = () =>
    Object.assign(new Error(bodyTooLargeErrorMessage(params.url, params.maxBytes)), {
      code: "ETOOBIG",
    });
  const contentLength = params.response.headers.get("content-length");
  if (contentLength && /^\d+$/u.test(contentLength) && Number(contentLength) > params.maxBytes) {
    await params.response.body?.cancel().catch(() => undefined);
    throw tooLargeError();
  }
  if (!params.response.body) {
    return "";
  }

  const reader = params.response.body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let totalBytes = 0;
  let canceled = false;
  try {
    for (;;) {
      const readPromise = reader.read();
      const abortPromise = new Promise<never>((_resolve, reject) => {
        const onAbort = () => {
          canceled = true;
          cancelReaderSoon(reader);
          reject(
            params.signal.reason instanceof Error
              ? params.signal.reason
              : new Error(`HTTP request to ${params.url} aborted`),
          );
        };
        params.signal.addEventListener("abort", onAbort, { once: true });
        readPromise.finally(() => params.signal.removeEventListener("abort", onAbort));
      });
      const { done, value } = await Promise.race([
        readPromise,
        abortPromise,
        params.timeoutPromise,
      ]);
      if (done) {
        const tail = decoder.decode();
        if (tail) {
          chunks.push(tail);
        }
        break;
      }
      totalBytes += value.byteLength;
      if (totalBytes > params.maxBytes) {
        canceled = true;
        await reader.cancel().catch(() => undefined);
        throw tooLargeError();
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
  } finally {
    if (!canceled) {
      reader.releaseLock();
    }
  }
  return chunks.join("");
}

function buildFakeTools(count = 36) {
  return Array.from({ length: count }, (_, index) => {
    const id = `fake_plugin_tool_${String(index + 1).padStart(2, "0")}`;
    return {
      type: "function",
      name: id,
      description: [
        `Fake plugin tool ${index + 1}.`,
        "Used by the Tool Search gateway E2E to prove a large plugin-owned tool catalog can be hidden from the model prompt and still called through the compact bridge.",
        "The description is intentionally non-trivial so prompt-size regression is measurable.",
      ].join(" "),
      parameters: {
        type: "object",
        properties: {
          marker: {
            type: "string",
            description: "Lane marker supplied by the scripted model.",
          },
        },
        required: ["marker"],
        additionalProperties: false,
      },
      strict: true,
    };
  });
}

async function countNeedlesInFile(filePath: string, needles: Record<string, string>) {
  const text = await fs.readFile(filePath, "utf8").catch(() => "");
  const counts = Object.fromEntries(Object.keys(needles).map((key) => [key, 0]));
  for (const line of text.split(/\r?\n/u)) {
    if (!shouldScanSessionLogLine(line)) {
      continue;
    }
    for (const [key, needle] of Object.entries(needles)) {
      counts[key] += countOccurrences(line, needle);
    }
  }
  return counts;
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) {
    return 0;
  }
  let count = 0;
  let offset = 0;
  for (;;) {
    const next = haystack.indexOf(needle, offset);
    if (next < 0) {
      return count;
    }
    count += 1;
    offset = next + needle.length;
  }
}

function recordRole(record: unknown): string | undefined {
  if (!record || typeof record !== "object") {
    return undefined;
  }
  const candidate = record as { message?: unknown; role?: unknown };
  if (typeof candidate.role === "string") {
    return candidate.role;
  }
  if (!candidate.message || typeof candidate.message !== "object") {
    return undefined;
  }
  const message = candidate.message as { role?: unknown };
  return typeof message.role === "string" ? message.role : undefined;
}

function shouldScanSessionLogLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) {
    return false;
  }
  try {
    return recordRole(JSON.parse(trimmed)) !== "user";
  } catch {
    return true;
  }
}

export async function countSessionLogMentions(params: {
  stateDir: string;
  targetTool: string;
}): Promise<Record<string, number>> {
  const sessionsDir = path.join(params.stateDir, "agents", "qa", "sessions");
  const needles = {
    tool_search_code: "tool_search_code",
    [params.targetTool]: params.targetTool,
  };
  const counts: Record<string, number> = Object.fromEntries(
    Object.keys(needles).map((key) => [key, 0]),
  );
  const files = await fs.readdir(sessionsDir, { recursive: true }).catch(() => []);
  for (const file of files) {
    if (typeof file !== "string" || !file.endsWith(".jsonl")) {
      continue;
    }
    const fileCounts = await countNeedlesInFile(path.join(sessionsDir, file), needles);
    for (const [key, count] of Object.entries(fileCounts)) {
      counts[key] = (counts[key] ?? 0) + count;
    }
  }
  return counts;
}

function subtractMentionCounts(
  after: Record<string, number>,
  before: Record<string, number>,
): Record<string, number> {
  return Object.fromEntries(
    Object.entries(after).map(([key, count]) => [key, count - (before[key] ?? 0)]),
  );
}

export async function fetchJson(
  url: string,
  init: RequestInit = {},
  options: FetchJsonOptions = {},
): Promise<unknown> {
  const timeoutMs = Math.max(1, options.timeoutMs ?? DEFAULT_FETCH_LIMITS.timeoutMs);
  const maxBodyBytes = Math.max(1, options.maxBodyBytes ?? DEFAULT_FETCH_LIMITS.bodyMaxBytes);
  const controller = new AbortController();
  const error = timeoutError(`HTTP request to ${url} timed out after ${timeoutMs}ms`);
  let timeout: ReturnType<typeof setNodeTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setNodeTimeout(() => {
      controller.abort(error);
      reject(error);
    }, timeoutMs);
  });

  let response: Response;
  let text: string;
  try {
    response = await Promise.race([
      (options.fetchImpl ?? fetch)(url, {
        ...init,
        signal: controller.signal,
      }),
      timeoutPromise,
    ]);
    text = await readBoundedResponseText({
      response,
      url,
      maxBytes: maxBodyBytes,
      timeoutPromise,
      signal: controller.signal,
    });
  } finally {
    if (timeout) {
      clearNodeTimeout(timeout);
    }
  }
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = text;
  }
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${url}: ${text}`);
  }
  return parsed;
}

function outputToolNames(response: unknown): string[] {
  const output = (response as { output?: Array<{ type?: unknown; name?: unknown }> }).output;
  if (!Array.isArray(output)) {
    return [];
  }
  return output
    .filter((item) => item.type === "function_call" && typeof item.name === "string")
    .map((item) => item.name as string);
}

function outputText(response: unknown): string {
  const output = (response as { output?: Array<{ type?: unknown; content?: unknown }> }).output;
  if (!Array.isArray(output)) {
    return "";
  }
  return output
    .flatMap((item) => {
      if (item.type !== "message" || !Array.isArray(item.content)) {
        return [];
      }
      return item.content.flatMap((piece) => {
        if (!piece || typeof piece !== "object") {
          return [];
        }
        const record = piece as { text?: unknown };
        return typeof record.text === "string" ? [record.text] : [];
      });
    })
    .join("\n");
}

function readContentText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((item) => {
      if (!item || typeof item !== "object") {
        return "";
      }
      const record = item as { type?: unknown; text?: unknown };
      return typeof record.text === "string" ? record.text : "";
    })
    .join("\n");
}

function countSystemPromptChars(body: unknown): number {
  if (!body || typeof body !== "object") {
    return 0;
  }
  const record = body as { instructions?: unknown; input?: unknown };
  let total = typeof record.instructions === "string" ? record.instructions.length : 0;
  if (Array.isArray(record.input)) {
    for (const item of record.input) {
      if (!item || typeof item !== "object") {
        continue;
      }
      const inputRecord = item as { role?: unknown; content?: unknown };
      if (inputRecord.role === "system" || inputRecord.role === "developer") {
        total += readContentText(inputRecord.content).length;
      }
    }
  }
  return total;
}

async function writeFakePlugin(params: {
  rootDir: string;
  repoRoot: string;
  fakeTools: ReturnType<typeof buildFakeTools>;
}): Promise<string> {
  const pluginDir = path.join(params.rootDir, "tool-search-fake-plugin");
  await fs.mkdir(pluginDir, { recursive: true });
  await fs.writeFile(
    path.join(pluginDir, "package.json"),
    `${JSON.stringify(
      {
        name: "@openclaw/tool-search-e2e-fixture",
        version: "0.0.0",
        type: "module",
        openclaw: {
          extensions: ["./index.js"],
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await fs.writeFile(
    path.join(pluginDir, "openclaw.plugin.json"),
    `${JSON.stringify(
      {
        id: FAKE_PLUGIN_ID,
        activation: {
          onStartup: true,
        },
        name: "Tool Search E2E Fixture",
        description: "Fake plugin with a large tool catalog for Tool Search gateway validation.",
        contracts: {
          tools: params.fakeTools.map((tool) => tool.name),
        },
        configSchema: {
          type: "object",
          additionalProperties: false,
          properties: {},
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  const pluginEntryUrl = pathToFileURL(
    path.join(params.repoRoot, "src/plugin-sdk/plugin-entry.ts"),
  ).href;
  await fs.writeFile(
    path.join(pluginDir, "index.js"),
    [
      `import { definePluginEntry } from ${JSON.stringify(pluginEntryUrl)};`,
      `const tools = ${JSON.stringify(params.fakeTools, null, 2)};`,
      "export default definePluginEntry({",
      `  id: ${JSON.stringify(FAKE_PLUGIN_ID)},`,
      "  name: 'Tool Search E2E Fixture',",
      "  register(api) {",
      "    for (const spec of tools) {",
      "      api.registerTool({",
      "        name: spec.name,",
      "        label: spec.name,",
      "        description: spec.description,",
      "        parameters: spec.parameters,",
      "        execute: async (_toolCallId, input) => ({",
      "          content: [{ type: 'text', text: `FAKE_PLUGIN_OK ${spec.name} ${JSON.stringify(input ?? {})}` }],",
      "          details: { status: 'ok', tool: spec.name, input },",
      "        }),",
      "      }, { name: spec.name });",
      "    }",
      "  },",
      "});",
      "",
    ].join("\n"),
    "utf8",
  );
  return pluginDir;
}

function applyLaneConfig(
  config: Record<string, unknown>,
  params: { lane: Lane; fakePluginDir: string },
) {
  const cfg = structuredClone(config);
  const plugins = (cfg.plugins && typeof cfg.plugins === "object" ? cfg.plugins : {}) as Record<
    string,
    unknown
  >;
  const pluginEntries =
    plugins.entries && typeof plugins.entries === "object"
      ? (plugins.entries as Record<string, unknown>)
      : {};
  const pluginLoad =
    plugins.load && typeof plugins.load === "object"
      ? (plugins.load as Record<string, unknown>)
      : {};
  cfg.plugins = {
    ...plugins,
    allow: [...new Set([...(Array.isArray(plugins.allow) ? plugins.allow : []), FAKE_PLUGIN_ID])],
    slots: {
      ...(plugins.slots && typeof plugins.slots === "object" ? plugins.slots : {}),
      memory: "none",
    },
    entries: {
      ...pluginEntries,
      [FAKE_PLUGIN_ID]: { enabled: true },
    },
    load: {
      ...pluginLoad,
      paths: [
        ...new Set([
          ...(Array.isArray(pluginLoad.paths) ? pluginLoad.paths : []),
          params.fakePluginDir,
        ]),
      ],
    },
  };

  const agents = (cfg.agents && typeof cfg.agents === "object" ? cfg.agents : {}) as Record<
    string,
    unknown
  >;
  const defaults =
    agents.defaults && typeof agents.defaults === "object"
      ? (agents.defaults as Record<string, unknown>)
      : {};
  const memorySearch =
    defaults.memorySearch && typeof defaults.memorySearch === "object"
      ? (defaults.memorySearch as Record<string, unknown>)
      : {};
  cfg.agents = {
    ...agents,
    defaults: {
      ...defaults,
      memorySearch: {
        ...memorySearch,
        enabled: false,
        sync: {
          ...(memorySearch.sync && typeof memorySearch.sync === "object" ? memorySearch.sync : {}),
          onSearch: false,
          onSessionStart: false,
          watch: false,
        },
      },
    },
  };

  const tools = (cfg.tools && typeof cfg.tools === "object" ? cfg.tools : {}) as Record<
    string,
    unknown
  >;
  cfg.tools = {
    ...tools,
    alsoAllow: [
      ...new Set([
        ...(Array.isArray(tools.alsoAllow) ? tools.alsoAllow : []),
        FAKE_PLUGIN_ID,
        ...(params.lane === "code"
          ? ["tool_search_code", "tool_search", "tool_describe", "tool_call"]
          : []),
      ]),
    ],
    toolSearch: params.lane === "code" ? true : false,
  };

  const gateway = (cfg.gateway && typeof cfg.gateway === "object" ? cfg.gateway : {}) as Record<
    string,
    unknown
  >;
  const gatewayHttp =
    gateway.http && typeof gateway.http === "object"
      ? (gateway.http as Record<string, unknown>)
      : {};
  const endpoints =
    gatewayHttp.endpoints && typeof gatewayHttp.endpoints === "object"
      ? (gatewayHttp.endpoints as Record<string, unknown>)
      : {};
  cfg.gateway = {
    ...gateway,
    http: {
      ...gatewayHttp,
      endpoints: {
        ...endpoints,
        responses: { enabled: true },
      },
    },
  };

  return cfg;
}

async function configureLane(params: {
  env: QaSuiteRuntimeEnv;
  fixture: ToolSearchGatewayFixture;
  lane: Lane;
}) {
  assert(
    params.env.gateway.restartAfterStateMutation,
    "qa gateway child cannot restart after state mutation",
  );
  await params.env.gateway.restartAfterStateMutation(async ({ configPath }) => {
    const raw = await fs.readFile(configPath, "utf8");
    const config = JSON.parse(raw || "{}") as Record<string, unknown>;
    const next = applyLaneConfig(config, {
      fakePluginDir: params.fixture.fakePluginDir,
      lane: params.lane,
    });
    await fs.writeFile(configPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  });
}

export async function stageToolSearchGatewayFixture(params: {
  env: QaSuiteRuntimeEnv;
  targetTool?: string;
  toolCount?: number;
}): Promise<ToolSearchGatewayFixture> {
  const fakeTools = buildFakeTools(params.toolCount ?? 36);
  return {
    fakePluginDir: await writeFakePlugin({
      rootDir: params.env.gateway.tempRoot,
      repoRoot: params.env.repoRoot,
      fakeTools,
    }),
    targetTool: params.targetTool ?? "fake_plugin_tool_17",
  };
}

export async function runToolSearchGatewayLane(params: {
  env: QaSuiteRuntimeEnv;
  fixture: ToolSearchGatewayFixture;
  lane: Lane;
}): Promise<LaneResult> {
  const providerBaseUrl = params.env.mock?.baseUrl;
  assert(providerBaseUrl, "Tool Search gateway fixture requires mock-openai provider mode");
  const gatewayToken = params.env.gateway.runtimeEnv.OPENCLAW_GATEWAY_TOKEN;
  assert(gatewayToken, "Tool Search gateway fixture requires QA gateway token");
  await configureLane(params);
  const stateDir = path.join(params.env.gateway.tempRoot, "state");
  const mentionCountsBefore = await countSessionLogMentions({
    stateDir,
    targetTool: params.fixture.targetTool,
  });
  const beforeRequests = (await fetchJson(`${providerBaseUrl}/debug/requests`)) as unknown[];
  const response = await fetchJson(`${params.env.gateway.baseUrl}/v1/responses`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${gatewayToken}`,
      "content-type": "application/json",
      "x-openclaw-scopes": "operator.write",
      "x-openclaw-agent": "qa",
      "x-openclaw-session-key": `tool-search-gateway-${params.lane}`,
    },
    body: JSON.stringify({
      model: "openclaw/qa",
      input: [
        {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_text",
              text: `tool search qa check target=${params.fixture.targetTool}`,
            },
          ],
        },
      ],
      max_output_tokens: 256,
      stream: false,
    }),
  });
  const requests = (await fetchJson(`${providerBaseUrl}/debug/requests`)) as Array<{
    raw?: string;
    body?: { tools?: unknown[] };
    instructions?: string;
    allInputText?: string;
    prompt?: string;
    toolOutput?: string;
    plannedToolName?: string;
  }>;
  const laneRequests = requests.slice(beforeRequests.length);
  const lastRequest = laneRequests.at(-1) ?? {};
  const responseStatus = (response as { status?: unknown }).status;
  const mentionCountsAfter = await countSessionLogMentions({
    stateDir,
    targetTool: params.fixture.targetTool,
  });
  return {
    lane: params.lane,
    status: typeof responseStatus === "string" ? responseStatus : "",
    providerRequestCount: laneRequests.length,
    providerRawBytes: typeof lastRequest.raw === "string" ? lastRequest.raw.length : 0,
    providerSystemPromptChars: countSystemPromptChars(lastRequest.body),
    providerInputSnippet: String(lastRequest.allInputText ?? lastRequest.prompt ?? "").slice(
      0,
      500,
    ),
    providerToolOutputSnippet: String(lastRequest.toolOutput ?? "").slice(0, 4_000),
    providerDeclaredToolCount: Array.isArray(lastRequest.body?.tools)
      ? lastRequest.body.tools.length
      : 0,
    providerPlannedTools: laneRequests
      .map((request) => request.plannedToolName)
      .filter((name): name is string => typeof name === "string"),
    gatewayOutputToolNames: outputToolNames(response),
    gatewayOutputText: outputText(response),
    sessionLogToolMentions: subtractMentionCounts(mentionCountsAfter, mentionCountsBefore),
  };
}

export function assertToolSearchLaneResults(params: {
  normal: LaneResultSummary;
  code: LaneResultSummary;
  targetTool: string;
}) {
  const { code, normal, targetTool } = params;
  const laneDebug = () =>
    JSON.stringify(
      {
        normal: {
          plannedTools: normal.providerPlannedTools,
          declaredToolCount: normal.providerDeclaredToolCount,
          input: normal.providerInputSnippet,
          toolOutput: normal.providerToolOutputSnippet,
          output: normal.gatewayOutputText.slice(0, 300),
          mentions: normal.sessionLogToolMentions,
        },
        code: {
          plannedTools: code.providerPlannedTools,
          declaredToolCount: code.providerDeclaredToolCount,
          input: code.providerInputSnippet,
          toolOutput: code.providerToolOutputSnippet,
          output: code.gatewayOutputText.slice(0, 300),
          mentions: code.sessionLogToolMentions,
        },
      },
      null,
      2,
    );
  assert(
    normal.providerPlannedTools.includes(targetTool) &&
      normal.gatewayOutputText.includes("FAKE_PLUGIN_OK") &&
      normal.gatewayOutputText.includes(targetTool) &&
      normal.sessionLogToolMentions[targetTool] > 0,
    `normal lane did not call ${targetTool}: ${laneDebug()}`,
  );
  assert(
    code.providerPlannedTools.includes("tool_search_code") &&
      code.gatewayOutputText.includes("FAKE_PLUGIN_OK") &&
      code.gatewayOutputText.includes(targetTool) &&
      code.sessionLogToolMentions[targetTool] > 0,
    `code lane did not bridge-call ${targetTool}: ${laneDebug()}`,
  );
  assert(
    !code.providerPlannedTools.includes(targetTool),
    `code lane exposed direct provider tool ${targetTool}: ${laneDebug()}`,
  );
  assert(
    normal.providerDeclaredToolCount > code.providerDeclaredToolCount,
    `expected Tool Search to expose fewer tools to provider: normal=${normal.providerDeclaredToolCount} code=${code.providerDeclaredToolCount}`,
  );
  assert(
    normal.providerRawBytes > code.providerRawBytes,
    `expected Tool Search request to be smaller: normal=${normal.providerRawBytes} code=${code.providerRawBytes}`,
  );
  assert(
    code.sessionLogToolMentions.tool_search_code > 0 && code.sessionLogToolMentions[targetTool] > 0,
    "code lane session log did not record bridge and target tool mentions",
  );
  assert(
    !normal.providerPlannedTools.includes("tool_search_code"),
    "normal lane unexpectedly used Tool Search bridge",
  );
}
