import os from "node:os";
import type { OpenClawPluginServiceContextV2 } from "openclaw/plugin-sdk/plugin-entry";
import {
  createTestPluginApi,
  createTestPluginServiceScheduler,
} from "openclaw/plugin-sdk/plugin-test-api";
import { vi } from "vitest";
import type { OpenClawPluginApi } from "./api.js";
import plugin from "./index.js";

export type VoiceCallTestTool = {
  parameters: unknown;
  execute: (
    id: string,
    params: unknown,
    signal?: AbortSignal,
  ) => Promise<{
    content?: Array<{ text?: string }>;
    details: { error?: unknown; success?: boolean; found?: boolean; call?: { state?: string } };
  }>;
};
type ToolFactory = (context: Record<string, unknown>) => VoiceCallTestTool;

export function createVoiceCallServiceContext(
  overrides: Partial<OpenClawPluginServiceContextV2> = {},
): OpenClawPluginServiceContextV2 {
  return {
    config: {},
    stateDir: os.tmpdir(),
    logger: createVoiceCallLogger(),
    scheduler: createTestPluginServiceScheduler(),
    ...overrides,
  };
}

export function createVoiceCallLogger(onError?: (message: string) => void) {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn((message: string) => onError?.(message)),
  };
}

export function registerVoiceCall(
  params: {
    config?: Record<string, unknown>;
    logger?: OpenClawPluginApi["logger"];
    registrationMode?: OpenClawPluginApi["registrationMode"];
    startOnRegistration?: OpenClawPluginServiceContextV2;
  } = {},
) {
  let service: Parameters<OpenClawPluginApi["registerService"]>[0] | undefined;
  let toolFactory: ToolFactory | undefined;
  let cli: Parameters<OpenClawPluginApi["registerCli"]>[0] | undefined;
  const methods = new Map<string, Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1]>();
  const methodScopes = new Map<string, string | undefined>();
  plugin.register(
    createTestPluginApi({
      id: "voice-call",
      name: "Voice Call",
      description: "test",
      version: "0",
      registrationMode: params.registrationMode ?? "full",
      pluginConfig: params.config ?? { provider: "mock" },
      runtime: {
        tts: { textToSpeechTelephony: vi.fn() },
      } as unknown as OpenClawPluginApi["runtime"],
      logger: params.logger ?? createVoiceCallLogger(),
      registerGatewayMethod: (method, handler, options) => {
        methods.set(method, handler);
        methodScopes.set(method, options?.scope);
      },
      registerTool: (registration) => {
        toolFactory =
          typeof registration === "function"
            ? (registration as unknown as ToolFactory)
            : () => registration as unknown as VoiceCallTestTool;
      },
      registerCli: (registrar) => {
        cli = registrar;
      },
      registerService: (registered) => {
        service = registered;
        if (params.startOnRegistration) {
          if (registered.apiVersion !== 2) {
            throw new Error("Expected scheduler-owned voice-call service");
          }
          void registered.start(params.startOnRegistration);
        }
      },
    }),
  );
  if (!service || !toolFactory || !cli) {
    throw new Error("Missing voice-call registration");
  }
  const factory = toolFactory;
  return { service, toolFactory: factory, cli, methods, methodScopes, tool: () => factory({}) };
}
