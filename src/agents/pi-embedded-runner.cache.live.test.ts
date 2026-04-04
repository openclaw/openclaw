import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AssistantMessage, Message, Tool } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  buildStableCachePrefix,
  completeSimpleWithLiveTimeout,
  computeCacheHitRate,
  extractAssistantText,
  LIVE_CACHE_TEST_ENABLED,
  logLiveCache,
  resolveLiveDirectModel,
  withLiveCacheHeartbeat,
} from "./live-cache-test-support.js";
import { runEmbeddedPiAgent } from "./pi-embedded-runner.js";
import { compactEmbeddedPiSessionDirect } from "./pi-embedded-runner/compact.runtime.js";

const describeCacheLive = LIVE_CACHE_TEST_ENABLED ? describe : describe.skip;

const OPENAI_TIMEOUT_MS = 120_000;
const ANTHROPIC_TIMEOUT_MS = 120_000;
const OPENAI_SESSION_ID = "live-cache-openai-stable-session";
const ANTHROPIC_SESSION_ID = "live-cache-anthropic-stable-session";
const OPENAI_PREFIX = buildStableCachePrefix("openai");
const ANTHROPIC_PREFIX = buildStableCachePrefix("anthropic");
const LIVE_TEST_PNG_URL = new URL(
  "../../apps/android/app/src/main/res/mipmap-xhdpi/ic_launcher.png",
  import.meta.url,
);

type CacheRun = {
  hitRate: number;
  suffix: string;
  text: string;
  usage: AssistantMessage["usage"];
};
type LiveResolvedModel = Awaited<ReturnType<typeof resolveLiveDirectModel>>;

const NOOP_TOOL: Tool = {
  name: "noop",
  description: "Return ok.",
  parameters: Type.Object({}, { additionalProperties: false }),
};
let liveTestPngBase64 = "";
let liveRunnerRootDir: string | undefined;

type UserContent = Extract<Message, { role: "user" }>["content"];

function makeAssistantHistoryTurn(text: string): Message {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    timestamp: Date.now(),
  };
}

function makeUserHistoryTurn(content: UserContent): Message {
  return {
    role: "user",
    content,
    timestamp: Date.now(),
  };
}

function makeImageUserTurn(text: string): Message {
  if (!liveTestPngBase64) {
    throw new Error("live test PNG not loaded");
  }
  return makeUserHistoryTurn([
    { type: "text", text },
    { type: "image", mimeType: "image/png", data: liveTestPngBase64 },
  ]);
}

function buildRunnerSessionPaths(sessionId: string) {
  if (!liveRunnerRootDir) {
    throw new Error("live runner temp root not initialized");
  }
  return {
    agentDir: liveRunnerRootDir,
    sessionFile: path.join(liveRunnerRootDir, `${sessionId}.jsonl`),
    workspaceDir: path.join(liveRunnerRootDir, `${sessionId}-workspace`),
  };
}

function resolveProviderBaseUrl(fixture: LiveResolvedModel): string | undefined {
  const candidate = (fixture.model as { baseUrl?: unknown }).baseUrl;
  return typeof candidate === "string" && candidate.trim().length > 0 ? candidate : undefined;
}

function buildEmbeddedRunnerConfig(params: {
  fixture: LiveResolvedModel;
  cacheRetention: "none" | "short" | "long";
  transport?: "sse" | "websocket";
}): OpenClawConfig {
  const provider = params.fixture.model.provider;
  const modelKey = `${provider}/${params.fixture.model.id}`;
  const providerBaseUrl = resolveProviderBaseUrl(params.fixture);
  return {
    models: {
      providers: {
        [provider]: {
          api: params.fixture.model.api,
          apiKey: params.fixture.apiKey,
          ...(providerBaseUrl ? { baseUrl: providerBaseUrl } : {}),
        },
      },
    },
    agents: {
      defaults: {
        models: {
          [modelKey]: {
            params: {
              cacheRetention: params.cacheRetention,
              ...(params.transport ? { transport: params.transport } : {}),
            },
          },
        },
      },
    },
  };
}

function buildEmbeddedCachePrompt(suffix: string, sections = 48): string {
  const lines = [
    `Reply with exactly CACHE-OK ${suffix}.`,
    "Do not add any extra words or punctuation.",
  ];
  for (let index = 0; index < sections; index += 1) {
    lines.push(
      `Embedded cache section ${index + 1}: deterministic prose about prompt stability, session affinity, request shaping, transport continuity, and cache reuse across identical stable prefixes.`,
    );
  }
  return lines.join("\n");
}

function extractRunPayloadText(payloads: Array<{ text?: string } | undefined> | undefined): string {
  return (
    payloads
      ?.map((payload) => payload?.text?.trim())
      .filter((text): text is string => Boolean(text))
      .join(" ") ?? ""
  );
}

