import { createHash } from "node:crypto";
import { resolveAgentProfile } from "../src/agents/agent-profiles.js";
import { buildOpenAICompletionsParams } from "../src/agents/openai-transport-stream.js";
import {
  buildInboundUserContextPrefix,
  buildCompactInboundUserContextPrefix,
} from "../src/auto-reply/reply/inbound-meta.js";
import type { TemplateContext } from "../src/auto-reply/templating.js";
import type { Context, Model } from "../src/llm/types.js";

const DEFAULT_BASE_URL = "http://127.0.0.1:8080";
const MODEL_ID = "qwen3.6-35b-a3b";
const ORDINARY_TURN_MAX_TOKENS = 80;
const FRESH_MIN_ABSOLUTE_SAVINGS = 500;
const FRESH_MIN_RELATIVE_SAVINGS = 0.15;
const TOOL_MIN_ABSOLUTE_SAVINGS = 100;

type ProviderPayload = {
  messages: unknown[];
  tools?: unknown[];
};

type Count = {
  promptChars: number;
  tokens: number;
  requestSha256: string;
};

type Comparison = {
  default: Count;
  compact: Count;
  savedTokens: number;
  reduction: number;
};

const model: Model<"openai-completions"> = {
  id: MODEL_ID,
  name: "Qwen3.6 35B A3B",
  api: "openai-completions",
  provider: "llama-cpp",
  baseUrl: `${DEFAULT_BASE_URL}/v1`,
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 65_536,
  maxTokens: 4_096,
};

const tools: NonNullable<Context["tools"]> = [
  {
    name: "read",
    description: "Read a file from the workspace.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" }, offset: { type: "number" } },
      required: ["path"],
    },
  },
  {
    name: "exec",
    description: "Run a command in the workspace.",
    parameters: {
      type: "object",
      properties: { command: { type: "string" }, cwd: { type: "string" } },
      required: ["command"],
    },
  },
  {
    name: "tool_search",
    description: "Find a deferred tool.",
    parameters: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    },
  },
  {
    name: "tool_describe",
    description: "Describe a deferred tool.",
    parameters: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    },
  },
  {
    name: "tool_call",
    description: "Call a deferred tool.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string" },
        arguments: { type: "object", additionalProperties: true },
      },
      required: ["name", "arguments"],
    },
  },
  {
    name: "message",
    description: "Send a message through the active delivery channel.",
    parameters: {
      type: "object",
      properties: { text: { type: "string" }, replyTo: { type: "string" } },
      required: ["text"],
    },
  },
];

const emptyUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function parseBaseUrl() {
  const index = process.argv.indexOf("--base-url");
  if (index === -1) {
    return DEFAULT_BASE_URL;
  }
  const value = process.argv[index + 1]?.trim();
  if (!value) {
    throw new Error("--base-url requires a value");
  }
  return value.replace(/\/$/u, "");
}

function buildSystemPrompt() {
  // The benchmark measures the small profile. The model name does not select it, so pin it.
  const resolvedProfile = resolveAgentProfile({
    config: { agents: { defaults: { agentProfileId: "openclaw/small" } } },
  });
  if (resolvedProfile.profile.id !== "openclaw/small") {
    throw new Error("the benchmark must resolve to openclaw/small");
  }
  // Keep conversation-serialization gates independent from workspace prompt
  // composition. Prompt composition has separate focused tests and budgets.
  const systemPrompt = "You are a personal assistant running inside OpenClaw.";
  return { profileId: resolvedProfile.profile.id, systemPrompt };
}

function buildPayload(params: {
  systemPrompt: string;
  messages: Context["messages"];
}): ProviderPayload {
  const payload = buildOpenAICompletionsParams(
    model,
    { systemPrompt: params.systemPrompt, messages: params.messages, tools },
    undefined,
  );
  if (!Array.isArray(payload["messages"])) {
    throw new Error("provider request did not contain messages");
  }
  return {
    messages: payload["messages"],
    ...(Array.isArray(payload["tools"]) ? { tools: payload["tools"] } : {}),
  };
}

function buildCarrier(ctx: TemplateContext, mode: "default" | "compact") {
  const defaultText = buildInboundUserContextPrefix(ctx);
  const compact = buildCompactInboundUserContextPrefix(ctx);
  const runtimeContext = mode === "compact" ? compact.text : defaultText;
  return {
    content: runtimeContext,
    stats: {
      defaultChars: defaultText.length,
      compactChars: compact.text.length,
      removedSessionMessages: compact.removedSessionMessages,
      deduplicatedMessages: compact.deduplicatedMessages,
    },
  };
}

function withCurrentTurn(params: {
  messages: Context["messages"];
  ctx: TemplateContext;
  prompt: string;
  mode: "default" | "compact";
}): Context["messages"] {
  const carrier = buildCarrier(params.ctx, params.mode);
  return [
    ...params.messages,
    {
      role: "user",
      content: carrier.content,
      timestamp: 20,
      runtimeContextCarrier: true,
    },
    { role: "user", content: params.prompt, timestamp: 21 },
  ];
}

