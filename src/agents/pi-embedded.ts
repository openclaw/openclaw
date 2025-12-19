import fs from "node:fs/promises";
import path from "node:path";

import {
  Agent,
  type AgentEvent,
  type AppMessage,
  ProviderTransport,
  type ThinkingLevel,
} from "@mariozechner/pi-agent-core";
import {
  type AgentToolResult,
  type Api,
  type AssistantMessage,
  getApiKey,
  getModels,
  getProviders,
  type KnownProvider,
  type Model,
} from "@mariozechner/pi-ai";
import {
  AgentSession,
  messageTransformer,
  SessionManager,
  SettingsManager,
} from "@mariozechner/pi-coding-agent";
import type { ThinkLevel, VerboseLevel } from "../auto-reply/thinking.js";
import {
  createToolDebouncer,
  formatToolAggregate,
} from "../auto-reply/tool-meta.js";
import { emitAgentEvent } from "../infra/agent-events.js";
import { splitMediaFromOutput } from "../media/parse.js";
import { enqueueCommand } from "../process/command-queue.js";
import { resolveUserPath } from "../utils.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "./defaults.js";
import {
  extractAssistantText,
  inferToolMetaFromArgs,
} from "./pi-embedded-utils.js";
import { getAnthropicOAuthToken } from "./pi-oauth.js";
import {
  createClawdisCodingTools,
  sanitizeContentBlocksImages,
} from "./pi-tools.js";
import { buildWorkspaceSkillsPrompt } from "./skills.js";
import { buildAgentSystemPrompt } from "./system-prompt.js";
import { loadWorkspaceBootstrapFiles } from "./workspace.js";

export type EmbeddedPiAgentMeta = {
  sessionId: string;
  provider: string;
  model: string;
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    total?: number;
  };
};

export type EmbeddedPiRunMeta = {
  durationMs: number;
  agentMeta?: EmbeddedPiAgentMeta;
  aborted?: boolean;
};

export type EmbeddedPiRunResult = {
  payloads?: Array<{
    text?: string;
    mediaUrl?: string;
    mediaUrls?: string[];
  }>;
  meta: EmbeddedPiRunMeta;
};

function mapThinkingLevel(level?: ThinkLevel): ThinkingLevel {
  // pi-agent-core supports "xhigh" too; Clawdis doesn't surface it for now.
  if (!level) return "off";
  return level;
}

function isKnownProvider(provider: string): provider is KnownProvider {
  return getProviders().includes(provider as KnownProvider);
}

function resolveModel(
  provider: string,
  modelId: string,
): Model<Api> | undefined {
  if (!isKnownProvider(provider)) return undefined;
  const models = getModels(provider);
  const model = models.find((m) => m.id === modelId);
  return model as Model<Api> | undefined;
}

async function ensureSessionHeader(params: {
  sessionFile: string;
  sessionId: string;
  cwd: string;
  provider: string;
  modelId: string;
  thinkingLevel: ThinkingLevel;
}) {
  const file = params.sessionFile;
  try {
    await fs.stat(file);
    return;
  } catch {
    // create
  }
  await fs.mkdir(path.dirname(file), { recursive: true });
  const entry = {
    type: "session",
    id: params.sessionId,
    timestamp: new Date().toISOString(),
    cwd: params.cwd,
    provider: params.provider,
    modelId: params.modelId,
    thinkingLevel: params.thinkingLevel,
  };
  await fs.writeFile(file, `${JSON.stringify(entry)}\n`, "utf-8");
}

async function getApiKeyForProvider(
  provider: string,
): Promise<string | undefined> {
  if (provider === "anthropic") {
    const oauthToken = await getAnthropicOAuthToken();
    if (oauthToken) return oauthToken;
    const oauthEnv = process.env.ANTHROPIC_OAUTH_TOKEN;
    if (oauthEnv?.trim()) return oauthEnv.trim();
  }
  return getApiKey(provider) ?? undefined;
}

type ContentBlock = AgentToolResult<unknown>["content"][number];