async function runEmbeddedCacheProbe(params: {
  fixture: LiveResolvedModel;
  cacheRetention: "none" | "short" | "long";
  prefix: string;
  providerTag: "anthropic" | "openai";
  sessionId: string;
  suffix: string;
  transport?: "sse" | "websocket";
  promptSections?: number;
}): Promise<CacheRun> {
  const sessionPaths = buildRunnerSessionPaths(params.sessionId);
  await fs.mkdir(sessionPaths.workspaceDir, { recursive: true });
  const result = await withLiveCacheHeartbeat(
    runEmbeddedPiAgent({
      sessionId: params.sessionId,
      sessionKey: `live-cache:${params.providerTag}:${params.sessionId}`,
      sessionFile: sessionPaths.sessionFile,
      workspaceDir: sessionPaths.workspaceDir,
      agentDir: sessionPaths.agentDir,
      config: buildEmbeddedRunnerConfig({
        fixture: params.fixture,
        cacheRetention: params.cacheRetention,
        transport: params.transport,
      }),
      prompt: buildEmbeddedCachePrompt(params.suffix, params.promptSections),
      provider: params.fixture.model.provider,
      model: params.fixture.model.id,
      timeoutMs: params.providerTag === "openai" ? OPENAI_TIMEOUT_MS : ANTHROPIC_TIMEOUT_MS,
      runId: `${params.sessionId}-${params.suffix}-${params.transport ?? "default"}`,
      extraSystemPrompt: params.prefix,
      disableTools: true,
      cleanupBundleMcpOnRunEnd: true,
    }),
    `${params.providerTag} embedded cache probe ${params.suffix}${params.transport ? ` (${params.transport})` : ""}`,
  );
  const text = extractRunPayloadText(result.payloads);
  expect(text.toLowerCase()).toContain(params.suffix.toLowerCase());
  const usage = result.meta.agentMeta?.usage ?? {};
  return {
    suffix: params.suffix,
    text,
    usage,
    hitRate: computeCacheHitRate(usage),
  };
}

async function compactLiveCacheSession(params: {
  fixture: LiveResolvedModel;
  cacheRetention: "none" | "short" | "long";
  providerTag: "anthropic" | "openai";
  sessionId: string;
}) {
  const sessionPaths = buildRunnerSessionPaths(params.sessionId);
  await fs.mkdir(sessionPaths.workspaceDir, { recursive: true });
  return await withLiveCacheHeartbeat(
    compactEmbeddedPiSessionDirect({
      sessionId: params.sessionId,
      sessionKey: `live-cache:${params.providerTag}:${params.sessionId}`,
      sessionFile: sessionPaths.sessionFile,
      workspaceDir: sessionPaths.workspaceDir,
      agentDir: sessionPaths.agentDir,
      config: buildEmbeddedRunnerConfig({
        fixture: params.fixture,
        cacheRetention: params.cacheRetention,
      }),
      provider: params.fixture.model.provider,
      model: params.fixture.model.id,
      force: true,
      trigger: "manual",
      runId: `${params.sessionId}-compact`,
      tokenBudget: 512,
    }),
    `${params.providerTag} embedded compaction ${params.sessionId}`,
  );
}

function extractFirstToolCall(message: AssistantMessage) {
  return message.content.find((block) => block.type === "toolCall");
}

function buildToolResultMessage(
  toolCallId: string,
  toolName = "noop",
  text = "ok",
): Extract<Message, { role: "toolResult" }> {
  return {
    role: "toolResult",
    toolCallId,
    toolName,
    content: [{ type: "text", text }],
    isError: false,
    timestamp: Date.now(),
  };
}

async function runToolOnlyTurn(params: {
  apiKey: string;
  cacheRetention: "none" | "short" | "long";
  model: Awaited<ReturnType<typeof resolveLiveDirectModel>>["model"];
  providerTag: "anthropic" | "openai";
  sessionId: string;
  systemPrompt: string;
  tool: Tool;
}) {
  let prompt = `Call the tool \`${params.tool.name}\` with {}. IMPORTANT: respond ONLY with the tool call and no other text.`;
  let response = await completeSimpleWithLiveTimeout(
    params.model,
    {
      systemPrompt: params.systemPrompt,
      messages: [
        {
          role: "user",
          content: prompt,
          timestamp: Date.now(),
        },
      ],
      tools: [params.tool],
    },
    {
      apiKey: params.apiKey,
      cacheRetention: params.cacheRetention,
      sessionId: params.sessionId,
      maxTokens: 128,
      temperature: 0,
      ...(params.providerTag === "openai" ? { reasoning: "none" as unknown as never } : {}),
    },
    `${params.providerTag} tool-only turn`,
    params.providerTag === "openai" ? OPENAI_TIMEOUT_MS : ANTHROPIC_TIMEOUT_MS,
  );

  let toolCall = extractFirstToolCall(response);
  let text = extractAssistantText(response);
  for (let attempt = 0; attempt < 2 && (!toolCall || text.length > 0); attempt += 1) {
    prompt = `Return only a tool call for \`${params.tool.name}\` with {}. No text.`;
    response = await completeSimpleWithLiveTimeout(
      params.model,
      {
        systemPrompt: params.systemPrompt,
        messages: [
          {
            role: "user",
            content: prompt,
            timestamp: Date.now(),
          },
        ],
        tools: [params.tool],
      },
      {
        apiKey: params.apiKey,
        cacheRetention: params.cacheRetention,
        sessionId: params.sessionId,
        maxTokens: 128,
        temperature: 0,
        ...(params.providerTag === "openai" ? { reasoning: "none" as unknown as never } : {}),
      },
      `${params.providerTag} tool-only retry ${attempt + 1}`,
      params.providerTag === "openai" ? OPENAI_TIMEOUT_MS : ANTHROPIC_TIMEOUT_MS,
    );
    toolCall = extractFirstToolCall(response);
    text = extractAssistantText(response);
  }

  expect(toolCall).toBeTruthy();
  expect(text.length).toBe(0);
  if (!toolCall || toolCall.type !== "toolCall") {
    throw new Error("expected tool call");
  }

  return {
    prompt,
    response,
    toolCall,
  };
}

