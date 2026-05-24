import { describe, expect, it, vi } from "vitest";
import { registerClickClackCommandSuggestionsRoute } from "./command-suggestions-http.js";
import { resolveClickClackCommandSuggestions } from "./command-suggestions.js";
import type { CoreConfig, ResolvedClickClackAccount } from "./types.js";

const cfg = {
  agents: {
    defaults: {
      model: "openai/gpt-5.4-mini",
    },
  },
} satisfies CoreConfig;

function createAccount(
  overrides: Partial<ResolvedClickClackAccount> = {},
): ResolvedClickClackAccount {
  return {
    accountId: "service",
    enabled: true,
    configured: true,
    baseUrl: "http://127.0.0.1:8080",
    token: "ccb_service",
    workspace: "wsp_1",
    agentId: "service-bot",
    replyMode: "agent",
    model: "openai/gpt-5.4-mini",
    toolsAllow: [],
    defaultTo: "channel:general",
    allowFrom: ["usr_human"],
    reconnectMs: 1_500,
    config: {},
    ...overrides,
  };
}

function namesFor(params: {
  query: string;
  account?: ResolvedClickClackAccount;
  config?: CoreConfig;
  senderId?: string;
  channelId?: string;
  channelName?: string;
  pluginCommands?: Parameters<typeof resolveClickClackCommandSuggestions>[0]["pluginCommands"];
}) {
  const result = resolveClickClackCommandSuggestions({
    account: params.account ?? createAccount(),
    config: params.config ?? cfg,
    query: params.query,
    senderId: params.senderId ?? "usr_human",
    channelId: params.channelId ?? "chn_1",
    channelName: params.channelName ?? "general",
    pluginCommands: params.pluginCommands,
  });
  return {
    ...result,
    names: result.suggestions.map((suggestion) => suggestion.name),
  };
}

describe("resolveClickClackCommandSuggestions", () => {
  it("registers the HTTP suggestions route behind gateway auth", () => {
    const registerHttpRoute = vi.fn();

    registerClickClackCommandSuggestionsRoute({ registerHttpRoute });

    expect(registerHttpRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        path: "/clickclack/commands/suggest",
        auth: "gateway",
        gatewayRuntimeScopeSurface: "trusted-operator",
      }),
    );
  });

  it("does not suggest commands for non-slash input", () => {
    const result = namesFor({ query: "status" });

    expect(result.suggestions).toEqual([]);
    expect(result.emptyText).toBeUndefined();
  });

  it("lists top available OpenClaw commands for slash input", () => {
    const result = namesFor({ query: "/", account: createAccount({ allowFrom: ["*"] }) });

    expect(result.names.slice(0, 2)).toEqual(["/help", "/status"]);
    expect(result.names).toContain("/crestodian");
    expect(result.names).not.toContain("/restart");
  });

  it("narrows command suggestions by typed prefix", () => {
    const result = namesFor({ query: "/st" });

    expect(result.names).toContain("/status");
    expect(result.names).toContain("/stop");
    expect(result.names).not.toContain("/help");
  });

  it("finds commands by alias and returns command-specific preview help", () => {
    const result = namesFor({ query: "/side" });

    expect(result.names).toEqual(["/btw"]);
    expect(result.suggestions[0]?.aliases).toContain("/side");
    expect(result.preview).toContain("/btw [args]");
    expect(result.preview).toContain("Aliases: /side");
  });

  it("filters all suggestions for senders outside the account allowFrom list", () => {
    const result = namesFor({
      query: "/",
      account: createAccount({ allowFrom: ["usr_human"] }),
      senderId: "usr_intruder",
    });

    expect(result.suggestions).toEqual([]);
    expect(result.emptyText).toBe("No OpenClaw commands are available for this sender.");
  });

  it("allows channel-scoped account allowFrom entries such as channel:general", () => {
    const result = namesFor({
      query: "/status",
      account: createAccount({ allowFrom: ["channel:general"] }),
      senderId: "usr_random",
      channelId: "chn_1",
      channelName: "general",
    });

    expect(result.names).toContain("/status");
    expect(result.preview).toContain("Show current status.");
  });

  it("filters suggestions through commands.allowFrom before command preview", () => {
    const result = namesFor({
      query: "/status",
      account: createAccount({ allowFrom: ["*"] }),
      config: {
        ...cfg,
        commands: { allowFrom: { clickclack: ["usr_owner"] } },
      } as CoreConfig,
      senderId: "usr_intruder",
    });

    expect(result.suggestions).toEqual([]);
    expect(result.emptyText).toBe("No OpenClaw commands are available for this sender.");
  });

  it("hides owner-only commands from authorized non-owner senders", () => {
    const result = namesFor({
      query: "/re",
      account: createAccount({ allowFrom: ["*"] }),
      config: {
        ...cfg,
        commands: {
          allowFrom: { clickclack: ["usr_human"] },
          ownerAllowFrom: ["clickclack:usr_owner"],
        },
      } as CoreConfig,
    });

    expect(result.names).not.toContain("/restart");
    expect(result.names).toContain("/reset");
  });

  it("does not treat ordinary account allowFrom entries as command owners", () => {
    const result = namesFor({
      query: "/restart",
      account: createAccount({ allowFrom: ["usr_human"] }),
    });

    expect(result.names).toEqual([]);
    expect(result.emptyText).toBe("No matching OpenClaw command.");
  });

  it("shows owner-only commands when the ClickClack-prefixed owner allowlist matches", () => {
    const result = namesFor({
      query: "/restart",
      account: createAccount({ allowFrom: ["*"] }),
      config: {
        ...cfg,
        commands: {
          allowFrom: { clickclack: ["usr_owner"] },
          ownerAllowFrom: ["clickclack:usr_owner"],
        },
      } as CoreConfig,
      senderId: "usr_owner",
    });

    expect(result.names).toEqual(["/restart"]);
    expect(result.preview).toContain("Restart OpenClaw.");
  });

  it("includes plugin-provided commands when available", () => {
    const result = namesFor({
      query: "/wa",
      account: createAccount({ allowFrom: ["*"] }),
      pluginCommands: [
        {
          name: "watch",
          description: "Manage active browser watches.",
          acceptsArgs: true,
        },
      ],
    });

    expect(result.names).toEqual(["/watch"]);
    expect(result.suggestions[0]?.source).toBe("plugin");
    expect(result.suggestions[0]?.usage).toBe("/watch [args]");
  });

  it("returns a preview-only no-match response without chat output", () => {
    const result = namesFor({ query: "/does-not-exist" });

    expect(result.suggestions).toEqual([]);
    expect(result.preview).toBeUndefined();
    expect(result.emptyText).toBe("No matching OpenClaw command.");
  });
});
