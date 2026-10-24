import { vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { Model, SimpleStreamOptions } from "../../llm/types.js";
import * as providerRuntime from "../../plugins/provider-hook-runtime.js";
import type { ProviderPlugin } from "../../plugins/types.js";
import type { StreamFn } from "../runtime/index.js";
import { applyExtraParamsToAgent } from "./extra-params.js";
import type { ProviderThinkLevel } from "./utils.js";

type ProviderHook<K extends keyof ProviderPlugin> = Extract<
  ProviderPlugin[K],
  (...args: never[]) => unknown
>;
type ProviderHookCall<K extends keyof ProviderPlugin> = {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  context: Parameters<ProviderHook<K>>[0];
};
export type WrapProviderStreamFnParams = ProviderHookCall<"wrapStreamFn">;
type ProviderRuntimeHook<K extends keyof ProviderPlugin> = (
  params: ProviderHookCall<K>,
) => ReturnType<ProviderHook<K>>;
type ProviderRuntimeDeps = {
  prepareProviderExtraParams: ProviderRuntimeHook<"prepareExtraParams">;
  resolveProviderExtraParamsForTransport: ProviderRuntimeHook<"extraParamsForTransport">;
  wrapProviderStreamFn: ProviderRuntimeHook<"wrapStreamFn">;
};

export const testing = {
  setProviderRuntimeDepsForTest(deps: Partial<ProviderRuntimeDeps> = {}): void {
    vi.spyOn(providerRuntime, "ensureProviderRuntimePluginHandle").mockImplementation(
      (params) =>
        params.runtimeHandle ?? {
          ...params,
          plugin: {
            id: params.provider,
            label: params.provider,
            auth: [],
            prepareExtraParams: (context) =>
              deps.prepareProviderExtraParams?.({ ...params, context }),
            extraParamsForTransport: (context) =>
              deps.resolveProviderExtraParamsForTransport?.({ ...params, context }),
            wrapStreamFn: (context) => deps.wrapProviderStreamFn?.({ ...params, context }),
          },
        },
    );
  },
  resetProviderRuntimeDepsForTest(): void {
    vi.mocked(providerRuntime.ensureProviderRuntimePluginHandle).mockRestore();
  },
};

type ExtraParamsCapture<TPayload extends Record<string, unknown>> = {
  headers?: SimpleStreamOptions["headers"];
  options?: SimpleStreamOptions;
  payload: TPayload;
};

type ExtraParamsApi =
  | "openai-completions"
  | "openai-responses"
  | "openai-chatgpt-responses"
  | "azure-openai-responses";
type RunExtraParamsCaseParams<TPayload extends Record<string, unknown>> = {
  applyModelId?: string;
  applyProvider?: string;
  callerHeaders?: SimpleStreamOptions["headers"];
  cfg?: OpenClawConfig;
  model: Model<ExtraParamsApi>;
  mockProviderRuntime?: boolean;
  options?: SimpleStreamOptions;
  payload: TPayload;
  thinkingLevel?: ProviderThinkLevel;
  workspaceDir?: string;
};

export function runExtraParamsCase<TPayload extends Record<string, unknown>>(
  params: RunExtraParamsCaseParams<TPayload>,
): ExtraParamsCapture<TPayload> {
  const captured: ExtraParamsCapture<TPayload> = { payload: params.payload };
  const baseStreamFn: StreamFn = (model, _context, options) => {
    captured.headers = options?.headers;
    captured.options = options;
    options?.onPayload?.(params.payload, model);
    // Wrappers need push/result/iterate, but no real provider.
    return {
      push() {},
      result: async () => undefined,
      async *[Symbol.asyncIterator]() {},
    } as unknown as ReturnType<StreamFn>;
  };
  const agent = { streamFn: baseStreamFn };

  if (params.mockProviderRuntime === true) {
    testing.setProviderRuntimeDepsForTest();
  }
  try {
    applyExtraParamsToAgent(
      agent,
      params.cfg,
      params.applyProvider ?? params.model.provider,
      params.applyModelId ?? params.model.id,
      undefined,
      params.thinkingLevel,
      undefined,
      params.workspaceDir,
    );
  } finally {
    if (params.mockProviderRuntime === true) {
      testing.resetProviderRuntimeDepsForTest();
    }
  }

  const options = {
    ...params.options,
    headers: params.callerHeaders ?? params.options?.headers,
  };
  void agent.streamFn?.(params.model, { messages: [] }, options);
  return captured;
}
