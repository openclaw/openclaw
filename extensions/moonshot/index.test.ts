import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { Context, Model } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import { registerSingleProviderPlugin } from "../../test/helpers/plugins/plugin-registration.js";
import plugin from "./index.js";

describe("moonshot provider plugin", () => {
  it("owns replay policy for OpenAI-compatible Moonshot transports", async () => {
    const provider = await registerSingleProviderPlugin(plugin);

    expect(
      provider.buildReplayPolicy?.({
        provider: "moonshot",
        modelApi: "openai-completions",
        modelId: "kimi-k2.5",
      } as never),
    ).toMatchObject({
      sanitizeToolCallIds: true,
      toolCallIdMode: "strict",
      applyAssistantFirstOrderingFix: true,
      validateGeminiTurns: true,
      validateAnthropicTurns: true,
    });
  });

  it("normalizes boolean tool schemas for Moonshot API", async () => {
    const provider = await registerSingleProviderPlugin(plugin);

    const [tool] =
      provider.normalizeToolSchemas?.({
        provider: "moonshot",
        tools: [
          {
            name: "test_tool",
            description: "A tool with boolean params",
            parameters: {
              type: "object",
              properties: {
                query: { type: "string" },
                enabled: { type: "boolean", description: "Toggle feature" },
                optional: {
                  anyOf: [{ type: "boolean" }, { type: "null" }],
                },
              },
            },
          },
        ],
      } as never) ?? [];

    const props = (tool?.parameters as Record<string, unknown>)?.properties as Record<
      string,
      Record<string, unknown>
    >;
    expect(props.query).toEqual({ type: "string" });
    expect(props.enabled).toEqual({
      type: "string",
      enum: ["true", "false"],
      description: "Toggle feature",
    });
    expect(props.optional).toEqual({
      anyOf: [{ type: "string", enum: ["true", "false"] }, { type: "null" }],
    });

    expect(
      provider.inspectToolSchemas?.({
        provider: "moonshot",
        tools: [tool],
      } as never),
    ).toEqual([]);
  });

  it("wires moonshot-thinking stream hooks", async () => {
    const provider = await registerSingleProviderPlugin(plugin);
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

    const wrapped = provider.wrapStreamFn?.({
      provider: "moonshot",
      modelId: "kimi-k2.5",
      thinkingLevel: "off",
      streamFn: baseStreamFn,
    } as never);

    void wrapped?.(
      {
        api: "openai-completions",
        provider: "moonshot",
        id: "kimi-k2.5",
      } as Model<"openai-completions">,
      { messages: [] } as Context,
      {},
    );

    expect(capturedPayload).toMatchObject({
      config: { thinkingConfig: { thinkingBudget: -1 } },
      thinking: { type: "disabled" },
    });
  });
});