async function runOpenAiToolCacheProbe(params: {
  apiKey: string;
  model: Awaited<ReturnType<typeof resolveLiveDirectModel>>["model"];
  sessionId: string;
  suffix: string;
}): Promise<CacheRun> {
  const toolTurn = await runToolOnlyTurn({
    apiKey: params.apiKey,
    cacheRetention: "short",
    model: params.model,
    providerTag: "openai",
    sessionId: params.sessionId,
    systemPrompt: OPENAI_PREFIX,
    tool: NOOP_TOOL,
  });
  const response = await completeSimpleWithLiveTimeout(
    params.model,
    {
      systemPrompt: OPENAI_PREFIX,
      messages: [
        {
          role: "user",
          content: toolTurn.prompt,
          timestamp: Date.now(),
        },
        toolTurn.response,
        buildToolResultMessage(toolTurn.toolCall.id, NOOP_TOOL.name, "ok"),
        makeAssistantHistoryTurn("TOOL HISTORY ACKNOWLEDGED"),
        makeUserHistoryTurn("Keep the tool output stable in history."),
        makeAssistantHistoryTurn("TOOL HISTORY PRESERVED"),
        {
          role: "user",
          content: `Reply with exactly CACHE-OK ${params.suffix}.`,
          timestamp: Date.now(),
        },
      ],
      tools: [NOOP_TOOL],
    },
    {
      apiKey: params.apiKey,
      cacheRetention: "short",
      sessionId: params.sessionId,
      maxTokens: 64,
      temperature: 0,
      reasoning: "none" as unknown as never,
    },
    `openai cache probe ${params.suffix}`,
    OPENAI_TIMEOUT_MS,
  );
  const text = extractAssistantText(response);
  expect(text.toLowerCase()).toContain(params.suffix.toLowerCase());
  return {
    suffix: params.suffix,
    text,
    usage: response.usage,
    hitRate: computeCacheHitRate(response.usage),
  };
}

async function runOpenAiCacheProbe(params: {
  apiKey: string;
  model: Awaited<ReturnType<typeof resolveLiveDirectModel>>["model"];
  sessionId: string;
  suffix: string;
}): Promise<CacheRun> {
  const response = await completeSimpleWithLiveTimeout(
    params.model,
    {
      systemPrompt: OPENAI_PREFIX,
      messages: [
        {
          role: "user",
          content: `Reply with exactly CACHE-OK ${params.suffix}.`,
          timestamp: Date.now(),
        },
      ],
    },
    {
      apiKey: params.apiKey,
      cacheRetention: "short",
      sessionId: params.sessionId,
      maxTokens: 32,
      temperature: 0,
    },
    `openai cache probe ${params.suffix}`,
    OPENAI_TIMEOUT_MS,
  );
  const text = extractAssistantText(response);
  expect(text.toLowerCase()).toContain(params.suffix.toLowerCase());
  return {
    suffix: params.suffix,
    text,
    usage: response.usage,
    hitRate: computeCacheHitRate(response.usage),
  };
}

async function runOpenAiImageCacheProbe(params: {
  apiKey: string;
  model: Awaited<ReturnType<typeof resolveLiveDirectModel>>["model"];
  sessionId: string;
  suffix: string;
}): Promise<CacheRun> {
  const response = await completeSimpleWithLiveTimeout(
    params.model,
    {
      systemPrompt: OPENAI_PREFIX,
      messages: [
        makeImageUserTurn(
          "An image is attached. Ignore image semantics but keep the bytes in history.",
        ),
        makeAssistantHistoryTurn("IMAGE HISTORY ACKNOWLEDGED"),
        makeUserHistoryTurn("Keep the earlier image turn stable in context."),
        makeAssistantHistoryTurn("IMAGE HISTORY PRESERVED"),
        makeUserHistoryTurn(`Reply with exactly CACHE-OK ${params.suffix}.`),
      ],
    },
    {
      apiKey: params.apiKey,
      cacheRetention: "short",
      sessionId: params.sessionId,
      maxTokens: 64,
      temperature: 0,
      reasoning: "none" as unknown as never,
    },
    `openai image cache probe ${params.suffix}`,
    OPENAI_TIMEOUT_MS,
  );
  const text = extractAssistantText(response);
  expect(text.toLowerCase()).toContain(params.suffix.toLowerCase());
  return {
    suffix: params.suffix,
    text,
    usage: response.usage,
    hitRate: computeCacheHitRate(response.usage),
  };
}

