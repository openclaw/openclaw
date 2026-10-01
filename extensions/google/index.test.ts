// Google tests cover index plugin behavior.
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Context, Model } from "openclaw/plugin-sdk/llm";
import type {
  OpenClawPluginApi,
  ProviderReplaySessionEntry,
  ProviderSanitizeReplayHistoryContext,
} from "openclaw/plugin-sdk/plugin-entry";
import {
  registerProviderPlugin,
  requireRegisteredProvider,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { createCapturedThinkingConfigStream } from "openclaw/plugin-sdk/provider-test-contracts";
import { describe, expect, it } from "vitest";
import { buildGoogleGeminiCliProvider } from "./gemini-cli-provider.js";
import googleProviderDiscovery from "./provider-discovery.js";
import { buildGoogleProvider } from "./provider-registration.js";

const googleProviderPlugin = {
  register(api: OpenClawPluginApi) {
    api.registerProvider(buildGoogleProvider());
    api.registerProvider(buildGoogleGeminiCliProvider());
  },
};

function registerGoogleProviders() {
  return registerProviderPlugin({
    plugin: googleProviderPlugin,
    id: "google",
    name: "Google Provider",
  });
}

describe("google provider plugin hooks", () => {
  it("owns replay policy and reasoning mode for the direct Gemini provider", async () => {
    const { providers } = await registerGoogleProviders();
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
    const { providers } = await registerGoogleProviders();
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
    const { providers } = await registerGoogleProviders();
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
    const { providers } = await registerGoogleProviders();
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
    const { providers } = await registerGoogleProviders();
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

  it("keeps google-interactions hook aliases on native reasoning mode", async () => {
    const { providers } = await registerGoogleProviders();
    const provider = requireRegisteredProvider(providers, "google-interactions");
    expect(
      provider.resolveReasoningOutputMode?.({
        provider: "google-interactions",
        modelApi: "google-interactions",
        modelId: "gemini-3.8-flash",
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
    const { providers } = await registerGoogleProviders();
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
    const { providers } = await registerGoogleProviders();
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
    const { providers } = await registerGoogleProviders();
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
    const { providers } = await registerGoogleProviders();
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
    const { providers } = await registerGoogleProviders();
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
    const { providers } = await registerGoogleProviders();
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
});
