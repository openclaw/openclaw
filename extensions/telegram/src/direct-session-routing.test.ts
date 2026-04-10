import type { OpenClawPluginApi } from "openclaw/plugin-sdk/channel-entry-contract";
import { describe, expect, it, vi } from "vitest";
import {
  resolveTelegramPluginConfig,
  telegramPluginConfigSchema,
} from "./direct-session-routing-config.js";
import {
  isTelegramDirectSessionContext,
  registerTelegramDirectSessionHooks,
  resolveTelegramDirectSessionPrompt,
  resolveTelegramDirectSessionRouting,
} from "./direct-session-routing.js";

describe("telegram direct-session routing", () => {
  it("matches Telegram direct session keys for default and named accounts", () => {
    expect(
      isTelegramDirectSessionContext({
        channelId: "telegram",
        sessionKey: "agent:main:telegram:direct:12345",
      }),
    ).toBe(true);
    expect(
      isTelegramDirectSessionContext({
        channelId: "telegram",
        sessionKey: "agent:main:telegram:atlas:direct:12345:thread:12345:99",
      }),
    ).toBe(true);
  });

  it("rejects non-Telegram or grouped session keys", () => {
    expect(
      isTelegramDirectSessionContext({
        channelId: "discord",
        sessionKey: "agent:main:telegram:direct:12345",
      }),
    ).toBe(false);
    expect(
      isTelegramDirectSessionContext({
        channelId: "telegram",
        sessionKey: "agent:main:telegram:group:-10012345",
      }),
    ).toBe(false);
  });

  it("returns provider and model overrides only for Telegram direct sessions", () => {
    const config = resolveTelegramPluginConfig({
      directSessions: {
        providerOverride: "vllm",
        modelOverride: "qwen/qwen3-coder-30b",
      },
    });

    expect(
      resolveTelegramDirectSessionRouting({
        config,
        channelId: "telegram",
        sessionKey: "agent:main:telegram:direct:12345",
      }),
    ).toEqual({
      providerOverride: "vllm",
      modelOverride: "qwen/qwen3-coder-30b",
    });
    expect(
      resolveTelegramDirectSessionRouting({
        config,
        channelId: "telegram",
        sessionKey: "agent:main:telegram:group:-10012345",
      }),
    ).toBeUndefined();
  });

  it("returns a stable prompt prefix only for Telegram direct sessions", () => {
    const config = resolveTelegramPluginConfig({
      directSessions: {
        prependSystemContext: "Use the local Telegram direct-session lane first.",
      },
    });

    expect(
      resolveTelegramDirectSessionPrompt({
        config,
        channelId: "telegram",
        sessionKey: "agent:main:telegram:atlas:direct:12345",
      }),
    ).toEqual({
      prependSystemContext: "Use the local Telegram direct-session lane first.",
    });
    expect(
      resolveTelegramDirectSessionPrompt({
        config,
        channelId: "telegram",
        sessionKey: "agent:main:telegram:group:-10012345",
      }),
    ).toBeUndefined();
  });

  it("does not register hooks when direct-session routing is disabled", () => {
    const on = vi.fn();

    registerTelegramDirectSessionHooks({
      pluginConfig: {
        directSessions: {
          enabled: false,
          providerOverride: "vllm",
          prependSystemContext: "ignored",
        },
      },
      on,
    } as unknown as OpenClawPluginApi);

    expect(on).not.toHaveBeenCalled();
  });

  it("registers narrow hooks and returns Telegram-only results", () => {
    const on = vi.fn();

    registerTelegramDirectSessionHooks({
      pluginConfig: {
        directSessions: {
          providerOverride: "vllm",
          modelOverride: "qwen/qwen3-coder-30b",
          prependSystemContext: "Prefer the direct-session local lane.",
        },
      },
      on,
    } as unknown as OpenClawPluginApi);

    expect(on.mock.calls.map((call) => call[0])).toEqual([
      "before_model_resolve",
      "before_prompt_build",
    ]);

    const beforeModelResolve = on.mock.calls[0]?.[1] as (
      event: unknown,
      ctx: { channelId?: string; sessionKey?: string },
    ) => unknown;
    const beforePromptBuild = on.mock.calls[1]?.[1] as (
      event: unknown,
      ctx: { channelId?: string; sessionKey?: string },
    ) => unknown;

    expect(
      beforeModelResolve(
        { prompt: "hi" },
        { channelId: "telegram", sessionKey: "agent:main:telegram:direct:12345" },
      ),
    ).toEqual({
      providerOverride: "vllm",
      modelOverride: "qwen/qwen3-coder-30b",
    });
    expect(
      beforePromptBuild(
        { prompt: "hi", messages: [] },
        { channelId: "telegram", sessionKey: "agent:main:telegram:direct:12345" },
      ),
    ).toEqual({
      prependSystemContext: "Prefer the direct-session local lane.",
    });
    expect(
      beforeModelResolve(
        { prompt: "hi" },
        { channelId: "telegram", sessionKey: "agent:main:telegram:group:-10012345" },
      ),
    ).toBeUndefined();
  });

  it("publishes a runtime config schema with directSessions support", () => {
    const parsed = telegramPluginConfigSchema.runtime?.safeParse({
      directSessions: {
        providerOverride: "vllm",
      },
    });

    expect(parsed).toEqual({
      success: true,
      data: {
        directSessions: {
          providerOverride: "vllm",
        },
      },
    });
  });
});
