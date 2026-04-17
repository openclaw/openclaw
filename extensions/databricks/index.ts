import type { StreamFn } from "@mariozechner/pi-agent-core";
import { createAssistantMessageEventStream } from "@mariozechner/pi-ai";
import {
  definePluginEntry,
  type ProviderAuthContext,
  type ProviderWrapStreamFnContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { createProviderApiKeyAuthMethod } from "openclaw/plugin-sdk/provider-auth-api-key";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { DATABRICKS_DEFAULT_MODEL_REF } from "./api.js";
import { normalizeDatabricksBaseUrl } from "./onboard.js";

const PROVIDER_ID = "databricks";

/** Partial local type for AgentMessage to avoid 'any' in mapping. */
interface BaseAgentMessage {
  role: string;
  content: string | AssistantContentBlock[];
  toolCalls?: unknown[];
  toolCallId?: string;
  name?: string;
  stopReason?: string;
}

interface OpenAIChatMessage {
  role: string;
  content: string | unknown[] | null;
  tool_calls?: unknown[];
  tool_call_id?: string;
  name?: string;
}

/**
 * Represents a content block in an assistant message as stored in replay history.
 * Covers text, thinking, and toolCall block shapes we need to handle.
 */
interface AssistantContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  redacted?: boolean;
  id?: string;
  name?: string;
  partialArgs?: string;
  arguments?: unknown;
}

/**
 * Flatten content to a plain text string for Databricks/OpenAI wire format.
 * Handles plain strings, block arrays (filtering for text-type blocks), and
 * unknown shapes by falling back to empty string.
 */
function extractTextContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return (content as Array<{ type?: string; text?: string }>)
    .filter(
      (part): part is { type: string; text: string } =>
        typeof part === "object" &&
        part !== null &&
        part.type === "text" &&
        typeof part.text === "string",
    )
    .map((part) => part.text)
    .join("");
}

