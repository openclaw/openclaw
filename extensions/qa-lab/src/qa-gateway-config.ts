import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import {
  defaultQaModelForMode,
  isQaFastModeModelRef,
  normalizeQaProviderMode,
  splitQaModelRef,
  type QaProviderMode,
} from "./model-selection.js";

const DISABLED_BUNDLED_CHANNELS = Object.freeze({
  bluebubbles: { enabled: false },
  discord: { enabled: false },
  feishu: { enabled: false },
  googlechat: { enabled: false },
  imessage: { enabled: false },
  irc: { enabled: false },
  line: { enabled: false },
  mattermost: { enabled: false },
  matrix: { enabled: false },
  msteams: { enabled: false },
  qqbot: { enabled: false },
  signal: { enabled: false },
  slack: { enabled: false },
  "synology-chat": { enabled: false },
  telegram: { enabled: false },
  tlon: { enabled: false },
  whatsapp: { enabled: false },
  zalo: { enabled: false },
  zalouser: { enabled: false },
} satisfies Record<string, { enabled: false }>);

export const DEFAULT_QA_CONTROL_UI_ALLOWED_ORIGINS = Object.freeze([
  "http://127.0.0.1:18789",
  "http://localhost:18789",
  "http://127.0.0.1:43124",
  "http://localhost:43124",
]);

export function mergeQaControlUiAllowedOrigins(extraOrigins?: string[]) {
  const normalizedExtra = (extraOrigins ?? [])
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
  return [...new Set([...DEFAULT_QA_CONTROL_UI_ALLOWED_ORIGINS, ...normalizedExtra])];
}

