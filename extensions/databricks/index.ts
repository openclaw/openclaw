import { definePluginEntry, type ProviderAuthContext, type ProviderWrapStreamFnContext } from "openclaw/plugin-sdk/plugin-entry";
import { applyDatabricksConfig, DATABRICKS_DEFAULT_MODEL_REF, normalizeDatabricksBaseUrl } from "./api.js";
import { createProviderApiKeyAuthMethod } from "openclaw/plugin-sdk/provider-auth-api-key";

const PROVIDER_ID = "databricks";

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
              .filter((ep) => ep.endpoint_type === "EXTERNAL_MODEL" || ep.task === "llm/v1/chat")
              .map((ep) => ({
                id: ep.name,
                name: ep.name,
                api: "openai-completions" as const,
                reasoning: false,
                input: ["text"] as ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 4096,
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
      wrapStreamFn: (ctx: ProviderWrapStreamFnContext) => {
        const streamFn = ctx.streamFn;
        if (!streamFn) {
          return undefined;
        }

        return (model, context, options) => {
          const providerConfig = ctx.config?.models?.providers?.[PROVIDER_ID] as
            | undefined
            | { baseUrl?: string };
          const baseUrl = normalizeDatabricksBaseUrl(providerConfig?.baseUrl);

          const nextModel = { ...model };
          if (baseUrl) {
            const urlObj = new URL(
              `${baseUrl}/serving-endpoints/${encodeURIComponent(ctx.modelId)}/invocations`,
            );
            nextModel.baseUrl = urlObj.toString();
          }

          const originalOnPayload = options?.onPayload;
          return streamFn(nextModel, context, {
            ...options,
            onPayload: (payload) => {
              if (payload && typeof payload === "object") {
                const bodyObj = payload as Record<string, unknown>;
                delete bodyObj.store;
                delete bodyObj.background;
                delete bodyObj.service_tier;
              }
              return originalOnPayload?.(payload, model);
            },
          });
        };
      },
    });
  }
});