function mapDatabricksMessages(context: {
  messages: unknown[];
  systemPrompt?: string;
}): OpenAIChatMessage[] {
  // --- Replay normalization pass ---
  // Mirrors the essential repairs from core's transport-message-transform:
  // 1. Strip thinking/redacted blocks (not supported by Databricks/OpenAI wire format).
  // 2. Insert synthetic tool-result stubs for dangling assistant tool calls that have no
  //    paired toolResult, so interrupted/resumed sessions don't send invalid turn ordering.
  interface NormalizedMessage {
    role: string;
    content: string | AssistantContentBlock[];
    toolCalls?: Array<{ id: string; name: string }>;
    toolCallId?: string;
    name?: string;
    stopReason?: string;
  }

  const normalized: NormalizedMessage[] = [];
  let pendingToolCalls: Array<{ id: string; name: string }> = [];
  let seenToolResultIds = new Set<string>();

  for (const m of context.messages) {
    const msg = m as BaseAgentMessage;

    if (msg.role === "assistant") {
      // Flush dangling tool calls from previous assistant turn that had no results
      if (pendingToolCalls.length > 0) {
        for (const tc of pendingToolCalls) {
          if (!seenToolResultIds.has(tc.id)) {
            normalized.push({
              role: "toolResult",
              content: "No result provided",
              toolCallId: tc.id,
              name: tc.name,
            });
          }
        }
        pendingToolCalls = [];
        seenToolResultIds = new Set();
      }

      // Skip error/aborted assistant turns
      if (msg.stopReason === "error" || msg.stopReason === "aborted") {
        continue;
      }

      // Strip thinking/redacted blocks from assistant content; retain text and toolCall blocks.
      // When content is a plain string (common in older transcripts / some provider paths),
      // wrap it in a synthetic text block so it survives the block-level filtering below.
      const rawContent = Array.isArray(msg.content)
        ? msg.content
        : typeof msg.content === "string" && msg.content
          ? [{ type: "text", text: msg.content }]
          : [];
      const strippedContent: AssistantContentBlock[] = [];
      const newToolCalls: Array<{ id: string; name: string }> = [];

      for (const block of rawContent) {
        if (block.type === "thinking" || block.type === "redacted_thinking") {
          // Convert non-empty thinking to a text block for context, skip empty/redacted
          if (!block.redacted && block.thinking && block.thinking.trim()) {
            strippedContent.push({ type: "text", text: block.thinking });
          }
          continue;
        }
        if (block.type === "toolCall") {
          strippedContent.push(block);
          if (block.id) {
            newToolCalls.push({ id: block.id, name: block.name ?? "" });
          }
          continue;
        }
        strippedContent.push(block);
      }

      pendingToolCalls = newToolCalls;
      seenToolResultIds = new Set();
      // Only role, content, and stopReason are relevant for assistant messages in the
      // normalized form. toolCalls live inside content blocks (type: "toolCall"), and
      // toolCallId/name are only meaningful on toolResult messages.
      normalized.push({ role: msg.role, content: strippedContent, stopReason: msg.stopReason });
      continue;
    }

    if (msg.role === "toolResult") {
      const toolCallId = msg.toolCallId ?? "";
      seenToolResultIds.add(toolCallId);
      normalized.push(msg as NormalizedMessage);
      continue;
    }

    // Flush dangling tool calls before non-assistant, non-toolResult messages (e.g. user)
    if (pendingToolCalls.length > 0) {
      for (const tc of pendingToolCalls) {
        if (!seenToolResultIds.has(tc.id)) {
          normalized.push({
            role: "toolResult",
            content: "No result provided",
            toolCallId: tc.id,
            name: tc.name,
          });
        }
      }
      pendingToolCalls = [];
      seenToolResultIds = new Set();
    }

    normalized.push(msg as NormalizedMessage);
  }

  // --- OpenAI wire-format conversion ---
  const result: OpenAIChatMessage[] = [];
  if (context.systemPrompt) {
    result.push({ role: "system", content: context.systemPrompt });
  }
  for (const msg of normalized) {
    const role = msg.role === "toolResult" ? "tool" : msg.role;

    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      // Map assistant content blocks to OpenAI tool_calls wire format
      const contentBlocks = msg.content;
      const textBlocks = contentBlocks.filter((b) => b.type === "text");
      const toolCallBlocks = contentBlocks.filter((b) => b.type === "toolCall");

      const textContent = textBlocks.map((b) => b.text ?? "").join("") || null;
      const tool_calls =
        toolCallBlocks.length > 0
          ? toolCallBlocks.map((b, i) => ({
              id: b.id ?? `call_${i}`,
              type: "function",
              function: {
                name: b.name ?? "",
                arguments:
                  typeof b.arguments === "string"
                    ? b.arguments
                    : (b.partialArgs ?? JSON.stringify(b.arguments ?? {})),
              },
            }))
          : undefined;

      result.push({
        role,
        content: textContent,
        ...(tool_calls ? { tool_calls } : {}),
      });
      continue;
    }

    // Flatten content block arrays to a text string for all non-assistant roles
    // (user, system, tool) so the outbound payload matches the OpenAI/Databricks
    // text-only expectation. Block-array user messages (e.g. replayed sessions
    // stored as [{type:"text",text:"..."}]) would otherwise be sent as null.
    const content = extractTextContent(msg.content) || null;

    result.push({
      role,
      content,
      ...(msg.toolCallId ? { tool_call_id: msg.toolCallId } : {}),
      ...(msg.name ? { name: msg.name } : {}),
    });
  }
  return result;
}

function mapDatabricksTools(tools: unknown[] | undefined) {
  if (!tools || tools.length === 0) {
    return undefined;
  }
  return tools.map((tool) => {
    const t = tool as Record<string, unknown>;
    return {
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    };
  });
}

function mapDatabricksStopReason(reason: string | null | undefined): string {
  if (!reason) {
    return "stop";
  }
  switch (reason) {
    case "stop":
    case "end":
      return "stop";
    case "length":
      return "length";
    case "function_call":
    case "tool_calls":
      return "toolUse";
    case "content_filter":
      return "error";
    default:
      return "stop";
  }
}