async function runAnthropicCacheProbe(params: {
  apiKey: string;
  model: Awaited<ReturnType<typeof resolveLiveDirectModel>>["model"];
  sessionId: string;
  suffix: string;
  cacheRetention: "none" | "short" | "long";
}): Promise<CacheRun> {
  const response = await completeSimpleWithLiveTimeout(
    params.model,
    {
      systemPrompt: ANTHROPIC_PREFIX,
      messages: [
        {
          role: "user",
          content: `Reply with exactly CACHE-OK ${params.suffix}.`,
          timestamp: Date.now(),
        },
      ],
    },
    {
      apiKey: params.apiKey,
      cacheRetention: params.cacheRetention,
      sessionId: params.sessionId,
      maxTokens: 32,
      temperature: 0,
    },
    `anthropic cache probe ${params.suffix} (${params.cacheRetention})`,
    ANTHROPIC_TIMEOUT_MS,
  );
  const text = extractAssistantText(response);
  expect(text.toLowerCase()).toContain(params.suffix.toLowerCase());
  return {
    suffix: params.suffix,
    text,
    usage: response.usage,
    hitRate: computeCacheHitRate(response.usage),
  };
}

async function runAnthropicToolCacheProbe(params: {
  apiKey: string;
  model: Awaited<ReturnType<typeof resolveLiveDirectModel>>["model"];
  sessionId: string;
  suffix: string;
  cacheRetention: "none" | "short" | "long";
}): Promise<CacheRun> {
  const toolTurn = await runToolOnlyTurn({
    apiKey: params.apiKey,
    cacheRetention: params.cacheRetention,
    model: params.model,
    providerTag: "anthropic",
    sessionId: params.sessionId,
    systemPrompt: ANTHROPIC_PREFIX,
    tool: NOOP_TOOL,
  });
  const response = await completeSimpleWithLiveTimeout(
    params.model,
    {
      systemPrompt: ANTHROPIC_PREFIX,
      messages: [
        {
          role: "user",
          content: toolTurn.prompt,
          timestamp: Date.now(),
        },
        toolTurn.response,
        buildToolResultMessage(toolTurn.toolCall.id, NOOP_TOOL.name, "ok"),
        makeAssistantHistoryTurn("TOOL HISTORY ACKNOWLEDGED"),
        makeUserHistoryTurn("Keep the tool output stable in history."),
        makeAssistantHistoryTurn("TOOL HISTORY PRESERVED"),
        {
          role: "user",
          content: `Reply with exactly CACHE-OK ${params.suffix}.`,
          timestamp: Date.now(),
        },
      ],
      tools: [NOOP_TOOL],
    },
    {
      apiKey: params.apiKey,
      cacheRetention: params.cacheRetention,
      sessionId: params.sessionId,
      maxTokens: 64,
      temperature: 0,
    },
    `anthropic cache probe ${params.suffix} (${params.cacheRetention})`,
    ANTHROPIC_TIMEOUT_MS,
  );
  const text = extractAssistantText(response);
  expect(text.toLowerCase()).toContain(params.suffix.toLowerCase());
  return {
    suffix: params.suffix,
    text,
    usage: response.usage,
    hitRate: computeCacheHitRate(response.usage),
  };
}

async function runAnthropicImageCacheProbe(params: {
  apiKey: string;
  model: Awaited<ReturnType<typeof resolveLiveDirectModel>>["model"];
  sessionId: string;
  suffix: string;
  cacheRetention: "none" | "short" | "long";
}): Promise<CacheRun> {
  const response = await completeSimpleWithLiveTimeout(
    params.model,
    {
      systemPrompt: ANTHROPIC_PREFIX,
      messages: [
        makeImageUserTurn(
          "An image is attached. Ignore image semantics but keep the bytes in history.",
        ),
        makeAssistantHistoryTurn("IMAGE HISTORY ACKNOWLEDGED"),
        makeUserHistoryTurn("Keep the earlier image turn stable in context."),
        makeAssistantHistoryTurn("IMAGE HISTORY PRESERVED"),
        makeUserHistoryTurn(`Reply with exactly CACHE-OK ${params.suffix}.`),
      ],
    },
    {
      apiKey: params.apiKey,
      cacheRetention: params.cacheRetention,
      sessionId: params.sessionId,
      maxTokens: 64,
      temperature: 0,
    },
    `anthropic image cache probe ${params.suffix} (${params.cacheRetention})`,
    ANTHROPIC_TIMEOUT_MS,
  );
  const text = extractAssistantText(response);
  expect(text.toLowerCase()).toContain(params.suffix.toLowerCase());
  return {
    suffix: params.suffix,
    text,
    usage: response.usage,
    hitRate: computeCacheHitRate(response.usage),
  };
}

