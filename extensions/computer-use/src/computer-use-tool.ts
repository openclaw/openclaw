import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";

type PluginCfg = {
  executorBaseUrl?: string;
  executorAuthToken?: string;
  defaultProvider?: string;
  defaultModel?: string;
  defaultRequireConfirmation?: boolean;
  defaultMaxSteps?: number;
  defaultTimeoutMs?: number;
};

type ComputerUseAction = "start" | "status" | "confirm" | "cancel";

function readString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizeBaseUrl(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function parseModelRef(value: string | undefined): { provider?: string; model?: string } {
  const ref = readString(value);
  if (!ref) {
    return {};
  }
  const slash = ref.indexOf("/");
  if (slash <= 0 || slash === ref.length - 1) {
    return { model: ref };
  }
  return {
    provider: ref.slice(0, slash),
    model: ref.slice(slash + 1),
  };
}

function ensureAction(params: Record<string, unknown>): ComputerUseAction {
  const action = readString(params.action) ?? "start";
  if (action === "start" || action === "status" || action === "confirm" || action === "cancel") {
    return action;
  }
  throw new Error(`Unsupported action: ${action}`);
}

function ensureTask(params: Record<string, unknown>): string {
  const task = readString(params.task);
  if (!task) {
    throw new Error("task required");
  }
  return task;
}

function ensureTaskId(params: Record<string, unknown>): string {
  const taskId = readString(params.taskId) ?? readString(params.id);
  if (!taskId) {
    throw new Error("taskId required");
  }
  return taskId;
}

function resolveProviderModel(
  api: OpenClawPluginApi,
  params: Record<string, unknown>,
  pluginCfg: PluginCfg,
): { provider: string; model: string } {
  const defaultsModel = api.config?.agents?.defaults?.model;
  const primary =
    typeof defaultsModel === "string"
      ? defaultsModel.trim()
      : (defaultsModel?.primary?.trim() ?? undefined);
  const parsedPrimary = parseModelRef(primary);

  const provider =
    readString(params.provider) ??
    readString(pluginCfg.defaultProvider) ??
    parsedPrimary.provider ??
    "openai";

  const model =
    readString(params.model) ?? readString(pluginCfg.defaultModel) ?? parsedPrimary.model ?? "gpt-5.4";

  return { provider, model };
}

async function httpJson(
  url: string,
  init: RequestInit,
  token?: string,
): Promise<{ status: number; json: unknown }> {
  const headers = new Headers(init.headers ?? {});
  headers.set("content-type", "application/json");
  if (token) {
    headers.set("authorization", `Bearer ${token}`);
  }

  const res = await fetch(url, {
    ...init,
    headers,
  });

  const text = await res.text();
  let json: unknown = {};
  if (text.trim()) {
    try {
      json = JSON.parse(text);
    } catch {
      json = { raw: text };
    }
  }

  if (!res.ok) {
    throw new Error(`Executor request failed (${res.status}): ${JSON.stringify(json)}`);
  }

  return { status: res.status, json };
}

export function createComputerUseTool(api: OpenClawPluginApi) {
  return {
    name: "computer-use",
    label: "Computer Use",
    description: "Start and manage GPT-5.4 computer-use jobs through an external executor service.",
    parameters: Type.Object({
      action: Type.Optional(
        Type.String({
          description: "One of: start, status, confirm, cancel. Defaults to start.",
        }),
      ),
      task: Type.Optional(Type.String({ description: "Task description for a new run." })),
      taskId: Type.Optional(Type.String({ description: "Existing executor task id." })),
      sessionId: Type.Optional(Type.String({ description: "Optional stable session id." })),
      provider: Type.Optional(Type.String({ description: "Model provider override." })),
      model: Type.Optional(Type.String({ description: "Model id override." })),
      executorBaseUrl: Type.Optional(Type.String({ description: "Executor base URL override." })),
      executorAuthToken: Type.Optional(
        Type.String({ description: "Executor bearer token override." }),
      ),
      maxSteps: Type.Optional(Type.Number({ description: "Maximum step budget for a new run." })),
      timeoutMs: Type.Optional(Type.Number({ description: "Timeout budget for a new run." })),
      requireConfirmation: Type.Optional(
        Type.Boolean({ description: "Require executor-side confirmation for risky actions." }),
      ),
      allow: Type.Optional(
        Type.Boolean({ description: "Confirmation decision for a blocked run." }),
      ),
      metadata: Type.Optional(Type.Unknown({ description: "Executor-specific metadata payload." })),
    }),

    async execute(_id: string, params: Record<string, unknown>) {
      const pluginCfg = (api.pluginConfig ?? {}) as PluginCfg;
      const overrideBaseUrl = readString(params.executorBaseUrl);
      const configuredBaseUrl = readString(pluginCfg.executorBaseUrl);
      const baseUrlRaw = overrideBaseUrl ?? configuredBaseUrl;
      if (!baseUrlRaw) {
        throw new Error("computer-use plugin requires executorBaseUrl");
      }
      const baseUrl = normalizeBaseUrl(baseUrlRaw);
      const overrideAuthToken = readString(params.executorAuthToken);
      const configuredAuthToken = readString(pluginCfg.executorAuthToken);
      if (
        overrideBaseUrl &&
        configuredBaseUrl &&
        normalizeBaseUrl(overrideBaseUrl) !== normalizeBaseUrl(configuredBaseUrl) &&
        configuredAuthToken &&
        !overrideAuthToken
      ) {
        throw new Error(
          "executorBaseUrl override requires an explicit executorAuthToken when plugin executorAuthToken is configured",
        );
      }
      const authToken = overrideAuthToken ?? configuredAuthToken;
      const action = ensureAction(params);

      let response: unknown;
      if (action === "start") {
        const task = ensureTask(params);
        const { provider, model } = resolveProviderModel(api, params, pluginCfg);
        response = (
          await httpJson(
            `${baseUrl}/v1/tasks`,
            {
              method: "POST",
              body: JSON.stringify({
                task,
                sessionId: readString(params.sessionId),
                provider,
                model,
                maxSteps: readNumber(params.maxSteps) ?? pluginCfg.defaultMaxSteps,
                timeoutMs: readNumber(params.timeoutMs) ?? pluginCfg.defaultTimeoutMs,
                requireConfirmation:
                  readBoolean(params.requireConfirmation) ??
                  pluginCfg.defaultRequireConfirmation ??
                  true,
                metadata: params.metadata ?? { source: "openclaw" },
              }),
            },
            authToken,
          )
        ).json;
      } else if (action === "status") {
        const taskId = ensureTaskId(params);
        response = (
          await httpJson(
            `${baseUrl}/v1/tasks/${encodeURIComponent(taskId)}`,
            {
              method: "GET",
            },
            authToken,
          )
        ).json;
      } else if (action === "confirm") {
        const taskId = ensureTaskId(params);
        response = (
          await httpJson(
            `${baseUrl}/v1/tasks/${encodeURIComponent(taskId)}/confirm`,
            {
              method: "POST",
              body: JSON.stringify({
                allow: readBoolean(params.allow) ?? false,
              }),
            },
            authToken,
          )
        ).json;
      } else {
        const taskId = ensureTaskId(params);
        response = (
          await httpJson(
            `${baseUrl}/v1/tasks/${encodeURIComponent(taskId)}/cancel`,
            {
              method: "POST",
              body: JSON.stringify({}),
            },
            authToken,
          )
        ).json;
      }

      return {
        content: [{ type: "text", text: JSON.stringify(response, null, 2) }],
        details: {
          action,
          executorBaseUrl: baseUrl,
          json: response,
        },
      };
    },
  };
}