export default definePluginEntry({
  id: PROVIDER_ID,
  name: "Databricks Provider",
  description: "Bundled Databricks Serving provider plugin",
  register(api) {
    const defaultAuth = createProviderApiKeyAuthMethod({
      providerId: PROVIDER_ID,
      methodId: "api-key",
      label: "Databricks API key",
      hint: "API key or token",
      optionKey: "databricksApiKey",
      flagName: "--databricks-api-key",
      envVar: "DATABRICKS_API_KEY",
      promptMessage: "Enter Databricks API key",
      defaultModel: DATABRICKS_DEFAULT_MODEL_REF,
      wizard: {
        groupId: "databricks",
        groupLabel: "Databricks",
      },
    });

    const originalRun = defaultAuth.run;
    defaultAuth.run = async (ctx: ProviderAuthContext) => {
      const opts = ctx.opts as Record<string, unknown> | undefined;
      const rawBaseUrl =
        (typeof opts?.databricksBaseUrl === "string" ? opts.databricksBaseUrl : undefined) ??
        process.env.DATABRICKS_BASE_URL;

      // Prompt for a valid base URL.  If the CLI-provided value normalizes to empty
      // (e.g. whitespace-only), the user is asked to re-enter so the config is never
      // left without a baseUrl that would fail at runtime.
      const promptForBaseUrl = async () =>
        ctx.prompter.text({
          message:
            "Enter Databricks Workspace Base URL (e.g. https://dbc-xxxx.cloud.databricks.com)",
          validate: (value) => {
            if (value?.trim().startsWith("http://")) {
              return "HTTPS is required — Databricks URLs must use https://.";
            }
            return !normalizeDatabricksBaseUrl(value)
              ? "Databricks Workspace Base URL is required."
              : undefined;
          },
        });

      const normalizedBaseUrl =
        normalizeDatabricksBaseUrl(rawBaseUrl) ??
        normalizeDatabricksBaseUrl(await promptForBaseUrl());

      if (!normalizedBaseUrl) {
        return originalRun(ctx);
      }

      const result = await originalRun(ctx);

      const existingPatch = result.configPatch ?? {};
      const providersPatch = existingPatch.models?.providers ?? {};
      const databricksPatch = providersPatch[PROVIDER_ID] ?? {};
      result.configPatch = {
        ...existingPatch,
        models: {
          ...existingPatch.models,
          providers: {
            ...providersPatch,
            [PROVIDER_ID]: {
              ...databricksPatch,
              baseUrl: normalizedBaseUrl,
            },
          },
        },
      };
      return result;
    };

    const originalRunNonInteractive = defaultAuth.runNonInteractive;
    defaultAuth.runNonInteractive = async (ctx) => {
      const opts = ctx.opts as Record<string, unknown> | undefined;
      const configProviders = (
        ctx.config as Record<string, unknown> & {
          models?: { providers?: Record<string, { baseUrl?: string }> };
        }
      ).models?.providers;
      const savedBaseUrl = configProviders?.[PROVIDER_ID]?.baseUrl;

      const baseUrl =
        normalizeDatabricksBaseUrl(
          typeof opts?.databricksBaseUrl === "string" ? opts.databricksBaseUrl : undefined,
        ) ??
        normalizeDatabricksBaseUrl(process.env.DATABRICKS_BASE_URL) ??
        // Fallback to an already-configured base URL so key-rotation/automation flows
        // that omit --databricks-base-url still succeed when the URL is persisted.
        normalizeDatabricksBaseUrl(typeof savedBaseUrl === "string" ? savedBaseUrl : undefined);

      // Reject incomplete non-interactive setup: baseUrl is required for Databricks to work.
      // Failing early here prevents an invalid config from being saved and deferring the
      // error to runtime on the first API call.
      if (!baseUrl) {
        return null;
      }

      const result = await originalRunNonInteractive?.(ctx);
      if (!result) {
        return null;
      }

      const existingPatch = result.models?.providers ?? {};
      const databricksPatch = existingPatch[PROVIDER_ID] ?? {};

      return {
        ...result,
        models: {
          ...result.models,
          providers: {
            ...existingPatch,
            [PROVIDER_ID]: {
              ...databricksPatch,
              baseUrl,
            },
          },
        },
      };
    };

    api.registerProvider({
      id: PROVIDER_ID,
      label: "Databricks",
      docsPath: "/providers/databricks",
      auth: [defaultAuth],
      catalog: {
        order: "simple",
        run: async (ctx) => {
          const auth = ctx.resolveProviderApiKey(PROVIDER_ID);
          if (!auth.apiKey) {
            return null;
          }

          const providerConfig = ctx.config.models?.providers?.[PROVIDER_ID];
          const baseUrl = normalizeDatabricksBaseUrl(
            typeof providerConfig?.baseUrl === "string" ? providerConfig.baseUrl : undefined,
          );
          if (!baseUrl) {
            return null;
          }

          try {
            const { response: res, release } = await fetchWithSsrFGuard({
              url: `${baseUrl}/api/2.0/serving-endpoints`,
              init: {
                headers: {
                  Authorization: `Bearer ${auth.apiKey}`,
                },
              },
            });
            try {
              if (!res.ok) {
                return null;
              }

              const data = (await res.json()) as {
                endpoints?: Array<{ name: string; endpoint_type: string; task: string }>;
              };
              if (!data || !Array.isArray(data.endpoints)) {
                return null;
              }

              const models = data.endpoints
                .filter((ep) => ep.task === "llm/v1/chat")
                .map((ep) => ({
                  id: ep.name,
                  name: ep.name,
                  api: "openai-completions" as const,
                  reasoning: false,
                  input: ["text"] as ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 128000,
                  maxTokens: 4096,
                }));

              return {
                provider: {
                  baseUrl,
                  api: "openai-completions",
                  models,
                },
              };
            } finally {
              await release();
            }
          } catch {
            return null;
          }
        },
      },
      wrapStreamFn: (_ctx: ProviderWrapStreamFnContext) => {
        return async (model, context, options) => {
          const streamOptions = options || {};
          // Accept both DATABRICKS_API_KEY and DATABRICKS_TOKEN env vars (Databricks PATs are
          // commonly stored as DATABRICKS_TOKEN in standard Databricks CLI tooling).
          const apiKey =
            streamOptions.apiKey ?? process.env.DATABRICKS_API_KEY ?? process.env.DATABRICKS_TOKEN;
          if (!apiKey) {
            throw new Error(
              "Databricks API key not found. Set DATABRICKS_API_KEY or DATABRICKS_TOKEN, or configure it via openclaw auth.",
            );
          }

          const baseUrl = normalizeDatabricksBaseUrl(model.baseUrl || "");
          if (!baseUrl) {
            throw new Error(
              "Databricks base URL not found. Please provide it during onboarding or in the configuration.",
            );
          }

          const messages = mapDatabricksMessages(context);
          const tools = mapDatabricksTools(context.tools);
          const toolChoice = (streamOptions as Record<string, unknown>).toolChoice;

          const extraParams =
            ((streamOptions as Record<string, unknown>).extraParams as
              | Record<string, unknown>
              | undefined) || {};
          const payload = {
            messages,
            model: model.id,
            stream: true,
            max_tokens: streamOptions.maxTokens,
            temperature: streamOptions.temperature,
            top_p: extraParams.top_p,
            stop: extraParams.stop,
            ...(tools ? { tools } : {}),
            ...(toolChoice ? { tool_choice: toolChoice } : {}),
            ...(extraParams.response_format
              ? { response_format: extraParams.response_format }
              : {}),
          };

          const eventStream = createAssistantMessageEventStream();
          const stream = eventStream as { push(event: unknown): void; end(): void };
          const output: Record<string, unknown> = {
            role: "assistant",
            content: [] as unknown[],
            api: model.api,
            provider: model.provider,
            model: model.id,
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "stop",
            timestamp: Date.now(),
          };

          void (async () => {
            try {
              const url = `${baseUrl}/serving-endpoints/${model.id}/invocations`;
              const mergedHeaders = {
                Authorization: `Bearer ${apiKey}`,
                "Content-Type": "application/json",
                Accept: "text/event-stream",
                ...(model.headers as Record<string, string>),
                ...(streamOptions.headers as Record<string, string>),
              };

              const { response, release: releaseStream } = await fetchWithSsrFGuard({
                url,
                init: {
                  method: "POST",
                  headers: mergedHeaders,
                  body: JSON.stringify(payload),
                },
                signal: streamOptions.signal,
              });

              if (!response.ok) {
                await releaseStream();
                const errorText = await response.text();
                throw new Error(`Databricks API error (${response.status}): ${errorText}`);
              }

              const reader = response.body?.getReader();
              if (!reader) {
                await releaseStream();
                throw new Error("Failed to get response reader from Databricks API");
              }

              try {
                stream.push({ type: "start", partial: output });

                const decoder = new TextDecoder();
                let buffer = "";

                const toolCallIndexMap = new Map<number, number>();

                outerLoop: while (true) {
                  const { done, value } = await reader.read();
                  if (done) {
                    break;
                  }

                  buffer += decoder.decode(value, { stream: true });
                  const lines = buffer.split("\n");
                  buffer = lines.pop() || "";

                  for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed || !trimmed.startsWith("data: ")) {
                      continue;
                    }
                    const data = trimmed.slice(6);
                    if (data === "[DONE]") {
                      await reader.cancel().catch(() => {});
                      break outerLoop;
                    }

                    let json: Record<string, unknown>;
                    try {
                      json = JSON.parse(data);
                    } catch {
                      continue;
                    }
                    const choice = (
                      json.choices as Array<Record<string, unknown>> | undefined
                    )?.[0];
                    const delta = choice?.delta as Record<string, unknown> | undefined;
                    const blockIndex = () => (output.content as Array<unknown>).length - 1;

                    if (delta?.content) {
                      const deltaContent = delta.content as string;
                      const contentList = output.content as Array<{ type: string; text: string }>;
                      if (
                        contentList.length === 0 ||
                        contentList[contentList.length - 1].type !== "text"
                      ) {
                        contentList.push({ type: "text", text: "" });
                        stream.push({
                          type: "text_start",
                          contentIndex: blockIndex(),
                          partial: output,
                        });
                      }
                      const textBlock = contentList[contentList.length - 1] as { text: string };
                      textBlock.text += deltaContent;
                      stream.push({
                        type: "text_delta",
                        contentIndex: blockIndex(),
                        delta: deltaContent,
                        partial: output,
                      });
                    }

                    if (delta?.tool_calls) {
                      for (const toolCall of delta.tool_calls as Array<{
                        index?: number;
                        id?: string;
                        function?: { name?: string; arguments?: string };
                      }>) {
                        const contentList = output.content as Array<Record<string, unknown>>;
                        const sseIndex = typeof toolCall.index === "number" ? toolCall.index : 0;

                        let contentIndex = toolCallIndexMap.get(sseIndex);
                        if (contentIndex === undefined) {
                          const newBlock = {
                            type: "toolCall",
                            id: toolCall.id || "",
                            name: toolCall.function?.name || "",
                            arguments: {},
                            partialArgs: "",
                          };
                          contentList.push(newBlock);
                          contentIndex = contentList.length - 1;
                          toolCallIndexMap.set(sseIndex, contentIndex);
                          stream.push({ type: "toolcall_start", contentIndex, partial: output });
                        }

                        const currentBlock = contentList[contentIndex];

                        if (toolCall.id) {
                          currentBlock.id = toolCall.id;
                        }
                        if (toolCall.function?.name) {
                          currentBlock.name = toolCall.function.name;
                        }
                        if (toolCall.function?.arguments) {
                          currentBlock.partialArgs =
                            (currentBlock.partialArgs as string) + toolCall.function.arguments;
                          stream.push({
                            type: "toolcall_delta",
                            contentIndex,
                            delta: toolCall.function.arguments,
                            partial: output,
                          });
                        }
                      }
                    }

                    if (json.usage) {
                      const jsonUsage = json.usage as Record<string, number>;
                      const usage = output.usage as Record<string, number>;
                      usage.input = jsonUsage.prompt_tokens;
                      usage.output = jsonUsage.completion_tokens;
                      usage.totalTokens = jsonUsage.total_tokens;
                    }

                    if (choice?.finish_reason) {
                      output.stopReason = mapDatabricksStopReason(choice.finish_reason as string);
                    }
                  }
                }

                stream.push({ type: "done", reason: output.stopReason, message: output });
                stream.end();
              } finally {
                await releaseStream();
              }
            } catch (e: unknown) {
              // Preserve aborted stop reason: AbortError means the caller cancelled the
              // stream intentionally (e.g. user hit stop), so report "aborted" not "error".
              const isAbort =
                e instanceof Error && (e.name === "AbortError" || e.name === "TimeoutError");
              output.stopReason = isAbort ? "aborted" : "error";
              output.errorMessage = e instanceof Error ? e.message : String(e);
              stream.push({
                type: isAbort ? "done" : "error",
                reason: output.stopReason,
                ...(isAbort ? { message: output } : { error: output }),
              });
              stream.end();
            }
          })();

          return eventStream as unknown as ReturnType<StreamFn>;
        };
      },
    });
  },
});