async function sanitizeSessionMessagesImages(
  messages: AppMessage[],
  label: string,
): Promise<AppMessage[]> {
  // We sanitize historical session messages because Anthropic can reject a request
  // if the transcript contains oversized base64 images (see MAX_IMAGE_DIMENSION_PX).
  const out: AppMessage[] = [];
  for (const msg of messages) {
    if (!msg || typeof msg !== "object") {
      out.push(msg);
      continue;
    }

    const role = (msg as { role?: unknown }).role;
    if (role === "toolResult") {
      const toolMsg = msg as Extract<AppMessage, { role: "toolResult" }>;
      const content = Array.isArray(toolMsg.content) ? toolMsg.content : [];
      const nextContent = (await sanitizeContentBlocksImages(
        content as ContentBlock[],
        label,
      )) as unknown as typeof toolMsg.content;
      out.push({ ...toolMsg, content: nextContent });
      continue;
    }

    if (role === "user") {
      const userMsg = msg as Extract<AppMessage, { role: "user" }>;
      const content = userMsg.content;
      if (Array.isArray(content)) {
        const nextContent = (await sanitizeContentBlocksImages(
          content as unknown as ContentBlock[],
          label,
        )) as unknown as typeof userMsg.content;
        out.push({ ...userMsg, content: nextContent });
        continue;
      }
    }

    out.push(msg);
  }
  return out;
}

function formatAssistantErrorText(msg: AssistantMessage): string | undefined {
  if (msg.stopReason !== "error") return undefined;
  const raw = (msg.errorMessage ?? "").trim();
  if (!raw) return "LLM request failed with an unknown error.";

  const invalidRequest = raw.match(
    /"type":"invalid_request_error".*?"message":"([^"]+)"/,
  );
  if (invalidRequest?.[1]) {
    return `LLM request rejected: ${invalidRequest[1]}`;
  }

  // Keep it short for WhatsApp.
  return raw.length > 600 ? `${raw.slice(0, 600)}…` : raw;
}

