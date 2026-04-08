import { definePluginEntry, type ProviderAuthContext, type ProviderWrapStreamFnContext } from "openclaw/plugin-sdk/plugin-entry";
import { createAssistantMessageEventStream } from "@mariozechner/pi-ai";
import type { StreamFn } from "@mariozechner/pi-agent-core";
import { applyDatabricksConfig, DATABRICKS_DEFAULT_MODEL_REF } from "./api.js";
import { normalizeDatabricksBaseUrl } from "./onboard.js";
import { createProviderApiKeyAuthMethod } from "openclaw/plugin-sdk/provider-auth-api-key";

const PROVIDER_ID = "databricks";

/** Partial local type for AgentMessage to avoid 'any' in mapping. */
interface BaseAgentMessage {
  role: string;
  content: string | unknown[];
  toolCalls?: unknown[];
  toolCallId?: string;
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
      applyConfig: (cfg) => applyDatabricksConfig(cfg),
      wizard: {
        groupId: "databricks",
        groupLabel: "Databricks",
      },
    });

    const originalRun = defaultAuth.run;
    defaultAuth.run = async (ctx: ProviderAuthContext) => {
      const opts = ctx.opts as Record<string, unknown> | undefined;
      let baseUrl = typeof opts?.databricksBaseUrl === "string" ? opts.databricksBaseUrl : undefined;
      if (!baseUrl) {
        baseUrl = await ctx.prompter.text({
          message: "Enter Databricks Workspace Base URL (e.g. https://dbc-xxxx.cloud.databricks.com)",
          validate: (value) => !normalizeDatabricksBaseUrl(value) ? "Databricks Workspace Base URL is required." : undefined,
        });
      }
      const normalizedBaseUrl = normalizeDatabricksBaseUrl(baseUrl);
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
      const baseUrl = normalizeDatabricksBaseUrl(typeof opts?.databricksBaseUrl === "string" ? opts.databricksBaseUrl : undefined);

      const result = await originalRunNonInteractive?.(ctx);
      if (!result || !baseUrl) {
        return result ?? null;
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
          const baseUrl = typeof providerConfig?.baseUrl === "string" ? providerConfig.baseUrl : undefined;
          if (!baseUrl) {
            return null;
          }

          try {
            const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/api/2.0/serving-endpoints`, {
              headers: {
                Authorization: `Bearer ${auth.apiKey}`,
              },
            });
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
          } catch {
            return null;
          }
        },
      },
      wrapStreamFn: (_ctx: ProviderWrapStreamFnContext) => {
        return async (model, context, options) => {
          const streamOptions = options || {};
          const apiKey = streamOptions.apiKey || process.env.DATABRICKS_API_KEY || process.env.DATABRICKS_TOKEN;
          if (!apiKey) {
            throw new Error("Databricks API key not found. Please provide it via config or DATABRICKS_API_KEY environment variable.");
          }

          const baseUrl = normalizeDatabricksBaseUrl(model.baseUrl || "");
          if (!baseUrl) {
            throw new Error("Databricks base URL not found. Please provide it during onboarding or in the configuration.");
          }

          const url = `${baseUrl}/serving-endpoints/${model.id}/invocations`;
          
          const messages = (context.messages || []).map((m: unknown) => {
            const msg = m as BaseAgentMessage;
            return {
              role: msg.role,
              content: msg.content,
              ...(msg.toolCalls ? { tool_calls: msg.toolCalls } : {}),
              ...(msg.toolCallId ? { tool_call_id: msg.toolCallId } : {}),
            };
          });

          const extraParams = (streamOptions as Record<string, unknown>).extraParams as Record<string, unknown> | undefined || {};
          const payload = {
            messages,
            model: model.id,
            stream: true,
            max_tokens: streamOptions.maxTokens,
            temperature: streamOptions.temperature,
            top_p: extraParams.top_p,
            stop: extraParams.stop,
            ...(extraParams.tools ? { tools: extraParams.tools } : {}),
            ...(extraParams.tool_choice ? { tool_choice: extraParams.tool_choice } : {}),
            ...(extraParams.response_format ? { response_format: extraParams.response_format } : {}),
          };

          const eventStream = createAssistantMessageEventStream();
          const stream = eventStream as { push(event: unknown): void; end(): void };
          const output: Record<string, unknown> = {
            role: "assistant",
            content: [] as unknown[],
            api: model.api,
            provider: model.provider,
            model: model.id,
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
            stopReason: "stop",
            timestamp: Date.now(),
          };

          void (async () => {
            try {
              const response = await fetch(url, {
                method: "POST",
                headers: {
                  "Authorization": `Bearer ${apiKey}`,
                  "Content-Type": "application/json",
                  "Accept": "text/event-stream",
                },
                body: JSON.stringify(payload),
                signal: streamOptions.signal,
              });

              if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`Databricks API error (${response.status}): ${errorText}`);
              }

              const reader = response.body?.getReader();
              if (!reader) {
                throw new Error("Failed to get response reader from Databricks API");
              }

              stream.push({ type: "start", partial: output });

              const decoder = new TextDecoder();
              let buffer = "";

              while (true) {
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
                    break;
                  }

                  const json = JSON.parse(data);
                  const delta = json.choices?.[0]?.delta;
                  if (delta?.content) {
                    const contentList = output.content as Array<{ type: string; text: string }>;
                    if (contentList.length === 0 || contentList[contentList.length - 1].type !== "text") {
                      contentList.push({ type: "text", text: "" });
                      stream.push({ type: "text_start", contentIndex: contentList.length - 1, partial: output });
                    }
                    const textBlock = contentList[contentList.length - 1];
                    textBlock.text += delta.content;
                    stream.push({ type: "text_delta", contentIndex: contentList.length - 1, delta: delta.content, partial: output });
                  }
                  
                  if (json.usage) {
                    const usage = output.usage as Record<string, number>;
                    usage.input = json.usage.prompt_tokens;
                    usage.output = json.usage.completion_tokens;
                    usage.totalTokens = json.usage.total_tokens;
                  }
                  
                  if (json.choices?.[0]?.finish_reason) {
                    output.stopReason = json.choices[0].finish_reason;
                  }
                }
              }

              stream.push({ type: "done", reason: output.stopReason, message: output });
              stream.end();
            } catch (e: unknown) {
              output.stopReason = "error";
              output.errorMessage = e instanceof Error ? e.message : String(e);
              stream.push({ type: "error", reason: "error", error: output });
              stream.end();
            }
          })();

          return eventStream as unknown as ReturnType<StreamFn>;
        };
      },
    });
  },
});
