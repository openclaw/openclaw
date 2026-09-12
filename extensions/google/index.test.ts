// Google tests cover index plugin behavior.
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { Context, Model } from "openclaw/plugin-sdk/llm";
import type {
  ProviderReplaySessionEntry,
  ProviderSanitizeReplayHistoryContext,
} from "openclaw/plugin-sdk/plugin-entry";
import {
  createCapturedPluginRegistration,
  registerProviderPlugin,
  requireRegisteredProvider,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { createCapturedThinkingConfigStream } from "openclaw/plugin-sdk/provider-test-contracts";
import type {
  RealtimeVoiceBridge,
  RealtimeVoiceBridgeCreateRequest,
} from "openclaw/plugin-sdk/realtime-voice";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerGoogleGeminiCliProvider } from "./gemini-cli-provider.js";
import googlePlugin from "./index.js";
import googleProviderDiscovery from "./provider-discovery.js";
import { registerGoogleProvider } from "./provider-registration.js";
import { createMockRealtimeBridge } from "./realtime-voice-lazy.test-helpers.js";

const { createRealtimeBridgeMock } = vi.hoisted(() => ({
  createRealtimeBridgeMock: vi.fn<(req: RealtimeVoiceBridgeCreateRequest) => RealtimeVoiceBridge>(),
}));

vi.mock("./realtime-voice-provider.js", () => ({
  buildGoogleRealtimeVoiceProvider: () => ({
    id: "google",
    label: "Google Live Voice",
    createBridge: createRealtimeBridgeMock,
  }),
}));

const googleProviderPlugin = {
  register(api: Parameters<typeof registerGoogleProvider>[0]) {
    registerGoogleProvider(api);
    registerGoogleGeminiCliProvider(api);
  },
};

function createLazyRealtimeBridge(
  onError = vi.fn(),
  onReady?: () => void,
  onClose?: (reason: "completed" | "error") => void,
  callbacks: Partial<RealtimeVoiceBridgeCreateRequest> = {},
) {
  const captured = createCapturedPluginRegistration({ id: "google" });
  googlePlugin.register(captured.api);
  const realtimeProvider = captured.realtimeVoiceProviders.find(
    (provider) => provider.id === "google",
  );
  const bridge = realtimeProvider?.createBridge({
    providerConfig: { apiKey: "gemini-key" },
    onAudio() {},
    onClearAudio() {},
    onError,
    onReady,
    onClose,
    ...callbacks,
  });
  if (!bridge) {
    throw new Error("expected Google realtime bridge");
  }
  return { bridge, onError };
}

function signalRealtimeBridgeReady() {
  const request = createRealtimeBridgeMock.mock.calls.at(-1)?.[0];
  if (!request) {
    throw new Error("expected Google realtime bridge request");
  }
  request.onReady?.();
}

function signalRealtimeBridgeClose(reason: "completed" | "error") {
  const request = createRealtimeBridgeMock.mock.calls.at(-1)?.[0];
  if (!request) {
    throw new Error("expected Google realtime bridge request");
  }
  request.onClose?.(reason);
}

