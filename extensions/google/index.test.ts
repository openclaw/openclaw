import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { Context, Model } from "@mariozechner/pi-ai";
import type {
  ProviderReplaySessionEntry,
  ProviderSanitizeReplayHistoryContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { describe, expect, it } from "vitest";
import {
  registerProviderPlugin,
  requireRegisteredProvider,
} from "../../test/helpers/plugins/provider-registration.js";
import googlePlugin from "./index.js";

describe("google provider plugin hooks", () => {
  it("owns replay policy and reasoning mode for the direct Gemini provider", async () => {
    const { providers } = await registerProviderPlugin({
      plugin: googlePlugin,
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
    ).toBe("tagged");

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

    expect(sanitized).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "user",
          content: "(session bootstrap)",
        }),
      ]),
    );
    expect(customEntries).toHaveLength(1);
    expect(customEntries[0]?.customType).toBe("google-turn-ordering-bootstrap");
  });

  it("does not add a plugin-local Gemini CLI tool schema normalization hook", async () => {
    const { providers } = await registerProviderPlugin({
      plugin: googlePlugin,
      id: "google",
      name: "Google Provider",
    });
    const provider = requireRegisteredProvider(providers, "google");

    expect(
      provider.normalizeToolSchemas?.({
        provider: "google-gemini-cli",
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
      } as never),
    ).toBeUndefined();
    expect(
      provider.inspectToolSchemas?.({
        provider: "google-gemini-cli",
        tools: [],
      } as never),
    ).toBeUndefined();
  });

  it("wires google-thinking stream hooks for direct and aliased google providers", async () => {
    const { providers } = await registerProviderPlugin({
      plugin: googlePlugin,
      id: "google",
      name: "Google Provider",
    });
    const googleProvider = requireRegisteredProvider(providers, "google");
    let capturedPayload: Record<string, unknown> | undefined;

    const baseStreamFn: StreamFn = (model, _context, options) => {
      const payload = { config: { thinkingConfig: { thinkingBudget: -1 } } } as Record<
        string,
        unknown
      >;
      options?.onPayload?.(payload as never, model as never);
      capturedPayload = payload;
      return {} as never;
    };

    const runCase = (providerId: string) => {
      const wrapped = googleProvider.wrapStreamFn?.({
        provider: providerId,
        modelId: "gemini-3.1-pro-preview",
        thinkingLevel: "high",
        streamFn: baseStreamFn,
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

      expect(capturedPayload).toMatchObject({
        config: { thinkingConfig: { thinkingLevel: "HIGH" } },
      });
      const thinkingConfig = (
        (capturedPayload as Record<string, unknown>).config as Record<string, unknown>
      ).thinkingConfig as Record<string, unknown>;
      expect(thinkingConfig).not.toHaveProperty("thinkingBudget");
    };

    runCase("google");
    runCase("google-gemini-cli");
  });
});
