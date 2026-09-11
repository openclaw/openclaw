// Kimi Coding tests cover index plugin behavior.
import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it } from "vitest";
import plugin from "./index.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };

describe("kimi provider plugin", () => {
  it("normalizes legacy Kimi Code ids to the stable API model id", async () => {
    const provider = await registerSingleProviderPlugin(plugin);

    expect(
      provider.normalizeResolvedModel?.({
        provider: "kimi",
        modelId: "kimi-code",
        model: {
          id: "kimi-code",
          name: "Kimi Code",
          provider: "kimi",
          api: "anthropic-messages",
        },
      } as never),
    ).toEqual({
      id: "kimi-for-coding",
      name: "Kimi Code",
      provider: "kimi",
      api: "anthropic-messages",
    });

    expect(provider.normalizeModelId?.({ provider: "kimi", modelId: "k3[1m]" } as never)).toBe(
      "k3",
    );
  });

  it("uses binary thinking with thinking off by default", async () => {
    const provider = await registerSingleProviderPlugin(plugin);

    expect(
      provider.resolveThinkingProfile?.({
        provider: "kimi",
        modelId: "kimi-code",
        reasoning: true,
      } as never),
    ).toEqual({
      levels: [
        { id: "off", label: "off" },
        { id: "low", label: "on" },
      ],
      defaultLevel: "off",
    });
  });

  it.each([
    ["weekly limit", "You've reached your weekly usage limit.", "rate_limit"],
    ["weekly window", "You've reached your weekly (7-day) usage limit.", "rate_limit"],
    ["seven-day limit", "Your seven-day usage limit has been reached.", "rate_limit"],
    ["7-day limit", "You've reached your 7-day usage limit.", "rate_limit"],
    ["quota reset", "Your quota will reset when the current window ends.", "rate_limit"],
    [
      "agent access restriction",
      "Kimi For Coding is currently only available for Coding Agents such as Kimi CLI, Claude Code, Roo Code, Kilo Code, etc.",
      undefined,
    ],
    ["type without quota", "Access has been terminated.", undefined],
    ["invalid key", "Invalid API key", undefined],
  ] as const)("classifies the quota signal for %s", async (_name, errorMessage, expected) => {
    const provider = await registerSingleProviderPlugin(plugin);

    expect(
      provider.classifyFailoverReason?.({
        provider: "kimi",
        status: 403,
        errorType: "access_terminated_error",
        errorMessage,
      }),
    ).toBe(expected);
  });

  it.each(["kimi", " KIMI ", "kimi-code", "kimi-coding"])(
    "declares and classifies quota exhaustion for provider %s",
    async (providerId) => {
      const provider = await registerSingleProviderPlugin(plugin);

      expect(manifest.providers).toContain(providerId.trim().toLowerCase());
      expect(
        provider.classifyFailoverReason?.({
          provider: providerId,
          status: 403,
          errorMessage: "Your quota will reset when the current window ends.",
        }),
      ).toBe("rate_limit");
    },
  );

  it.each([
    { providerId: "kimi", status: 401 },
    { providerId: "other-provider", status: 403 },
    { providerId: undefined, status: 403 },
  ])("preserves non-quota ownership for $providerId/$status", async ({ providerId, status }) => {
    const provider = await registerSingleProviderPlugin(plugin);

    expect(
      provider.classifyFailoverReason?.({
        provider: providerId,
        status,
        errorMessage: "Your quota will reset when the current window ends.",
      }),
    ).toBeUndefined();
  });

  it.each(["k3", "k3-256k"])("exposes %s adaptive thinking levels", async (modelId) => {
    const provider = await registerSingleProviderPlugin(plugin);

    expect(
      provider.resolveThinkingProfile?.({
        provider: "kimi",
        modelId,
        reasoning: true,
      } as never),
    ).toEqual({
      levels: [
        { id: "off" },
        { id: "minimal" },
        { id: "low" },
        { id: "medium" },
        { id: "high" },
        { id: "adaptive" },
        { id: "xhigh" },
        { id: "max" },
      ],
      defaultLevel: "high",
      preserveWhenCatalogReasoningFalse: true,
    });
  });

  it("wraps K3 simple completions without changing K2 simple completions", async () => {
    const provider = await registerSingleProviderPlugin(plugin);
    const streamFn = (() => undefined) as never;

    expect(
      provider.wrapSimpleCompletionStreamFn?.({
        provider: "kimi",
        modelId: "k3",
        streamFn,
      } as never),
    ).not.toBe(streamFn);
    expect(
      provider.wrapSimpleCompletionStreamFn?.({
        provider: "kimi",
        modelId: "kimi-for-coding",
        streamFn,
      } as never),
    ).toBe(streamFn);
  });
});