describe("google provider plugin hooks", () => {
  beforeEach(() => {
    createRealtimeBridgeMock.mockReset();
  });

  it("owns replay policy and reasoning mode for the direct Gemini provider", async () => {
    const { providers } = await registerProviderPlugin({
      plugin: googleProviderPlugin,
      id: "google",
      name: "Google Provider",
    });
    const provider = requireRegisteredProvider(providers, "google");
    const customEntries: ProviderReplaySessionEntry[] = [];

    expect(
      provider.buildReplayPolicy?.({
        provider: "google",
        modelApi: "google-generative-ai",
        modelId: "gemini-3.1-pro-preview",
      } as never),
    ).toEqual({
      sanitizeMode: "full",
      appendOnlyRuntimeContext: false,
      sanitizeToolCallIds: true,
      toolCallIdMode: "strict",
      sanitizeThoughtSignatures: {
        allowBase64Only: true,
        includeCamelCase: true,
      },
      repairToolUseResultPairing: true,
      applyAssistantFirstOrderingFix: true,
      validateGeminiTurns: true,
      validateAnthropicTurns: false,
      allowSyntheticToolResults: true,
    });

    expect(
      provider.resolveReasoningOutputMode?.({
        provider: "google",
        modelApi: "google-generative-ai",
        modelId: "gemini-3.1-pro-preview",
      } as never),
    ).toBe("native");
    expect(
      provider.resolveReasoningOutputMode?.({
        provider: "google",
        modelId: "gemini-3.1-pro-preview",
      } as never),
    ).toBe("native");

    const sanitized = await Promise.resolve(
      provider.sanitizeReplayHistory?.({
        provider: "google",
        modelApi: "google-generative-ai",
        modelId: "gemini-3.1-pro-preview",
        sessionId: "session-1",
        messages: [
          {
            role: "assistant",
            content: [{ type: "text", text: "hello" }],
          },
        ],
        sessionState: {
          getCustomEntries: () => customEntries,
          appendCustomEntry: (customType: string, data: unknown) => {
            customEntries.push({ customType, data });
          },
        },
      } as ProviderSanitizeReplayHistoryContext),
    );

    const bootstrapMessage = sanitized?.[0] as
      | { role?: string; content?: unknown; timestamp?: unknown }
      | undefined;
    expect(bootstrapMessage?.role).toBe("user");
    expect(bootstrapMessage?.content).toBe("(session bootstrap)");
    expect(typeof bootstrapMessage?.timestamp).toBe("number");
    expect(sanitized?.[1]).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "hello" }],
    });
    expect(customEntries).toHaveLength(1);
    expect(customEntries[0]?.customType).toBe("google-turn-ordering-bootstrap");
  });

  it("keeps google-gemini-cli on tagged reasoning mode", async () => {
    const { providers } = await registerProviderPlugin({
      plugin: googleProviderPlugin,
      id: "google",
      name: "Google Provider",
    });
    const cliProvider = requireRegisteredProvider(providers, "google-gemini-cli");
    expect(
      cliProvider.resolveReasoningOutputMode?.({
        provider: "google-gemini-cli",
        modelApi: "google-gemini-cli",
        modelId: "gemini-2.5-pro",
      } as never),
    ).toBe("tagged");
  });

  it("keeps the Gemini CLI runtime without OpenClaw-owned OAuth surfaces", async () => {
    const { providers } = await registerProviderPlugin({
      plugin: googleProviderPlugin,
      id: "google",
      name: "Google Provider",
    });
    const cliProvider = requireRegisteredProvider(providers, "google-gemini-cli");

    expect(cliProvider.label).toBe("Gemini CLI runtime");
    expect(cliProvider.auth).toEqual([]);
    expect(cliProvider.envVars).toEqual([]);
    expect(cliProvider.wizard).toBeUndefined();
    expect(cliProvider.refreshOAuth).toBeUndefined();
    expect(cliProvider.resolveUsageAuth).toBeUndefined();
    expect(cliProvider.fetchUsageSnapshot).toBeUndefined();
  });

  it("keeps google-antigravity hook aliases on tagged reasoning mode", async () => {
    const { providers } = await registerProviderPlugin({
      plugin: googleProviderPlugin,
      id: "google",
      name: "Google Provider",
    });
    const provider = requireRegisteredProvider(providers, "google-antigravity");
    expect(
      provider.resolveReasoningOutputMode?.({
        provider: "google-antigravity",
        modelApi: "openai-completions",
        modelId: "gemini-3-pro-low",
      } as never),
    ).toBe("tagged");
  });

  it("keeps google-vertex hook aliases on native reasoning mode", async () => {
    const { providers } = await registerProviderPlugin({
      plugin: googleProviderPlugin,
      id: "google",
      name: "Google Provider",
    });
    const provider = requireRegisteredProvider(providers, "google-vertex");
    expect(
      provider.resolveReasoningOutputMode?.({
        provider: "google-vertex",
        modelApi: "google-vertex",
        modelId: "gemini-3.1-pro-preview",
      } as never),
    ).toBe("native");
    expect(
      provider.resolveReasoningOutputMode?.({
        provider: "google-vertex",
        modelId: "gemini-3.1-pro-preview",
      } as never),
    ).toBe("native");
  });

  it("resolves Google Vertex ADC auth evidence to the config marker", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-google-vertex-config-key-"));
    const credentialsPath = path.join(tempDir, "application_default_credentials.json");
    await writeFile(
      credentialsPath,
      JSON.stringify({
        type: "authorized_user",
        client_id: "client-id",
        client_secret: "client-secret",
        refresh_token: "refresh-token",
      }),
      "utf8",
    );
    const { providers } = await registerProviderPlugin({
      plugin: googleProviderPlugin,
      id: "google",
      name: "Google Provider",
    });
    const provider = requireRegisteredProvider(providers, "google-vertex");

    expect(
      provider.resolveConfigApiKey?.({
        provider: "google-vertex",
        env: {
          GOOGLE_APPLICATION_CREDENTIALS: credentialsPath,
          GOOGLE_CLOUD_PROJECT: "vertex-project",
          GOOGLE_CLOUD_LOCATION: "global",
        },
      }),
    ).toBe("gcp-vertex-credentials");
    expect(
      provider.resolveConfigApiKey?.({
        provider: "google-vertex",
        env: {
          GOOGLE_APPLICATION_CREDENTIALS: credentialsPath,
          GOOGLE_CLOUD_PROJECT: "",
          GCLOUD_PROJECT: "vertex-project",
          GOOGLE_CLOUD_LOCATION: "global",
        },
      }),
    ).toBe("gcp-vertex-credentials");
    expect(
      googleProviderDiscovery.resolveConfigApiKey?.({
        provider: "google-vertex",
        env: {
          GOOGLE_APPLICATION_CREDENTIALS: credentialsPath,
          GOOGLE_CLOUD_PROJECT: "vertex-project",
          GOOGLE_CLOUD_LOCATION: "global",
        },
      }),
    ).toBe("gcp-vertex-credentials");
  });

  it("prefers relocated Google Cloud SDK ADC over the home fallback", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-google-vertex-cloud-sdk-"));
    const cloudSdkDir = path.join(tempDir, "cloud-sdk");
    const homeCredentialsDir = path.join(tempDir, "home", ".config", "gcloud");
    await Promise.all([
      mkdir(cloudSdkDir, { recursive: true }),
      mkdir(homeCredentialsDir, { recursive: true }),
    ]);
    const relocatedCredentialsPath = path.join(cloudSdkDir, "application_default_credentials.json");
    const homeCredentialsPath = path.join(
      homeCredentialsDir,
      "application_default_credentials.json",
    );
    await Promise.all([
      writeFile(
        relocatedCredentialsPath,
        JSON.stringify({
          type: "authorized_user",
          client_id: "fixture-client",
          client_secret: "fixture-secret",
          refresh_token: "fixture-refresh",
        }),
        "utf8",
      ),
      writeFile(homeCredentialsPath, JSON.stringify({ type: "unsupported" }), "utf8"),
    ]);
    const { providers } = await registerProviderPlugin({
      plugin: googleProviderPlugin,
      id: "google",
      name: "Google Provider",
    });
    const provider = requireRegisteredProvider(providers, "google-vertex");
    const env = {
      CLOUDSDK_CONFIG: cloudSdkDir,
      HOME: path.join(tempDir, "home"),
      GOOGLE_CLOUD_PROJECT: "fixture-project",
      GOOGLE_CLOUD_LOCATION: "global",
    };

    expect(provider.resolveConfigApiKey?.({ provider: "google-vertex", env })).toBe(
      "gcp-vertex-credentials",
    );
    expect(googleProviderDiscovery.resolveConfigApiKey?.({ provider: "google-vertex", env })).toBe(
      "gcp-vertex-credentials",
    );
    expect(
      provider.resolveConfigApiKey?.({
        provider: "google-vertex",
        env: { ...env, GOOGLE_APPLICATION_CREDENTIALS: homeCredentialsPath },
      }),
    ).toBeUndefined();

    await writeFile(
      homeCredentialsPath,
      JSON.stringify({
        type: "authorized_user",
        client_id: "stale-client",
        client_secret: "stale-secret",
        refresh_token: "stale-refresh",
      }),
      "utf8",
    );
    const missingRelocatedCredentialsEnv = {
      ...env,
      CLOUDSDK_CONFIG: path.join(tempDir, "missing-cloud-sdk"),
    };
    expect(
      provider.resolveConfigApiKey?.({
        provider: "google-vertex",
        env: missingRelocatedCredentialsEnv,
      }),
    ).toBeUndefined();
    expect(
      googleProviderDiscovery.resolveConfigApiKey?.({
        provider: "google-vertex",
        env: missingRelocatedCredentialsEnv,
      }),
    ).toBeUndefined();
  });

  it("owns Gemini tool schema normalization for direct and CLI providers", async () => {
    const { providers } = await registerProviderPlugin({
      plugin: googleProviderPlugin,
      id: "google",
      name: "Google Provider",
    });
    const providerIds = ["google", "google-gemini-cli"] as const;

    for (const providerId of providerIds) {
      const provider = requireRegisteredProvider(providers, providerId);
      const [tool] =
        provider.normalizeToolSchemas?.({
          provider: providerId,
          tools: [
            {
              name: "write_file",
              description: "Write a file",
              parameters: {
                type: "object",
                additionalProperties: false,
                properties: {
                  path: { type: "string", pattern: "^src/" },
                },
              },
            },
          ],
        } as never) ?? [];

      expect(tool).toEqual({
        name: "write_file",
        description: "Write a file",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string" },
          },
        },
      });
      expect(tool?.parameters).not.toHaveProperty("additionalProperties");
      expect(
        (tool?.parameters as { properties?: { path?: Record<string, unknown> } })?.properties?.path,
      ).not.toHaveProperty("pattern");
      expect(
        provider.inspectToolSchemas?.({
          provider: providerId,
          tools: [tool],
        } as never),
      ).toEqual([]);
    }
  });

  it("wires google-thinking stream hooks for direct and Gemini CLI providers", async () => {
    const { providers } = await registerProviderPlugin({
      plugin: googleProviderPlugin,
      id: "google",
      name: "Google Provider",
    });
    const googleProvider = requireRegisteredProvider(providers, "google");
    const cliProvider = requireRegisteredProvider(providers, "google-gemini-cli");
    const capturedStream = createCapturedThinkingConfigStream();

    const runCase = (provider: typeof googleProvider, providerId: string) => {
      const wrapped = provider.wrapStreamFn?.({
        provider: providerId,
        modelId: "gemini-3.1-pro-preview",
        thinkingLevel: "high",
        streamFn: capturedStream.streamFn,
      } as never);

      void wrapped?.(
        {
          api: "google-generative-ai",
          provider: providerId,
          id: "gemini-3.1-pro-preview",
        } as Model<"google-generative-ai">,
        { messages: [] } as Context,
        {},
      );

      const capturedPayload = capturedStream.getCapturedPayload();
      expect(capturedPayload).toEqual({
        config: {
          thinkingConfig: {
            thinkingLevel: "HIGH",
          },
        },
      });
      const thinkingConfig = (
        (capturedPayload as Record<string, unknown>).config as Record<string, unknown>
      ).thinkingConfig as Record<string, unknown>;
      expect(thinkingConfig).not.toHaveProperty("thinkingBudget");
    };

    runCase(googleProvider, "google");
    runCase(cliProvider, "google-gemini-cli");
  });

  it("wires Vertex transport before request-time metadata ADC detection", async () => {
    const { providers } = await registerProviderPlugin({
      plugin: googleProviderPlugin,
      id: "google",
      name: "Google Provider",
    });
    const provider = requireRegisteredProvider(providers, "google");

    expect(
      provider.createStreamFn?.({
        model: {
          api: "google-vertex",
          provider: "google",
          id: "gemini-2.5-pro",
        },
      } as never),
    ).toEqual(expect.any(Function));
  });

  it("advertises adaptive thinking for Gemini dynamic thinking", async () => {
    const { providers } = await registerProviderPlugin({
      plugin: googleProviderPlugin,
      id: "google",
      name: "Google Provider",
    });
    const provider = requireRegisteredProvider(providers, "google");
    if (!provider.resolveThinkingProfile) {
      throw new Error("expected Google provider thinking profile resolver");
    }
    const resolveThinkingProfile = provider.resolveThinkingProfile;
    const gemini3Profile = resolveThinkingProfile({
      provider: "google",
      modelId: "gemini-3.1-pro-preview",
    } as never);
    const gemini25Profile = resolveThinkingProfile({
      provider: "google",
      modelId: "gemini-2.5-flash",
    } as never);

    expect(gemini3Profile?.levels).toEqual([
      { id: "off" },
      { id: "low" },
      { id: "adaptive" },
      { id: "high" },
    ]);
    expect(gemini25Profile?.levels).toEqual([
      { id: "off" },
      { id: "minimal" },
      { id: "low" },
      { id: "medium" },
      { id: "adaptive" },
      { id: "high" },
    ]);
  });

  it("shares Gemini replay and stream hooks across Google provider variants", async () => {
    const { providers } = await registerProviderPlugin({
      plugin: googleProviderPlugin,
      id: "google",
      name: "Google Provider",
    });
    const googleProvider = requireRegisteredProvider(providers, "google");
    const cliProvider = requireRegisteredProvider(providers, "google-gemini-cli");

    expect(googleProvider.buildReplayPolicy).toBe(cliProvider.buildReplayPolicy);
    expect(googleProvider.wrapStreamFn).toBe(cliProvider.wrapStreamFn);
  });

  it("buffers early realtime audio while the lazy Google bridge loads", () => {
    const { bridge } = createLazyRealtimeBridge();
    expect(bridge.supportsToolResultContinuation).toBe(false);
    expect(bridge.supportsToolResultSuppression).toBe(false);
    expect(bridge.sendAudio(Buffer.alloc(160))).toBeUndefined();
    expect(bridge.setMediaTimestamp(20)).toBeUndefined();
    expect(bridge.sendUserMessage?.("hello")).toBeUndefined();
  });

  it("evicts the oldest lazy audio when the startup chunk limit is reached", async () => {
    const loaded = createMockRealtimeBridge();
    createRealtimeBridgeMock.mockReturnValue(loaded.bridge);
    const { bridge } = createLazyRealtimeBridge();

    for (let index = 0; index < 322; index += 1) {
      bridge.sendAudio(Buffer.from([index & 0xff]));
    }
    await bridge.connect();
    signalRealtimeBridgeReady();

    expect(loaded.sendAudio).toHaveBeenCalledTimes(320);
    expect(loaded.sendAudio.mock.calls[0]?.[0]).toEqual(Buffer.from([2]));
    expect(loaded.sendAudio.mock.calls.at(-1)?.[0]).toEqual(Buffer.from([65]));
  });

  it("preserves lazy audio order across bridge loading and provider readiness", async () => {
    const connected = createDeferred<void>();
    const loaded = createMockRealtimeBridge(() => connected.promise);
    createRealtimeBridgeMock.mockReturnValue(loaded.bridge);
    const { bridge } = createLazyRealtimeBridge();

    bridge.sendAudio(Buffer.from([0x01]));
    const connectPromise = bridge.connect();
    await vi.waitFor(() => expect(loaded.connect).toHaveBeenCalledOnce());
    bridge.sendAudio(Buffer.from([0x02]));

    expect(loaded.sendAudio).not.toHaveBeenCalled();
    connected.resolve();
    await connectPromise;
    expect(loaded.sendAudio).not.toHaveBeenCalled();

    signalRealtimeBridgeReady();
    expect(loaded.sendAudio.mock.calls.map(([audio]) => audio)).toEqual([
      Buffer.from([0x01]),
      Buffer.from([0x02]),
    ]);
  });

  it("copies lazy audio and evicts oldest chunks to enforce the byte limit", async () => {
    const loaded = createMockRealtimeBridge();
    createRealtimeBridgeMock.mockReturnValue(loaded.bridge);
    const { bridge } = createLazyRealtimeBridge();
    const backing = Buffer.alloc(2 * 1024 * 1024, 0x02);
    const retainedView = backing.subarray(0, 512 * 1024);

    bridge.sendAudio(Buffer.alloc(512 * 1024, 0x01));
    bridge.sendAudio(retainedView);
    retainedView.fill(0);
    bridge.sendAudio(Buffer.from([0x03]));
    bridge.sendAudio(Buffer.alloc(1024 * 1024 + 1, 0x04));
    await bridge.connect();
    signalRealtimeBridgeReady();

    expect(loaded.sendAudio).toHaveBeenCalledTimes(2);
    const retainedAudio = loaded.sendAudio.mock.calls[0]?.[0];
    expect(
      Buffer.isBuffer(retainedAudio) && retainedAudio.equals(Buffer.alloc(512 * 1024, 0x02)),
    ).toBe(true);
    expect(loaded.sendAudio.mock.calls[1]?.[0]).toEqual(Buffer.from([0x03]));
  });

  it("clears lazy audio on terminal close and reopens only for an explicit connect", async () => {
    const loaded = createMockRealtimeBridge();
    createRealtimeBridgeMock.mockReturnValue(loaded.bridge);
    const onClose = vi.fn();
    const { bridge } = createLazyRealtimeBridge(vi.fn(), undefined, onClose);

    bridge.sendAudio(Buffer.from([0x01]));
    await bridge.connect();
    signalRealtimeBridgeClose("error");
    bridge.sendAudio(Buffer.from([0x02]));

    expect(onClose).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledWith("error");
    expect(loaded.sendAudio).not.toHaveBeenCalled();

    await bridge.connect();
    signalRealtimeBridgeReady();
    expect(loaded.sendAudio).not.toHaveBeenCalled();

    bridge.sendAudio(Buffer.from([0x03]));
    expect(loaded.sendAudio).toHaveBeenCalledOnce();
    expect(loaded.sendAudio).toHaveBeenCalledWith(Buffer.from([0x03]));
    await bridge.close();
  });

  it("reopens the provider bridge after an explicit close", async () => {
    let firstConnected = false;
    let replacementConnected = false;
    const first = createMockRealtimeBridge(async () => {
      firstConnected = true;
    });
    first.bridge.isConnected = vi.fn(() => firstConnected);
    const replacement = createMockRealtimeBridge(async () => {
      replacementConnected = true;
    });
    replacement.close.mockImplementation(() => {
      replacementConnected = false;
    });
    replacement.bridge.isConnected = vi.fn(() => replacementConnected);
    createRealtimeBridgeMock
      .mockReturnValueOnce(first.bridge)
      .mockReturnValueOnce(replacement.bridge);
    const onReady = vi.fn();
    const onClose = vi.fn();
    const { bridge } = createLazyRealtimeBridge(vi.fn(), onReady, onClose);

    await bridge.connect();
    const firstRequest = createRealtimeBridgeMock.mock.calls[0]?.[0];
    expect(bridge.isConnected()).toBe(true);

    void bridge.close();
    bridge.sendAudio(Buffer.from([0x01]));
    expect(bridge.isConnected()).toBe(false);

    const reconnectPromise = bridge.connect();
    bridge.sendAudio(Buffer.from([0x02]));
    await reconnectPromise;
    signalRealtimeBridgeReady();

    expect(bridge.isConnected()).toBe(true);
    expect(first.close).toHaveBeenCalledOnce();
    expect(first.sendAudio).not.toHaveBeenCalled();
    expect(replacement.connect).toHaveBeenCalledOnce();
    expect(replacement.close).not.toHaveBeenCalled();
    expect(replacement.sendAudio).toHaveBeenCalledExactlyOnceWith(Buffer.from([0x02]));
    firstRequest?.onReady?.();
    firstRequest?.onClose?.("error");
    expect(onReady).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledExactlyOnceWith("completed");
  });

  it("fences a provider generation closed during lazy load before reconnecting", async () => {
    const first = createMockRealtimeBridge();
    const replacement = createMockRealtimeBridge();
    replacement.bridge.isConnected = vi.fn(() => replacement.connect.mock.calls.length > 0);
    createRealtimeBridgeMock
      .mockReturnValueOnce(first.bridge)
      .mockReturnValueOnce(replacement.bridge);
    const { bridge } = createLazyRealtimeBridge();

    const staleConnect = bridge.connect();
    void bridge.close();
    const replacementConnect = bridge.connect();
    bridge.sendAudio(Buffer.from([0x02]));
    await Promise.all([staleConnect, replacementConnect]);
    signalRealtimeBridgeReady();

    expect(first.connect).not.toHaveBeenCalled();
    expect(first.close).toHaveBeenCalledOnce();
    expect(replacement.connect).toHaveBeenCalledOnce();
    expect(replacement.close).not.toHaveBeenCalled();
    expect(replacement.sendAudio).toHaveBeenCalledExactlyOnceWith(Buffer.from([0x02]));
    expect(bridge.isConnected()).toBe(true);
  });

  it.each(
    ["sync", "resolve", "reject"].flatMap((cleanup) =>
      [false, true].map((reenter) => ({ cleanup, reenter })),
    ),
  )(
    "drains connect-failure disposal before terminal notification (cleanup=$cleanup, reenter=$reenter)",
    async ({ cleanup, reenter }) => {
      const failure = new Error("provider connect rejected");
      const cleanupFailure = new Error("provider cleanup rejected");
      const disposed = createDeferred<void>();
      const failed = createMockRealtimeBridge(async () => {
        throw failure;
      });
      const reconnected = createMockRealtimeBridge();
      createRealtimeBridgeMock
        .mockReturnValueOnce(failed.bridge)
        .mockReturnValueOnce(reconnected.bridge);
      let collectorSealed = false;
      const callbackOrder: string[] = [];
      const callbacks = {
        onTranscript: vi.fn((_role: unknown, text: string) => {
          if (!collectorSealed) {
            callbackOrder.push(text);
          }
        }),
        onAudio: vi.fn(),
        onToolCall: vi.fn(),
      };
      const observerCloses: Promise<unknown>[] = [];
      const observer = (value: unknown) => {
        callbackOrder.push(value instanceof Error ? "error" : "close");
        if (reenter) {
          observerCloses.push(
            Promise.resolve(bridge.close())
              .catch(() => undefined)
              .then(() => {
                collectorSealed = true;
              }),
          );
        }
        throw new Error("terminal observer rejected");
      };
      const onError = vi.fn(observer);
      const onClose = vi.fn(observer);
      const { bridge } = createLazyRealtimeBridge(onError, undefined, onClose, callbacks);
      const emitTail = () => {
        const request = createRealtimeBridgeMock.mock.calls[0]?.[0];
        request?.onTranscript?.("assistant", "partial tail", false);
        request?.onAudio(Buffer.from([0x01]));
        request?.onToolCall?.({ itemId: "item", callId: "call", name: "probe", args: {} });
        request?.onTranscript?.("assistant", "final tail", true);
      };
      failed.close.mockImplementationOnce(() => {
        if (cleanup === "sync") {
          emitTail();
          throw cleanupFailure;
        }
        return disposed.promise;
      });
      bridge.sendAudio(Buffer.from([0x01]));
      bridge.sendUserMessage?.("discarded");
      const failedConnect = expect(bridge.connect()).rejects.toBe(failure);
      try {
        await vi.waitFor(() => expect(failed.close).toHaveBeenCalledOnce());
        if (cleanup !== "sync") {
          expect(onClose).not.toHaveBeenCalled();
          emitTail();
        }
        expect(callbacks.onAudio).not.toHaveBeenCalled();
        expect(callbacks.onToolCall).not.toHaveBeenCalled();
        if (cleanup === "reject") {
          disposed.reject(cleanupFailure);
        } else {
          disposed.resolve();
        }
        await failedConnect;
        expect(onError).toHaveBeenCalledExactlyOnceWith(failure);
        expect(onClose).toHaveBeenCalledExactlyOnceWith("error");
        expect(callbackOrder).toEqual(["final tail", "error", "close"]);
        bridge.sendAudio(Buffer.from([0x02]));
        bridge.sendUserMessage?.("also discarded");
        const reconnecting = bridge.connect();
        bridge.sendAudio(Buffer.from([0x03]));
        bridge.sendUserMessage?.("accepted");
        await reconnecting;
        createRealtimeBridgeMock.mock.calls[1]?.[0]?.onReady?.();
        expect(reconnected.sendAudio).toHaveBeenCalledExactlyOnceWith(Buffer.from([0x03]));
        expect(reconnected.sendUserMessage).toHaveBeenCalledExactlyOnceWith("accepted");
      } finally {
        disposed.resolve();
        await failedConnect;
        await Promise.all(observerCloses);
      }
    },
  );

  it("reports one terminal error when concurrent lazy connects reject together", async () => {
    const failure = new Error("shared Google realtime connect rejected");
    const connecting = createDeferred<void>();
    const loaded = createMockRealtimeBridge(() => connecting.promise);
    createRealtimeBridgeMock.mockReturnValue(loaded.bridge);
    const onError = vi.fn();
    const onClose = vi.fn();
    const { bridge } = createLazyRealtimeBridge(onError, undefined, onClose);

    const firstConnect = bridge.connect();
    const secondConnect = bridge.connect();
    const connectResults = Promise.allSettled([firstConnect, secondConnect]);
    await vi.waitFor(() => expect(loaded.connect).toHaveBeenCalledTimes(2));
    connecting.reject(failure);

    expect(await connectResults).toEqual([
      { status: "rejected", reason: failure },
      { status: "rejected", reason: failure },
    ]);
    expect(onError).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith(failure);
    expect(onClose).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledWith("error");
    expect(loaded.close).toHaveBeenCalledOnce();
  });

  it("does not leak a superseded lazy connect rejection into its replacement", async () => {
    const failure = new Error("superseded Google realtime connect rejected");
    const firstConnect = createDeferred<void>();
    const stale = createMockRealtimeBridge(() => firstConnect.promise);
    const replacement = createMockRealtimeBridge();
    createRealtimeBridgeMock
      .mockReturnValueOnce(stale.bridge)
      .mockReturnValueOnce(replacement.bridge);
    const onError = vi.fn();
    const onClose = vi.fn();
    const { bridge } = createLazyRealtimeBridge(onError, undefined, onClose);

    const staleConnect = bridge.connect();
    const staleConnectResult = expect(staleConnect).rejects.toBe(failure);
    await vi.waitFor(() => expect(stale.connect).toHaveBeenCalledOnce());
    signalRealtimeBridgeClose("error");
    await bridge.connect();
    firstConnect.reject(failure);
    await staleConnectResult;

    expect(createRealtimeBridgeMock).toHaveBeenCalledTimes(2);
    expect(replacement.connect).toHaveBeenCalledOnce();
    expect(stale.close).toHaveBeenCalledOnce();
    expect(replacement.close).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledWith("error");
  });

  it("reports explicit lazy realtime close once when the provider also reports completion", async () => {
    const loaded = createMockRealtimeBridge();
    createRealtimeBridgeMock.mockReturnValue(loaded.bridge);
    const onClose = vi.fn();
    const { bridge } = createLazyRealtimeBridge(vi.fn(), undefined, onClose);

    await bridge.connect();
    loaded.close.mockImplementation(() => signalRealtimeBridgeClose("completed"));
    void bridge.close();
    void bridge.close();

    expect(loaded.close).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledWith("completed");
  });

  it.each([
    { reconnect: false, closeDuringLoad: false },
    { reconnect: true, closeDuringLoad: false },
    { reconnect: false, closeDuringLoad: true },
  ])(
    "joins disposal and final transcripts (reconnect=$reconnect, closeDuringLoad=$closeDuringLoad)",
    async ({ reconnect, closeDuringLoad }) => {
      const disposed = createDeferred<void>();
      const first = createMockRealtimeBridge();
      first.close.mockReturnValue(disposed.promise);
      const replacement = createMockRealtimeBridge();
      createRealtimeBridgeMock
        .mockReturnValueOnce(first.bridge)
        .mockReturnValueOnce(replacement.bridge);
      const onClose = vi.fn();
      const onTranscript = vi.fn();
      const { bridge } = createLazyRealtimeBridge(vi.fn(), undefined, onClose, { onTranscript });
      const connecting = bridge.connect();
      if (!closeDuringLoad) {
        await connecting;
        signalRealtimeBridgeReady();
      }

      const closing = bridge.close();
      try {
        expect(bridge.close()).toBe(closing);
        await vi.waitFor(() => expect(first.close).toHaveBeenCalledOnce());
        const firstRequest = createRealtimeBridgeMock.mock.calls[0]?.[0];
        if (closeDuringLoad) {
          expect(first.connect).not.toHaveBeenCalled();
        }
        firstRequest?.onTranscript?.("assistant", "partial tail", false);
        firstRequest?.onTranscript?.("assistant", "final tail", true);
        expect(onTranscript).toHaveBeenCalledExactlyOnceWith("assistant", "final tail", true);
        let settled = false;
        const completion = Promise.resolve(closing).then(() => {
          settled = true;
        });
        bridge.sendAudio(Buffer.from([0x01]));
        await Promise.resolve();
        expect(settled).toBe(false);
        expect(first.close).toHaveBeenCalledOnce();
        expect(first.sendAudio).not.toHaveBeenCalled();
        expect(onClose).not.toHaveBeenCalled();

        if (reconnect) {
          await bridge.connect();
          signalRealtimeBridgeReady();
          firstRequest?.onTranscript?.("assistant", "stale after reconnect", true);
        }
        disposed.resolve();
        await Promise.all([completion, connecting]);
        firstRequest?.onTranscript?.("assistant", "late after disposal", true);
        expect(onTranscript).toHaveBeenCalledExactlyOnceWith("assistant", "final tail", true);
        if (reconnect) {
          expect(onClose).not.toHaveBeenCalled();
          bridge.sendAudio(Buffer.from([0x02]));
          expect(replacement.sendAudio).toHaveBeenCalledExactlyOnceWith(Buffer.from([0x02]));
          await bridge.close();
        }
        expect(onClose).toHaveBeenCalledExactlyOnceWith("completed");
      } finally {
        disposed.resolve();
        await Promise.all([closing, connecting]);
        await bridge.close();
      }
    },
  );

  it.each([false, true])(
    "reports rejected disposal once without replacing its error (throwing observer=%s)",
    async (throwingObserver) => {
      const disposed = createDeferred<void>();
      const failure = new Error("provider disposal rejected");
      const loaded = createMockRealtimeBridge();
      loaded.close.mockReturnValue(disposed.promise);
      createRealtimeBridgeMock.mockReturnValue(loaded.bridge);
      const onClose = vi.fn(() => {
        if (throwingObserver) {
          throw new Error("close observer rejected");
        }
      });
      const { bridge } = createLazyRealtimeBridge(vi.fn(), undefined, onClose);
      await bridge.connect();

      const closing = bridge.close();
      const rejection = expect(closing).rejects.toBe(failure);
      disposed.reject(failure);
      await rejection;
      await expect(bridge.close()).rejects.toBe(failure);
      expect(loaded.close).toHaveBeenCalledOnce();
      expect(onClose).toHaveBeenCalledExactlyOnceWith("error");
      bridge.sendAudio(Buffer.from([0x01]));
      expect(loaded.sendAudio).not.toHaveBeenCalled();
    },
  );

  it("preserves queued user messages until the loaded bridge reports ready", async () => {
    const connected = createDeferred<void>();
    const loaded = createMockRealtimeBridge(() => connected.promise);
    createRealtimeBridgeMock.mockReturnValue(loaded.bridge);
    const { bridge } = createLazyRealtimeBridge();

    bridge.sendUserMessage?.("before connect");
    const connectPromise = bridge.connect();
    await vi.waitFor(() => expect(loaded.connect).toHaveBeenCalledOnce());
    bridge.sendUserMessage?.("during connect");

    expect(loaded.sendUserMessage).not.toHaveBeenCalled();
    connected.resolve();
    await connectPromise;

    expect(loaded.sendUserMessage).not.toHaveBeenCalled();
    signalRealtimeBridgeReady();

    expect(loaded.sendUserMessage.mock.calls.map(([text]) => text)).toEqual([
      "before connect",
      "during connect",
    ]);
  });

  it("rejects each user message beyond the lazy startup queue count", async () => {
    const loaded = createMockRealtimeBridge();
    createRealtimeBridgeMock.mockReturnValue(loaded.bridge);
    const { bridge, onError } = createLazyRealtimeBridge();

    for (let index = 0; index < 130; index += 1) {
      bridge.sendUserMessage?.(`message-${index}`);
    }
    await bridge.connect();
    signalRealtimeBridgeReady();

    expect(loaded.sendUserMessage).toHaveBeenCalledTimes(128);
    expect(loaded.sendUserMessage.mock.calls.map(([text]) => text)).toEqual(
      Array.from({ length: 128 }, (_, index) => `message-${index}`),
    );
    expect(onError).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ message: expect.stringContaining("queue overflow") }),
    );
    expect(onError).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ message: expect.stringContaining("queue overflow") }),
    );
  });

  it("bounds the lazy startup queue by aggregate UTF-8 bytes", async () => {
    const loaded = createMockRealtimeBridge();
    createRealtimeBridgeMock.mockReturnValue(loaded.bridge);
    const { bridge, onError } = createLazyRealtimeBridge();
    const exactLimit = "🙂".repeat((256 * 1024) / 4);

    expect(Buffer.byteLength(exactLimit, "utf8")).toBe(256 * 1024);
    bridge.sendUserMessage?.(exactLimit);
    bridge.sendUserMessage?.("overflow");
    await bridge.connect();
    signalRealtimeBridgeReady();

    expect(loaded.sendUserMessage).toHaveBeenCalledOnce();
    expect(loaded.sendUserMessage).toHaveBeenCalledWith(exactLimit);
    expect(onError).toHaveBeenCalledOnce();
  });

  it("closes a bridge that loads after the lazy wrapper is closed", async () => {
    const loaded = createMockRealtimeBridge();
    createRealtimeBridgeMock.mockReturnValue(loaded.bridge);
    const { bridge } = createLazyRealtimeBridge();

    bridge.sendUserMessage?.("before connect");
    const connectPromise = bridge.connect();
    void bridge.close();
    void bridge.close();
    bridge.sendUserMessage?.("after close");
    await connectPromise;

    expect(loaded.connect).not.toHaveBeenCalled();
    expect(loaded.close).toHaveBeenCalledOnce();
    expect(loaded.sendUserMessage).not.toHaveBeenCalled();
  });

  it("clears queued messages and ignores a late connect completion after close", async () => {
    const connected = createDeferred<void>();
    const loaded = createMockRealtimeBridge(() => connected.promise);
    createRealtimeBridgeMock.mockReturnValue(loaded.bridge);
    const { bridge } = createLazyRealtimeBridge();

    bridge.sendUserMessage?.("before connect");
    const connectPromise = bridge.connect();
    await vi.waitFor(() => expect(loaded.connect).toHaveBeenCalledOnce());
    bridge.sendUserMessage?.("during connect");
    void bridge.close();
    void bridge.close();
    bridge.sendUserMessage?.("after close");
    connected.resolve();
    await connectPromise;
    signalRealtimeBridgeReady();

    expect(loaded.close).toHaveBeenCalledOnce();
    expect(loaded.sendUserMessage).not.toHaveBeenCalled();
  });

  it("keeps close precedence when the readiness callback closes the lazy bridge", async () => {
    const loaded = createMockRealtimeBridge();
    createRealtimeBridgeMock.mockReturnValue(loaded.bridge);
    const bridgeRef: { current?: RealtimeVoiceBridge } = {};
    const onReady = vi.fn(() => void bridgeRef.current?.close());
    const { bridge } = createLazyRealtimeBridge(vi.fn(), onReady);
    bridgeRef.current = bridge;

    bridge.sendUserMessage?.("queued prompt");
    bridge.triggerGreeting?.("queued greeting");
    await bridge.connect();
    signalRealtimeBridgeReady();

    expect(onReady).toHaveBeenCalledOnce();
    expect(loaded.close).toHaveBeenCalledOnce();
    expect(loaded.sendUserMessage).not.toHaveBeenCalled();
    expect(loaded.triggerGreeting).not.toHaveBeenCalled();
  });
});