export function buildQaGatewayConfig(params: {
  bind: "loopback" | "lan";
  gatewayPort: number;
  gatewayToken: string;
  providerBaseUrl?: string;
  qaBusBaseUrl: string;
  workspaceDir: string;
  controlUiRoot?: string;
  controlUiAllowedOrigins?: string[];
  controlUiEnabled?: boolean;
  providerMode?: QaProviderMode | "live-openai";
  primaryModel?: string;
  alternateModel?: string;
  imageGenerationModel?: string | null;
  enabledProviderIds?: string[];
  fastMode?: boolean;
}): OpenClawConfig {
  const mockProviderBaseUrl = params.providerBaseUrl ?? "http://127.0.0.1:44080/v1";
  const mockOpenAiProvider: ModelProviderConfig = {
    baseUrl: mockProviderBaseUrl,
    apiKey: "test",
    api: "openai-responses",
    models: [
      {
        id: "gpt-5.4",
        name: "gpt-5.4",
        api: "openai-responses",
        reasoning: false,
        input: ["text", "image"],
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
        },
        contextWindow: 128_000,
        maxTokens: 4096,
      },
      {
        id: "gpt-5.4-alt",
        name: "gpt-5.4-alt",
        api: "openai-responses",
        reasoning: false,
        input: ["text", "image"],
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
        },
        contextWindow: 128_000,
        maxTokens: 4096,
      },
      {
        id: "gpt-image-1",
        name: "gpt-image-1",
        api: "openai-responses",
        reasoning: false,
        input: ["text"],
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
        },
        contextWindow: 128_000,
        maxTokens: 4096,
      },
    ],
  };
  const providerMode = normalizeQaProviderMode(params.providerMode ?? "mock-openai");
  const primaryModel = params.primaryModel ?? defaultQaModelForMode(providerMode);
  const alternateModel =
    params.alternateModel ?? defaultQaModelForMode(providerMode, { alternate: true });
  const modelProviderIds = [primaryModel, alternateModel]
    .map((ref) => splitQaModelRef(ref)?.provider)
    .filter((provider): provider is string => Boolean(provider));
  const imageGenerationModelRef =
    params.imageGenerationModel !== undefined
      ? params.imageGenerationModel
      : providerMode === "mock-openai"
        ? "mock-openai/gpt-image-1"
        : modelProviderIds.includes("openai")
          ? "openai/gpt-image-1"
          : null;
  const selectedProviderIds =
    providerMode === "live-frontier"
      ? [
          ...new Set(
            [...(params.enabledProviderIds ?? []), ...modelProviderIds, imageGenerationModelRef]
              .map((value) =>
                typeof value === "string" ? (splitQaModelRef(value)?.provider ?? value) : null,
              )
              .filter((provider): provider is string => Boolean(provider)),
          ),
        ]
      : [];
  const pluginEntries =
    providerMode === "live-frontier"
      ? Object.fromEntries(selectedProviderIds.map((providerId) => [providerId, { enabled: true }]))
      : {};
  const allowedPlugins =
    providerMode === "live-frontier"
      ? ["memory-core", ...selectedProviderIds, "qa-channel"]
      : ["memory-core", "qa-channel"];
  const liveModelParams =
    providerMode === "live-frontier"
      ? (modelRef: string) => ({
          transport: "sse",
          openaiWsWarmup: false,
          ...(params.fastMode === true || isQaFastModeModelRef(modelRef) ? { fastMode: true } : {}),
        })
      : (_modelRef: string) => ({
          transport: "sse",
          openaiWsWarmup: false,
        });
  const allowedOrigins = mergeQaControlUiAllowedOrigins(params.controlUiAllowedOrigins);

  return {
    plugins: {
      allow: allowedPlugins,
      entries: {
        acpx: {
          enabled: false,
        },
        "memory-core": {
          enabled: true,
        },
        ...pluginEntries,
      },
    },
    agents: {
      defaults: {
        workspace: params.workspaceDir,
        model: {
          primary: primaryModel,
        },
        ...(imageGenerationModelRef
          ? {
              imageGenerationModel: {
                primary: imageGenerationModelRef,
              },
            }
          : {}),
        memorySearch: {
          sync: {
            watch: true,
            watchDebounceMs: 25,
            onSessionStart: true,
            onSearch: true,
          },
        },
        models: {
          [primaryModel]: {
            params: liveModelParams(primaryModel),
          },
          [alternateModel]: {
            params: liveModelParams(alternateModel),
          },
        },
        subagents: {
          allowAgents: ["*"],
          maxConcurrent: 2,
        },
      },
      list: [
        {
          id: "qa",
          default: true,
          model: {
            primary: primaryModel,
          },
          identity: {
            name: "C-3PO QA",
            theme: "Flustered Protocol Droid",
            emoji: "🤖",
            avatar: "avatars/c3po.png",
          },
          subagents: {
            allowAgents: ["*"],
          },
        },
      ],
    },
    memory: {
      backend: "builtin",
    },
    ...(providerMode === "mock-openai"
      ? {
          models: {
            mode: "replace",
            providers: {
              "mock-openai": mockOpenAiProvider,
            },
          },
        }
      : {}),
    gateway: {
      mode: "local",
      bind: params.bind,
      port: params.gatewayPort,
      auth: {
        mode: "token",
        token: params.gatewayToken,
      },
      reload: {
        // QA restart scenarios need deterministic reload timing instead of the
        // much longer production deferral window.
        deferralTimeoutMs: 1_000,
      },
      controlUi: {
        enabled: params.controlUiEnabled ?? true,
        ...((params.controlUiEnabled ?? true) && params.controlUiRoot
          ? { root: params.controlUiRoot }
          : {}),
        ...((params.controlUiEnabled ?? true)
          ? {
              allowInsecureAuth: true,
              allowedOrigins,
            }
          : {}),
      },
    },
    discovery: {
      mdns: {
        mode: "off",
      },
    },
    channels: {
      ...DISABLED_BUNDLED_CHANNELS,
      "qa-channel": {
        enabled: true,
        baseUrl: params.qaBusBaseUrl,
        botUserId: "openclaw",
        botDisplayName: "OpenClaw QA",
        allowFrom: ["*"],
        pollTimeoutMs: 250,
      },
    },
    messages: {
      groupChat: {
        mentionPatterns: ["\\b@?openclaw\\b"],
      },
    },
  } satisfies OpenClawConfig;
}