export async function runEmbeddedPiAgent(params: {
  sessionId: string;
  sessionFile: string;
  workspaceDir: string;
  prompt: string;
  provider?: string;
  model?: string;
  thinkLevel?: ThinkLevel;
  verboseLevel?: VerboseLevel;
  timeoutMs: number;
  runId: string;
  abortSignal?: AbortSignal;
  onPartialReply?: (payload: {
    text?: string;
    mediaUrls?: string[];
  }) => void | Promise<void>;
  onAgentEvent?: (evt: {
    stream: string;
    data: Record<string, unknown>;
  }) => void;
  enqueue?: typeof enqueueCommand;
}): Promise<EmbeddedPiRunResult> {
  const enqueue = params.enqueue ?? enqueueCommand;
  return enqueue(async () => {
    const started = Date.now();
    const resolvedWorkspace = resolveUserPath(params.workspaceDir);
    const prevCwd = process.cwd();

    const provider =
      (params.provider ?? DEFAULT_PROVIDER).trim() || DEFAULT_PROVIDER;
    const modelId = (params.model ?? DEFAULT_MODEL).trim() || DEFAULT_MODEL;
    const model = resolveModel(provider, modelId);
    if (!model) {
      throw new Error(`Unknown model: ${provider}/${modelId}`);
    }

    const thinkingLevel = mapThinkingLevel(params.thinkLevel);

    await fs.mkdir(resolvedWorkspace, { recursive: true });
    await ensureSessionHeader({
      sessionFile: params.sessionFile,
      sessionId: params.sessionId,
      cwd: resolvedWorkspace,
      provider,
      modelId,
      thinkingLevel,
    });

    process.chdir(resolvedWorkspace);
    try {
      const bootstrapFiles =
        await loadWorkspaceBootstrapFiles(resolvedWorkspace);
      const systemPrompt = buildAgentSystemPrompt({
        workspaceDir: resolvedWorkspace,
        bootstrapFiles: bootstrapFiles.map((f) => ({
          name: f.name,
          path: f.path,
          content: f.content,
          missing: f.missing,
        })),
        defaultThinkLevel: params.thinkLevel,
      });
      const systemPromptWithSkills =
        systemPrompt + buildWorkspaceSkillsPrompt(resolvedWorkspace);

      const sessionManager = new SessionManager(false, params.sessionFile);
      const settingsManager = new SettingsManager();

      const agent = new Agent({
        initialState: {
          systemPrompt: systemPromptWithSkills,
          model,
          thinkingLevel,
          // TODO(steipete): Once pi-mono publishes file-magic MIME detection in `read` image payloads,
          // remove `createClawdisCodingTools()` and use upstream `codingTools` again.
          tools: createClawdisCodingTools(),
        },
        messageTransformer,
        queueMode: settingsManager.getQueueMode(),
        transport: new ProviderTransport({
          getApiKey: async (providerName) => {
            const key = await getApiKeyForProvider(providerName);
            if (!key) {
              throw new Error(
                `No API key found for provider "${providerName}"`,
              );
            }
            return key;
          },
        }),
      });

      // Resume messages from the transcript if present.
      const priorRaw = sessionManager.loadSession().messages;
      const prior = await sanitizeSessionMessagesImages(
        priorRaw,
        "session:history",
      );
      if (prior.length > 0) {
        agent.replaceMessages(prior);
      }

      const session = new AgentSession({
        agent,
        sessionManager,
        settingsManager,
      });

      const assistantTexts: string[] = [];
      const toolDebouncer = createToolDebouncer((toolName, metas) => {
        if (!params.onPartialReply) return;
        const text = formatToolAggregate(toolName, metas);
        const { text: cleanedText, mediaUrls } = splitMediaFromOutput(text);
        void params.onPartialReply({
          text: cleanedText,
          mediaUrls: mediaUrls?.length ? mediaUrls : undefined,
        });
      });

      const toolMetas: Array<{ toolName?: string; meta?: string }> = [];
      const toolMetaById = new Map<string, string | undefined>();
      let deltaBuffer = "";
      let lastStreamedAssistant: string | undefined;
      let aborted = Boolean(params.abortSignal?.aborted);

      const unsubscribe = session.subscribe(
        (evt: AgentEvent | { type: string; [k: string]: unknown }) => {
          if (evt.type === "tool_execution_start") {
            const toolName = String(
              (evt as AgentEvent & { toolName: string }).toolName,
            );
            const toolCallId = String(
              (evt as AgentEvent & { toolCallId: string }).toolCallId,
            );
            const args = (evt as AgentEvent & { args: unknown }).args;
            const meta = inferToolMetaFromArgs(toolName, args);
            toolMetaById.set(toolCallId, meta);

            emitAgentEvent({
              runId: params.runId,
              stream: "tool",
              data: {
                phase: "start",
                name: toolName,
                toolCallId,
                args: args as Record<string, unknown>,
              },
            });
            params.onAgentEvent?.({
              stream: "tool",
              data: { phase: "start", name: toolName, toolCallId },
            });
          }

          if (evt.type === "tool_execution_end") {
            const toolName = String(
              (evt as AgentEvent & { toolName: string }).toolName,
            );
            const toolCallId = String(
              (evt as AgentEvent & { toolCallId: string }).toolCallId,
            );
            const isError = Boolean(
              (evt as AgentEvent & { isError: boolean }).isError,
            );
            const meta = toolMetaById.get(toolCallId);
            toolMetas.push({ toolName, meta });
            toolDebouncer.push(toolName, meta);

            emitAgentEvent({
              runId: params.runId,
              stream: "tool",
              data: {
                phase: "result",
                name: toolName,
                toolCallId,
                meta,
                isError,
              },
            });
            params.onAgentEvent?.({
              stream: "tool",
              data: {
                phase: "result",
                name: toolName,
                toolCallId,
                meta,
                isError,
              },
            });
          }

          if (evt.type === "message_update") {
            const msg = (evt as AgentEvent & { message: AppMessage }).message;
            if (msg?.role === "assistant") {
              const assistantEvent = (
                evt as AgentEvent & { assistantMessageEvent?: unknown }
              ).assistantMessageEvent;
              const assistantRecord =
                assistantEvent && typeof assistantEvent === "object"
                  ? (assistantEvent as Record<string, unknown>)
                  : undefined;
              const evtType =
                typeof assistantRecord?.type === "string"
                  ? assistantRecord.type
                  : "";
              if (
                evtType === "text_delta" ||
                evtType === "text_start" ||
                evtType === "text_end"
              ) {
                const chunk =
                  typeof assistantRecord?.delta === "string"
                    ? assistantRecord.delta
                    : typeof assistantRecord?.content === "string"
                      ? assistantRecord.content
                      : "";
                if (chunk) {
                  deltaBuffer += chunk;
                  const next = deltaBuffer.trim();
                  if (next && next !== lastStreamedAssistant) {
                    lastStreamedAssistant = next;
                    const { text: cleanedText, mediaUrls } =
                      splitMediaFromOutput(next);
                    emitAgentEvent({
                      runId: params.runId,
                      stream: "assistant",
                      data: {
                        text: cleanedText,
                        mediaUrls: mediaUrls?.length ? mediaUrls : undefined,
                      },
                    });
                    params.onAgentEvent?.({
                      stream: "assistant",
                      data: {
                        text: cleanedText,
                        mediaUrls: mediaUrls?.length ? mediaUrls : undefined,
                      },
                    });
                    if (params.onPartialReply) {
                      void params.onPartialReply({
                        text: cleanedText,
                        mediaUrls: mediaUrls?.length ? mediaUrls : undefined,
                      });
                    }
                  }
                }
              }
            }
          }

          if (evt.type === "message_end") {
            const msg = (evt as AgentEvent & { message: AppMessage }).message;
            if (msg?.role === "assistant") {
              const text = extractAssistantText(msg as AssistantMessage);
              if (text) assistantTexts.push(text);
              deltaBuffer = "";
            }
          }

          if (evt.type === "agent_end") {
            toolDebouncer.flush();
          }
        },
      );

      const abortTimer = setTimeout(
        () => {
          aborted = true;
          void session.abort();
        },
        Math.max(1, params.timeoutMs),
      );

      let messagesSnapshot: AppMessage[] = [];
      let sessionIdUsed = session.sessionId;
      const onAbort = () => {
        aborted = true;
        void session.abort();
      };
      if (params.abortSignal) {
        if (params.abortSignal.aborted) {
          onAbort();
        } else {
          params.abortSignal.addEventListener("abort", onAbort, { once: true });
        }
      }
      let promptError: unknown | null = null;
      try {
        try {
          await session.prompt(params.prompt);
        } catch (err) {
          promptError = err;
        } finally {
          messagesSnapshot = session.messages.slice();
          sessionIdUsed = session.sessionId;
        }
      } finally {
        clearTimeout(abortTimer);
        unsubscribe();
        toolDebouncer.flush();
        session.dispose();
        params.abortSignal?.removeEventListener?.("abort", onAbort);
      }
      if (promptError && !aborted) {
        throw promptError;
      }

      const lastAssistant = messagesSnapshot
        .slice()
        .reverse()
        .find((m) => (m as AppMessage)?.role === "assistant") as
        | AssistantMessage
        | undefined;

      const usage = lastAssistant?.usage;
      const agentMeta: EmbeddedPiAgentMeta = {
        sessionId: sessionIdUsed,
        provider: lastAssistant?.provider ?? provider,
        model: lastAssistant?.model ?? model.id,
        usage: usage
          ? {
              input: usage.input,
              output: usage.output,
              cacheRead: usage.cacheRead,
              cacheWrite: usage.cacheWrite,
              total: usage.totalTokens,
            }
          : undefined,
      };

      const replyItems: Array<{ text: string; media?: string[] }> = [];

      const errorText = lastAssistant
        ? formatAssistantErrorText(lastAssistant)
        : undefined;
      if (errorText) replyItems.push({ text: errorText });

      const inlineToolResults =
        params.verboseLevel === "on" &&
        !params.onPartialReply &&
        toolMetas.length > 0;
      if (inlineToolResults) {
        for (const { toolName, meta } of toolMetas) {
          const agg = formatToolAggregate(toolName, meta ? [meta] : []);
          const { text: cleanedText, mediaUrls } = splitMediaFromOutput(agg);
          if (cleanedText)
            replyItems.push({ text: cleanedText, media: mediaUrls });
        }
      }

      for (const text of assistantTexts.length
        ? assistantTexts
        : lastAssistant
          ? [extractAssistantText(lastAssistant)]
          : []) {
        const { text: cleanedText, mediaUrls } = splitMediaFromOutput(text);
        if (!cleanedText && (!mediaUrls || mediaUrls.length === 0)) continue;
        replyItems.push({ text: cleanedText, media: mediaUrls });
      }

      const payloads = replyItems
        .map((item) => ({
          text: item.text?.trim() ? item.text.trim() : undefined,
          mediaUrls: item.media?.length ? item.media : undefined,
          mediaUrl: item.media?.[0],
        }))
        .filter(
          (p) =>
            p.text || p.mediaUrl || (p.mediaUrls && p.mediaUrls.length > 0),
        );

      return {
        payloads: payloads.length ? payloads : undefined,
        meta: {
          durationMs: Date.now() - started,
          agentMeta,
          aborted,
        },
      };
    } finally {
      process.chdir(prevCwd);
    }
  });
}