async function fetchJson(baseUrl: string, path: string, init?: RequestInit) {
  const response = await fetch(`${baseUrl}${path}`, init);
  if (!response.ok) {
    throw new Error(`${path} failed with HTTP ${response.status}: ${await response.text()}`);
  }
  return (await response.json()) as Record<string, unknown>;
}

async function countPayload(baseUrl: string, payload: ProviderPayload): Promise<Count> {
  const template = await fetchJson(baseUrl, "/apply-template", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL_ID, ...payload }),
  });
  const prompt = template["prompt"];
  if (typeof prompt !== "string") {
    throw new Error("/apply-template did not return a prompt string");
  }
  const tokenized = await fetchJson(baseUrl, "/tokenize", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: prompt }),
  });
  const tokens = tokenized["tokens"];
  if (!Array.isArray(tokens)) {
    throw new Error("/tokenize did not return a token array");
  }
  return {
    promptChars: prompt.length,
    tokens: tokens.length,
    requestSha256: createHash("sha256").update(JSON.stringify(payload)).digest("hex"),
  };
}

async function compare(params: {
  baseUrl: string;
  systemPrompt: string;
  messages: Context["messages"];
  ctx: TemplateContext;
  prompt: string;
}): Promise<Comparison> {
  const defaultPayload = buildPayload({
    systemPrompt: params.systemPrompt,
    messages: withCurrentTurn({ ...params, mode: "default" }),
  });
  const compactPayload = buildPayload({
    systemPrompt: params.systemPrompt,
    messages: withCurrentTurn({ ...params, mode: "compact" }),
  });
  const [defaultCount, compactCount] = await Promise.all([
    countPayload(params.baseUrl, defaultPayload),
    countPayload(params.baseUrl, compactPayload),
  ]);
  const savedTokens = defaultCount.tokens - compactCount.tokens;
  return {
    default: defaultCount,
    compact: compactCount,
    savedTokens,
    reduction: defaultCount.tokens > 0 ? savedTokens / defaultCount.tokens : 0,
  };
}

function ordinaryFixture(): TemplateContext {
  return {
    ChatType: "direct",
    MessageSid: "discord-current-4",
    SenderName: "Onur",
    SenderId: "user-onur",
    Timestamp: 1_787_823_540_000,
    OriginatingTo: "discord:dm:user-onur",
    OriginatingChannel: "discord",
    Provider: "discord",
    Surface: "discord",
    AccountId: "default",
  } as TemplateContext;
}

function freshDiscordFixture(): TemplateContext {
  return {
    ChatType: "group",
    MessageSid: "discord-current-fresh",
    SenderName: "Onur",
    SenderId: "user-onur",
    Timestamp: 1_787_823_540_000,
    OriginatingTo: "discord:channel:synthetic",
    OriginatingChannel: "discord",
    Provider: "discord",
    Surface: "discord",
    WasMentioned: true,
    InboundHistory: Array.from({ length: 20 }, (_, index) => ({
      sender: index % 2 === 0 ? "Alice" : "Bob",
      body: `Synthetic backlog message ${index + 1} with enough text to represent a normal Discord sentence.`,
      timestamp: 1_787_820_000_000 + index * 60_000,
      messageId: `discord-backlog-${index + 1}`,
    })),
  } as TemplateContext;
}

function multiUserReplyFixture(): TemplateContext {
  return {
    ChatType: "group",
    MessageSid: "discord-current-reply",
    SenderName: "Onur",
    SenderId: "user-onur",
    ReplyToId: "discord-assistant-3",
    ReplyToBody: "Earlier assistant answer",
    ReplyToSender: "Bob",
    MessageThreadId: "discord-thread-42",
    WasMentioned: true,
    OriginatingTo: "discord:channel:synthetic",
    OriginatingChannel: "discord",
    Provider: "discord",
    Surface: "discord",
    InboundHistory: [
      { sender: "Alice", body: "same text", messageId: "discord-alice-1" },
      { sender: "Bob", body: "same text", messageId: "discord-bob-1" },
    ],
  } as TemplateContext;
}

function assertCapabilities() {
  const multiUserCompact = buildCompactInboundUserContextPrefix(multiUserReplyFixture()).text;
  const requiredFragments = [
    '"reply_to_id":"discord-assistant-3"',
    '"thread_id":"discord-thread-42"',
    '"was_mentioned":true',
    "#discord-alice-1 Alice: same text",
    "#discord-bob-1 Bob: same text",
    'Reply target: {"sender":"Bob","body":"Earlier assistant answer"}',
  ];
  const missing = requiredFragments.filter((fragment) => !multiUserCompact.includes(fragment));
  if (missing.length > 0) {
    throw new Error(`compact capability fixture lost required context: ${missing.join(", ")}`);
  }
}