describeCacheLive("pi embedded runner prompt caching (live)", () => {
  beforeAll(async () => {
    liveRunnerRootDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-live-cache-"));
    liveTestPngBase64 = (await fs.readFile(LIVE_TEST_PNG_URL)).toString("base64");
  }, 120_000);

  afterAll(async () => {
    if (liveRunnerRootDir) {
      await fs.rm(liveRunnerRootDir, { recursive: true, force: true });
    }
    liveRunnerRootDir = undefined;
  });

  describe("openai", () => {
    let fixture: Awaited<ReturnType<typeof resolveLiveDirectModel>>;

    beforeAll(async () => {
      fixture = await resolveLiveDirectModel({
        provider: "openai",
        api: "openai-responses",
        envVar: "OPENCLAW_LIVE_OPENAI_CACHE_MODEL",
        preferredModelIds: ["gpt-5.4-mini", "gpt-5.4", "gpt-5.2"],
      });
      logLiveCache(`openai model=${fixture.model.provider}/${fixture.model.id}`);
    }, 120_000);

    it(
      "hits a high cache-read rate on repeated stable prefixes",
      async () => {
        const warmup = await runOpenAiCacheProbe({
          ...fixture,
          sessionId: OPENAI_SESSION_ID,
          suffix: "warmup",
        });
        logLiveCache(
          `openai warmup cacheRead=${warmup.usage.cacheRead} input=${warmup.usage.input} rate=${warmup.hitRate.toFixed(3)}`,
        );

        const hitRuns = [
          await runOpenAiCacheProbe({
            ...fixture,
            sessionId: OPENAI_SESSION_ID,
            suffix: "hit-a",
          }),
          await runOpenAiCacheProbe({
            ...fixture,
            sessionId: OPENAI_SESSION_ID,
            suffix: "hit-b",
          }),
        ];

        const bestHit = hitRuns.reduce((best, candidate) =>
          (candidate.usage.cacheRead ?? 0) > (best.usage.cacheRead ?? 0) ? candidate : best,
        );
        logLiveCache(
          `openai best-hit suffix=${bestHit.suffix} cacheRead=${bestHit.usage.cacheRead} input=${bestHit.usage.input} rate=${bestHit.hitRate.toFixed(3)}`,
        );

        expect(bestHit.usage.cacheRead ?? 0).toBeGreaterThan(1_024);
        expect(bestHit.hitRate).toBeGreaterThanOrEqual(0.7);
      },
      6 * 60_000,
    );

    it(
      "keeps high cache-read rates across tool-call followup turns",
      async () => {
        const warmup = await runOpenAiToolCacheProbe({
          ...fixture,
          sessionId: `${OPENAI_SESSION_ID}-tool`,
          suffix: "tool-warmup",
        });
        logLiveCache(
          `openai tool warmup cacheRead=${warmup.usage.cacheRead} input=${warmup.usage.input} rate=${warmup.hitRate.toFixed(3)}`,
        );

        const hitA = await runOpenAiToolCacheProbe({
          ...fixture,
          sessionId: `${OPENAI_SESSION_ID}-tool`,
          suffix: "tool-hit-a",
        });
        const hitB = await runOpenAiToolCacheProbe({
          ...fixture,
          sessionId: `${OPENAI_SESSION_ID}-tool`,
          suffix: "tool-hit-b",
        });
        const bestHit = (hitA.usage.cacheRead ?? 0) >= (hitB.usage.cacheRead ?? 0) ? hitA : hitB;
        logLiveCache(
          `openai tool best-hit suffix=${bestHit.suffix} cacheRead=${bestHit.usage.cacheRead} input=${bestHit.usage.input} rate=${bestHit.hitRate.toFixed(3)}`,
        );

        expect(bestHit.usage.cacheRead ?? 0).toBeGreaterThan(1_024);
        expect(bestHit.hitRate).toBeGreaterThanOrEqual(0.7);
      },
      8 * 60_000,
    );

    it(
      "keeps high cache-read rates across image-heavy followup turns",
      async () => {
        const warmup = await runOpenAiImageCacheProbe({
          ...fixture,
          sessionId: `${OPENAI_SESSION_ID}-image`,
          suffix: "image-warmup",
        });
        logLiveCache(
          `openai image warmup cacheRead=${warmup.usage.cacheRead} input=${warmup.usage.input} rate=${warmup.hitRate.toFixed(3)}`,
        );

        const hitA = await runOpenAiImageCacheProbe({
          ...fixture,
          sessionId: `${OPENAI_SESSION_ID}-image`,
          suffix: "image-hit-a",
        });
        const hitB = await runOpenAiImageCacheProbe({
          ...fixture,
          sessionId: `${OPENAI_SESSION_ID}-image`,
          suffix: "image-hit-b",
        });
        const bestHit = (hitA.usage.cacheRead ?? 0) >= (hitB.usage.cacheRead ?? 0) ? hitA : hitB;
        logLiveCache(
          `openai image best-hit suffix=${bestHit.suffix} cacheRead=${bestHit.usage.cacheRead} input=${bestHit.usage.input} rate=${bestHit.hitRate.toFixed(3)}`,
        );

        expect(bestHit.usage.cacheRead ?? 0).toBeGreaterThan(1_024);
        expect(bestHit.hitRate).toBeGreaterThanOrEqual(0.6);
      },
      6 * 60_000,
    );

    it(
      "keeps high cache-read rates across repeated embedded-runner turns",
      async () => {
        const sessionId = `${OPENAI_SESSION_ID}-embedded`;
        const warmup = await runEmbeddedCacheProbe({
          ...fixture,
          cacheRetention: "short",
          prefix: OPENAI_PREFIX,
          providerTag: "openai",
          sessionId,
          suffix: "embedded-warmup",
        });
        logLiveCache(
          `openai embedded warmup cacheRead=${warmup.usage.cacheRead} input=${warmup.usage.input} rate=${warmup.hitRate.toFixed(3)}`,
        );

        const hitA = await runEmbeddedCacheProbe({
          ...fixture,
          cacheRetention: "short",
          prefix: OPENAI_PREFIX,
          providerTag: "openai",
          sessionId,
          suffix: "embedded-hit-a",
        });
        const hitB = await runEmbeddedCacheProbe({
          ...fixture,
          cacheRetention: "short",
          prefix: OPENAI_PREFIX,
          providerTag: "openai",
          sessionId,
          suffix: "embedded-hit-b",
        });
        const bestHit = (hitA.usage.cacheRead ?? 0) >= (hitB.usage.cacheRead ?? 0) ? hitA : hitB;
        logLiveCache(
          `openai embedded best-hit suffix=${bestHit.suffix} cacheRead=${bestHit.usage.cacheRead} input=${bestHit.usage.input} rate=${bestHit.hitRate.toFixed(3)}`,
        );

        expect(bestHit.usage.cacheRead ?? 0).toBeGreaterThan(1_024);
        expect(bestHit.hitRate).toBeGreaterThanOrEqual(0.4);
      },
      8 * 60_000,
    );

    it(
      "keeps high cache-read rates when the same embedded session flips from websocket to sse",
      async () => {
        const sessionId = `${OPENAI_SESSION_ID}-transport-flip`;
        const warmup = await runEmbeddedCacheProbe({
          ...fixture,
          cacheRetention: "short",
          prefix: OPENAI_PREFIX,
          providerTag: "openai",
          sessionId,
          suffix: "ws-warmup",
          transport: "websocket",
        });
        logLiveCache(
          `openai transport warmup cacheRead=${warmup.usage.cacheRead} input=${warmup.usage.input} rate=${warmup.hitRate.toFixed(3)}`,
        );

        const hitA = await runEmbeddedCacheProbe({
          ...fixture,
          cacheRetention: "short",
          prefix: OPENAI_PREFIX,
          providerTag: "openai",
          sessionId,
          suffix: "sse-hit-a",
          transport: "sse",
        });
        const hitB = await runEmbeddedCacheProbe({
          ...fixture,
          cacheRetention: "short",
          prefix: OPENAI_PREFIX,
          providerTag: "openai",
          sessionId,
          suffix: "sse-hit-b",
          transport: "sse",
        });
        const bestHit = (hitA.usage.cacheRead ?? 0) >= (hitB.usage.cacheRead ?? 0) ? hitA : hitB;
        logLiveCache(
          `openai transport-flip best-hit suffix=${bestHit.suffix} cacheRead=${bestHit.usage.cacheRead} input=${bestHit.usage.input} rate=${bestHit.hitRate.toFixed(3)}`,
        );

        expect(bestHit.usage.cacheRead ?? 0).toBeGreaterThan(1_024);
        expect(bestHit.hitRate).toBeGreaterThanOrEqual(0.35);
      },
      8 * 60_000,
    );
  });

  describe("anthropic", () => {
    let fixture: Awaited<ReturnType<typeof resolveLiveDirectModel>>;

    beforeAll(async () => {
      fixture = await resolveLiveDirectModel({
        provider: "anthropic",
        api: "anthropic-messages",
        envVar: "OPENCLAW_LIVE_ANTHROPIC_CACHE_MODEL",
        preferredModelIds: ["claude-sonnet-4-6", "claude-sonnet-4-5", "claude-haiku-3-5"],
      });
      logLiveCache(`anthropic model=${fixture.model.provider}/${fixture.model.id}`);
    }, 120_000);

    it(
      "writes cache on warmup and reads it back on repeated stable prefixes",
      async () => {
        const warmup = await runAnthropicCacheProbe({
          ...fixture,
          sessionId: ANTHROPIC_SESSION_ID,
          suffix: "warmup",
          cacheRetention: "short",
        });
        logLiveCache(
          `anthropic warmup cacheWrite=${warmup.usage.cacheWrite} cacheRead=${warmup.usage.cacheRead} input=${warmup.usage.input} rate=${warmup.hitRate.toFixed(3)}`,
        );
        expect(warmup.usage.cacheWrite ?? 0).toBeGreaterThan(0);

        const hitRuns = [
          await runAnthropicCacheProbe({
            ...fixture,
            sessionId: ANTHROPIC_SESSION_ID,
            suffix: "hit-a",
            cacheRetention: "short",
          }),
          await runAnthropicCacheProbe({
            ...fixture,
            sessionId: ANTHROPIC_SESSION_ID,
            suffix: "hit-b",
            cacheRetention: "short",
          }),
        ];

        const bestHit = hitRuns.reduce((best, candidate) =>
          (candidate.usage.cacheRead ?? 0) > (best.usage.cacheRead ?? 0) ? candidate : best,
        );
        logLiveCache(
          `anthropic best-hit suffix=${bestHit.suffix} cacheWrite=${bestHit.usage.cacheWrite} cacheRead=${bestHit.usage.cacheRead} input=${bestHit.usage.input} rate=${bestHit.hitRate.toFixed(3)}`,
        );

        expect(bestHit.usage.cacheRead ?? 0).toBeGreaterThan(1_024);
        expect(bestHit.hitRate).toBeGreaterThanOrEqual(0.7);
      },
      6 * 60_000,
    );

    it(
      "keeps high cache-read rates across tool-call followup turns",
      async () => {
        const warmup = await runAnthropicToolCacheProbe({
          ...fixture,
          sessionId: `${ANTHROPIC_SESSION_ID}-tool`,
          suffix: "tool-warmup",
          cacheRetention: "short",
        });
        logLiveCache(
          `anthropic tool warmup cacheWrite=${warmup.usage.cacheWrite} cacheRead=${warmup.usage.cacheRead} input=${warmup.usage.input} rate=${warmup.hitRate.toFixed(3)}`,
        );
        expect(warmup.usage.cacheWrite ?? 0).toBeGreaterThan(0);

        const hitA = await runAnthropicToolCacheProbe({
          ...fixture,
          sessionId: `${ANTHROPIC_SESSION_ID}-tool`,
          suffix: "tool-hit-a",
          cacheRetention: "short",
        });
        const hitB = await runAnthropicToolCacheProbe({
          ...fixture,
          sessionId: `${ANTHROPIC_SESSION_ID}-tool`,
          suffix: "tool-hit-b",
          cacheRetention: "short",
        });
        const bestHit = (hitA.usage.cacheRead ?? 0) >= (hitB.usage.cacheRead ?? 0) ? hitA : hitB;
        logLiveCache(
          `anthropic tool best-hit suffix=${bestHit.suffix} cacheWrite=${bestHit.usage.cacheWrite} cacheRead=${bestHit.usage.cacheRead} input=${bestHit.usage.input} rate=${bestHit.hitRate.toFixed(3)}`,
        );

        expect(bestHit.usage.cacheRead ?? 0).toBeGreaterThan(1_024);
        expect(bestHit.hitRate).toBeGreaterThanOrEqual(0.7);
      },
      8 * 60_000,
    );

    it(
      "keeps high cache-read rates across image-heavy followup turns",
      async () => {
        const warmup = await runAnthropicImageCacheProbe({
          ...fixture,
          sessionId: `${ANTHROPIC_SESSION_ID}-image`,
          suffix: "image-warmup",
          cacheRetention: "short",
        });
        logLiveCache(
          `anthropic image warmup cacheWrite=${warmup.usage.cacheWrite} cacheRead=${warmup.usage.cacheRead} input=${warmup.usage.input} rate=${warmup.hitRate.toFixed(3)}`,
        );

        const hitA = await runAnthropicImageCacheProbe({
          ...fixture,
          sessionId: `${ANTHROPIC_SESSION_ID}-image`,
          suffix: "image-hit-a",
          cacheRetention: "short",
        });
        const hitB = await runAnthropicImageCacheProbe({
          ...fixture,
          sessionId: `${ANTHROPIC_SESSION_ID}-image`,
          suffix: "image-hit-b",
          cacheRetention: "short",
        });
        const bestHit = (hitA.usage.cacheRead ?? 0) >= (hitB.usage.cacheRead ?? 0) ? hitA : hitB;
        logLiveCache(
          `anthropic image best-hit suffix=${bestHit.suffix} cacheWrite=${bestHit.usage.cacheWrite} cacheRead=${bestHit.usage.cacheRead} input=${bestHit.usage.input} rate=${bestHit.hitRate.toFixed(3)}`,
        );

        expect(bestHit.usage.cacheRead ?? 0).toBeGreaterThan(1_024);
        expect(bestHit.hitRate).toBeGreaterThanOrEqual(0.6);
      },
      6 * 60_000,
    );

    it(
      "does not report meaningful cache activity when retention is disabled",
      async () => {
        const disabled = await runAnthropicCacheProbe({
          ...fixture,
          sessionId: `${ANTHROPIC_SESSION_ID}-disabled`,
          suffix: "no-cache",
          cacheRetention: "none",
        });
        logLiveCache(
          `anthropic none cacheWrite=${disabled.usage.cacheWrite} cacheRead=${disabled.usage.cacheRead} input=${disabled.usage.input}`,
        );

        expect(disabled.usage.cacheRead ?? 0).toBeLessThanOrEqual(32);
        expect(disabled.usage.cacheWrite ?? 0).toBeLessThanOrEqual(32);
      },
      3 * 60_000,
    );

    it(
      "keeps high cache-read rates across repeated embedded-runner turns",
      async () => {
        const sessionId = `${ANTHROPIC_SESSION_ID}-embedded`;
        const warmup = await runEmbeddedCacheProbe({
          ...fixture,
          cacheRetention: "short",
          prefix: ANTHROPIC_PREFIX,
          providerTag: "anthropic",
          sessionId,
          suffix: "embedded-warmup",
        });
        logLiveCache(
          `anthropic embedded warmup cacheWrite=${warmup.usage.cacheWrite} cacheRead=${warmup.usage.cacheRead} input=${warmup.usage.input} rate=${warmup.hitRate.toFixed(3)}`,
        );
        expect(warmup.usage.cacheWrite ?? 0).toBeGreaterThan(0);

        const hitA = await runEmbeddedCacheProbe({
          ...fixture,
          cacheRetention: "short",
          prefix: ANTHROPIC_PREFIX,
          providerTag: "anthropic",
          sessionId,
          suffix: "embedded-hit-a",
        });
        const hitB = await runEmbeddedCacheProbe({
          ...fixture,
          cacheRetention: "short",
          prefix: ANTHROPIC_PREFIX,
          providerTag: "anthropic",
          sessionId,
          suffix: "embedded-hit-b",
        });
        const bestHit = (hitA.usage.cacheRead ?? 0) >= (hitB.usage.cacheRead ?? 0) ? hitA : hitB;
        logLiveCache(
          `anthropic embedded best-hit suffix=${bestHit.suffix} cacheWrite=${bestHit.usage.cacheWrite} cacheRead=${bestHit.usage.cacheRead} input=${bestHit.usage.input} rate=${bestHit.hitRate.toFixed(3)}`,
        );

        expect(bestHit.usage.cacheRead ?? 0).toBeGreaterThan(1_024);
        expect(bestHit.hitRate).toBeGreaterThanOrEqual(0.4);
      },
      8 * 60_000,
    );

    it(
      "preserves cache-safe shaping across compaction followup turns",
      async () => {
        const sessionId = `${ANTHROPIC_SESSION_ID}-compaction`;
        await runEmbeddedCacheProbe({
          ...fixture,
          cacheRetention: "short",
          prefix: ANTHROPIC_PREFIX,
          providerTag: "anthropic",
          sessionId,
          suffix: "compact-prime-a",
          promptSections: 96,
        });
        await runEmbeddedCacheProbe({
          ...fixture,
          cacheRetention: "short",
          prefix: ANTHROPIC_PREFIX,
          providerTag: "anthropic",
          sessionId,
          suffix: "compact-prime-b",
          promptSections: 96,
        });

        const compacted = await compactLiveCacheSession({
          ...fixture,
          cacheRetention: "short",
          providerTag: "anthropic",
          sessionId,
        });
        logLiveCache(
          `anthropic compaction ok=${compacted.ok} compacted=${compacted.compacted} reason=${compacted.reason ?? "none"}`,
        );
        expect(compacted.ok).toBe(true);
        expect(compacted.compacted).toBe(true);

        const followup = await runEmbeddedCacheProbe({
          ...fixture,
          cacheRetention: "short",
          prefix: ANTHROPIC_PREFIX,
          providerTag: "anthropic",
          sessionId,
          suffix: "compact-hit",
        });
        logLiveCache(
          `anthropic compaction followup cacheWrite=${followup.usage.cacheWrite} cacheRead=${followup.usage.cacheRead} input=${followup.usage.input} rate=${followup.hitRate.toFixed(3)}`,
        );

        expect(followup.usage.cacheRead ?? 0).toBeGreaterThan(1_024);
        expect(followup.hitRate).toBeGreaterThanOrEqual(0.3);
      },
      10 * 60_000,
    );
  });
});