async function main() {
  const baseUrl = parseBaseUrl();
  const [{ profileId, systemPrompt }, models, props] = await Promise.all([
    Promise.resolve(buildSystemPrompt()),
    fetchJson(baseUrl, "/v1/models"),
    fetchJson(baseUrl, "/props"),
  ]);
  assertCapabilities();

  const priorMessages: Context["messages"] = [
    { role: "user", content: "Can you see the current llama.cpp concurrency?", timestamp: 1 },
    {
      role: "assistant",
      api: "openai-completions",
      provider: "llama-cpp",
      model: MODEL_ID,
      content: [{ type: "text", text: "It is running with four slots." }],
      usage: emptyUsage,
      stopReason: "stop",
      timestamp: 2,
    },
    { role: "user", content: "just reply hu", timestamp: 3 },
    {
      role: "assistant",
      api: "openai-completions",
      provider: "llama-cpp",
      model: MODEL_ID,
      content: [{ type: "text", text: "hu" }],
      usage: emptyUsage,
      stopReason: "stop",
      timestamp: 4,
    },
  ];
  const toolMessages: Context["messages"] = [
    { role: "user", content: "Check the file and reply in Discord.", timestamp: 1 },
    {
      role: "assistant",
      api: "openai-completions",
      provider: "llama-cpp",
      model: MODEL_ID,
      content: [
        { type: "toolCall", id: "call-read-1", name: "read", arguments: { path: "README.md" } },
      ],
      usage: emptyUsage,
      stopReason: "toolUse",
      timestamp: 2,
    },
    {
      role: "toolResult",
      toolCallId: "call-read-1",
      toolName: "read",
      content: [{ type: "text", text: "Synthetic README contents." }],
      isError: false,
      timestamp: 3,
    },
  ];

  const baseline = await countPayload(
    baseUrl,
    buildPayload({ systemPrompt, messages: priorMessages }),
  );
  const ordinary = await compare({
    baseUrl,
    systemPrompt,
    messages: priorMessages,
    ctx: ordinaryFixture(),
    prompt: "just reply hi",
  });
  const freshDiscord = await compare({
    baseUrl,
    systemPrompt,
    messages: [],
    ctx: freshDiscordFixture(),
    prompt: "What did I miss?",
  });
  const multiUserReply = await compare({
    baseUrl,
    systemPrompt,
    messages: priorMessages,
    ctx: multiUserReplyFixture(),
    prompt: "Reply to this thread.",
  });
  const toolTurn = await compare({
    baseUrl,
    systemPrompt,
    messages: toolMessages,
    ctx: ordinaryFixture(),
    prompt: "Send the result.",
  });

  const ordinaryDefaultGrowth = ordinary.default.tokens - baseline.tokens;
  const ordinaryCompactGrowth = ordinary.compact.tokens - baseline.tokens;
  const gates = {
    ordinaryTurn: ordinaryCompactGrowth <= ORDINARY_TURN_MAX_TOKENS,
    freshAbsolute: freshDiscord.savedTokens >= FRESH_MIN_ABSOLUTE_SAVINGS,
    freshRelative: freshDiscord.reduction >= FRESH_MIN_RELATIVE_SAVINGS,
    toolTurn: toolTurn.savedTokens >= TOOL_MIN_ABSOLUTE_SAVINGS,
    capabilities: true,
  };
  const modelPath = typeof props["model_path"] === "string" ? props["model_path"] : undefined;
  const revision = modelPath?.match(/\/snapshots\/([^/]+)\//u)?.[1];
  const modelData = Array.isArray(models["data"]) ? models["data"][0] : undefined;
  const result = {
    schema: "openclaw.context-serialization-benchmark.v1",
    provenance: {
      profileId,
      modelId: MODEL_ID,
      modelRevision: revision,
      modelFile: modelPath?.split("/").at(-1),
      runtimeOwner: "ggml-org/llama.cpp",
      runtimeBuild: props["build_info"],
      requestedBackend: "llama.cpp /apply-template + /tokenize",
      observedBackend: "llama.cpp /apply-template + /tokenize",
      contextWindow: (modelData as { meta?: { n_ctx?: unknown } } | undefined)?.meta?.n_ctx,
      quantization: props["model_ftype"],
      slots: props["total_slots"],
      speculativeDecoding: "none",
    },
    thresholds: {
      ordinaryTurnMaxTokens: ORDINARY_TURN_MAX_TOKENS,
      freshMinAbsoluteSavings: FRESH_MIN_ABSOLUTE_SAVINGS,
      freshMinRelativeSavings: FRESH_MIN_RELATIVE_SAVINGS,
      toolMinAbsoluteSavings: TOOL_MIN_ABSOLUTE_SAVINGS,
      requiredCapabilityFailures: 0,
    },
    results: {
      baseline,
      ordinary: {
        ...ordinary,
        defaultGrowth: ordinaryDefaultGrowth,
        compactGrowth: ordinaryCompactGrowth,
      },
      freshDiscord,
      multiUserReply,
      toolTurn,
    },
    gates,
    passed: Object.values(gates).every(Boolean),
  };
  console.log(JSON.stringify(result, null, 2));
  if (!result.passed) {
    process.exitCode = 1;
  }
}

await main();
