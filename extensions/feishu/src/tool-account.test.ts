import type { OpenClawPluginApi } from "openclaw/plugin-sdk/feishu";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { resolveFeishuToolAccount } from "./tool-account.js";

// Mock resolveFeishuAccount to track which accountId is resolved
const resolveFeishuAccountMock = vi.fn((params: { cfg: unknown; accountId?: string }) => ({
  config: { appId: `app-${params.accountId || "default"}` },
}));

vi.mock("./accounts.js", () => ({
  resolveFeishuAccount: (params: { cfg: unknown; accountId?: string }) =>
    resolveFeishuAccountMock(params),
}));

function createConfig(params?: {
  defaultAccount?: string;
  autoBindAgentAccount?: boolean;
  bindings?: Array<{ agentId: string; match: { channel: string; accountId?: string } }>;
}): OpenClawPluginApi["config"] {
  return {
    channels: {
      feishu: {
        defaultAccount: params?.defaultAccount,
        autoBindAgentAccount: params?.autoBindAgentAccount,
      },
    },
    bindings: params?.bindings,
  } as OpenClawPluginApi["config"];
}

describe("resolveFeishuToolAccount", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("Priority: Explicit accountId (Step 1)", () => {
    test("should use explicit accountId from executeParams when provided", () => {
      const cfg = createConfig({ defaultAccount: "default-account" });

      resolveFeishuToolAccount({
        api: { config: cfg },
        executeParams: { accountId: "explicit-account" },
      });

      expect(resolveFeishuAccountMock).toHaveBeenCalledWith(
        expect.objectContaining({ accountId: "explicit-account" }),
      );
    });

    test("should ignore agent binding when explicit accountId is provided", () => {
      const cfg = createConfig({
        bindings: [
          {
            agentId: "agent-work",
            match: { channel: "feishu", accountId: "work-account" },
          },
        ],
      });

      resolveFeishuToolAccount({
        api: { config: cfg },
        executeParams: { accountId: "explicit-account" },
        agentId: "agent-work",
      });

      expect(resolveFeishuAccountMock).toHaveBeenCalledWith(
        expect.objectContaining({ accountId: "explicit-account" }),
      );
    });

    test("should trim and normalize explicit accountId whitespace", () => {
      const cfg = createConfig({ defaultAccount: "default-account" });

      resolveFeishuToolAccount({
        api: { config: cfg },
        executeParams: { accountId: "  explicit-account  " },
      });

      expect(resolveFeishuAccountMock).toHaveBeenCalledWith(
        expect.objectContaining({ accountId: "explicit-account" }),
      );
    });

    test("should treat empty string as no explicit accountId", () => {
      const cfg = createConfig({ defaultAccount: "default-account" });

      resolveFeishuToolAccount({
        api: { config: cfg },
        executeParams: { accountId: "   " }, // only whitespace
      });

      expect(resolveFeishuAccountMock).toHaveBeenCalledWith(
        expect.objectContaining({ accountId: "default-account" }),
      );
    });
  });

  describe("Priority: Agent binding (Step 2)", () => {
    test("should use agent binding when auto-bind is enabled and binding exists", () => {
      const cfg = createConfig({
        autoBindAgentAccount: true,
        defaultAccount: "default-account",
        bindings: [
          {
            agentId: "agent-work",
            match: { channel: "feishu", accountId: "work-account" },
          },
        ],
      });

      resolveFeishuToolAccount({
        api: { config: cfg },
        agentId: "agent-work",
      });

      expect(resolveFeishuAccountMock).toHaveBeenCalledWith(
        expect.objectContaining({ accountId: "work-account" }),
      );
    });

    test("should not use agent binding when auto-bind is disabled", () => {
      const cfg = createConfig({
        autoBindAgentAccount: false,
        defaultAccount: "default-account",
        bindings: [
          {
            agentId: "agent-work",
            match: { channel: "feishu", accountId: "work-account" },
          },
        ],
      });

      resolveFeishuToolAccount({
        api: { config: cfg },
        agentId: "agent-work",
      });

      expect(resolveFeishuAccountMock).toHaveBeenCalledWith(
        expect.objectContaining({ accountId: "default-account" }),
      );
    });

    test("should use default when agentId is not provided", () => {
      const cfg = createConfig({
        autoBindAgentAccount: true,
        defaultAccount: "default-account",
        bindings: [
          {
            agentId: "agent-work",
            match: { channel: "feishu", accountId: "work-account" },
          },
        ],
      });

      resolveFeishuToolAccount({
        api: { config: cfg },
        agentId: undefined,
      });

      expect(resolveFeishuAccountMock).toHaveBeenCalledWith(
        expect.objectContaining({ accountId: "default-account" }),
      );
    });

    test("should fall back to default when binding is not found for agent", () => {
      const cfg = createConfig({
        autoBindAgentAccount: true,
        defaultAccount: "default-account",
        bindings: [
          {
            agentId: "agent-other",
            match: { channel: "feishu", accountId: "other-account" },
          },
        ],
      });

      resolveFeishuToolAccount({
        api: { config: cfg },
        agentId: "agent-work", // Not in bindings
      });

      expect(resolveFeishuAccountMock).toHaveBeenCalledWith(
        expect.objectContaining({ accountId: "default-account" }),
      );
    });

    test("should match binding by exact agentId and feishu channel", () => {
      const cfg = createConfig({
        autoBindAgentAccount: true,
        bindings: [
          {
            agentId: "agent-work",
            match: { channel: "telegram", accountId: "telegram-account" }, // Different channel
          },
          {
            agentId: "agent-work",
            match: { channel: "feishu", accountId: "work-account" }, // Correct channel
          },
        ],
      });

      resolveFeishuToolAccount({
        api: { config: cfg },
        agentId: "agent-work",
      });

      expect(resolveFeishuAccountMock).toHaveBeenCalledWith(
        expect.objectContaining({ accountId: "work-account" }),
      );
    });

    test("should ignore binding with missing accountId in match", () => {
      const cfg = createConfig({
        autoBindAgentAccount: true,
        defaultAccount: "default-account",
        bindings: [
          {
            agentId: "agent-work",
            match: { channel: "feishu" }, // Missing accountId
          },
        ],
      });

      resolveFeishuToolAccount({
        api: { config: cfg },
        agentId: "agent-work",
      });

      expect(resolveFeishuAccountMock).toHaveBeenCalledWith(
        expect.objectContaining({ accountId: "default-account" }),
      );
    });

    test("should trim accountId from binding", () => {
      const cfg = createConfig({
        autoBindAgentAccount: true,
        bindings: [
          {
            agentId: "agent-work",
            match: { channel: "feishu", accountId: "  work-account  " },
          },
        ],
      });

      resolveFeishuToolAccount({
        api: { config: cfg },
        agentId: "agent-work",
      });

      expect(resolveFeishuAccountMock).toHaveBeenCalledWith(
        expect.objectContaining({ accountId: "work-account" }),
      );
    });
  });

  describe("Priority: Global defaultAccount (Step 3)", () => {
    test("should use global defaultAccount when explicit and binding are not available", () => {
      const cfg = createConfig({ defaultAccount: "default-account" });

      resolveFeishuToolAccount({
        api: { config: cfg },
      });

      expect(resolveFeishuAccountMock).toHaveBeenCalledWith(
        expect.objectContaining({ accountId: "default-account" }),
      );
    });

    test("should trim defaultAccount from config", () => {
      const cfg = createConfig({ defaultAccount: "  default-account  " });

      resolveFeishuToolAccount({
        api: { config: cfg },
      });

      expect(resolveFeishuAccountMock).toHaveBeenCalledWith(
        expect.objectContaining({ accountId: "default-account" }),
      );
    });

    test("should ignore empty defaultAccount in config", () => {
      const cfg = createConfig({ defaultAccount: "   " }); // only whitespace
      const fallbackCfg = {
        ...cfg,
      };

      resolveFeishuToolAccount({
        api: { config: fallbackCfg },
        defaultAccountId: "fallback-account",
      });

      expect(resolveFeishuAccountMock).toHaveBeenCalledWith(
        expect.objectContaining({ accountId: "fallback-account" }),
      );
    });
  });

  describe("Priority: Fallback defaultAccountId (Step 4)", () => {
    test("should use fallback defaultAccountId when no other options", () => {
      const cfg = createConfig();

      resolveFeishuToolAccount({
        api: { config: cfg },
        defaultAccountId: "fallback-account",
      });

      expect(resolveFeishuAccountMock).toHaveBeenCalledWith(
        expect.objectContaining({ accountId: "fallback-account" }),
      );
    });

    test("should trim fallback accountId", () => {
      const cfg = createConfig();

      resolveFeishuToolAccount({
        api: { config: cfg },
        defaultAccountId: "  fallback-account  ",
      });

      expect(resolveFeishuAccountMock).toHaveBeenCalledWith(
        expect.objectContaining({ accountId: "fallback-account" }),
      );
    });

    test("should pass undefined when all options are empty", () => {
      const cfg = createConfig();

      resolveFeishuToolAccount({
        api: { config: cfg },
        defaultAccountId: "   ", // whitespace
      });

      expect(resolveFeishuAccountMock).toHaveBeenCalledWith(
        expect.objectContaining({ accountId: undefined }),
      );
    });
  });

  describe("Error handling", () => {
    test("should throw when config is unavailable", () => {
      expect(() => {
        resolveFeishuToolAccount({
          api: { config: undefined as unknown as OpenClawPluginApi["config"] },
        });
      }).toThrow("Feishu config unavailable");
    });

    test("should handle missing channels config gracefully", () => {
      const cfg = { channels: {} } as OpenClawPluginApi["config"];

      resolveFeishuToolAccount({
        api: { config: cfg },
        defaultAccountId: "fallback-account",
      });

      expect(resolveFeishuAccountMock).toHaveBeenCalledWith(
        expect.objectContaining({ accountId: "fallback-account" }),
      );
    });

    test("should handle missing bindings gracefully", () => {
      const cfg = createConfig({
        autoBindAgentAccount: true,
        defaultAccount: "default-account",
      });

      resolveFeishuToolAccount({
        api: { config: cfg },
        agentId: "agent-work",
      });

      expect(resolveFeishuAccountMock).toHaveBeenCalledWith(
        expect.objectContaining({ accountId: "default-account" }),
      );
    });
  });

  describe("Full resolution chain scenarios", () => {
    test("Scenario: Agent with matching binding, but explicit override", () => {
      // Title: Multi-account resolution with explicit override
      const cfg = createConfig({
        defaultAccount: "default-account",
        autoBindAgentAccount: true,
        bindings: [
          {
            agentId: "agent-work",
            match: { channel: "feishu", accountId: "work-account" },
          },
        ],
      });

      resolveFeishuToolAccount({
        api: { config: cfg },
        executeParams: { accountId: "override-account" },
        agentId: "agent-work",
      });

      expect(resolveFeishuAccountMock).toHaveBeenCalledWith(
        expect.objectContaining({ accountId: "override-account" }),
      );
    });

    test("Scenario: Multiple bindings, verify correct agent matched", () => {
      // Title: Correct binding selected when multiple agents present
      const cfg = createConfig({
        defaultAccount: "default-account",
        autoBindAgentAccount: true,
        bindings: [
          {
            agentId: "agent-work",
            match: { channel: "feishu", accountId: "work-account" },
          },
          {
            agentId: "agent-personal",
            match: { channel: "feishu", accountId: "personal-account" },
          },
        ],
      });

      // First call: agent-work
      resolveFeishuToolAccount({
        api: { config: cfg },
        agentId: "agent-work",
      });
      expect(resolveFeishuAccountMock).toHaveBeenLastCalledWith(
        expect.objectContaining({ accountId: "work-account" }),
      );

      // Second call: agent-personal
      resolveFeishuToolAccount({
        api: { config: cfg },
        agentId: "agent-personal",
      });
      expect(resolveFeishuAccountMock).toHaveBeenLastCalledWith(
        expect.objectContaining({ accountId: "personal-account" }),
      );
    });

    test("Scenario: Fallback chain when each step is missing", () => {
      // Title: Full resolution chain with each step missing
      const cfg = createConfig({
        autoBindAgentAccount: true,
        // no defaultAccount
        // no bindings
      });

      resolveFeishuToolAccount({
        api: { config: cfg },
        // no executeParams
        // no agentId
        defaultAccountId: "fallback-account",
      });

      expect(resolveFeishuAccountMock).toHaveBeenCalledWith(
        expect.objectContaining({ accountId: "fallback-account" }),
      );
    });

    test("Scenario: Auto-bind disabled should skip binding step", () => {
      // Title: autoBindAgentAccount=false skips agent binding resolution
      const cfg = createConfig({
        defaultAccount: "default-account",
        autoBindAgentAccount: false,
        bindings: [
          {
            agentId: "agent-work",
            match: { channel: "feishu", accountId: "work-account" },
          },
        ],
      });

      resolveFeishuToolAccount({
        api: { config: cfg },
        agentId: "agent-work",
      });

      expect(resolveFeishuAccountMock).toHaveBeenCalledWith(
        expect.objectContaining({ accountId: "default-account" }),
      );
    });
  });

  describe("Edge cases", () => {
    test("should handle boolean coercion for autoBindAgentAccount", () => {
      const cfg = createConfig({
        defaultAccount: "default-account",
        // autoBindAgentAccount not specified, should default to true
        bindings: [
          {
            agentId: "agent-work",
            match: { channel: "feishu", accountId: "work-account" },
          },
        ],
      });

      resolveFeishuToolAccount({
        api: { config: cfg },
        agentId: "agent-work",
      });

      // Should use binding (auto-bind defaults to true)
      expect(resolveFeishuAccountMock).toHaveBeenCalledWith(
        expect.objectContaining({ accountId: "work-account" }),
      );
    });

    test("should handle malformed bindings array gracefully", () => {
      const cfg = {
        channels: {
          feishu: { defaultAccount: "default-account", autoBindAgentAccount: true },
        },
        bindings: null, // Malformed
      } as unknown as OpenClawPluginApi["config"];

      resolveFeishuToolAccount({
        api: { config: cfg },
        agentId: "agent-work",
      });

      expect(resolveFeishuAccountMock).toHaveBeenCalledWith(
        expect.objectContaining({ accountId: "default-account" }),
      );
    });

    test("should handle binding with null match gracefully", () => {
      const cfg = createConfig({
        defaultAccount: "default-account",
        autoBindAgentAccount: true,
        bindings: [
          {
            agentId: "agent-work",
            match: null as unknown as { channel: string; accountId?: string },
          },
        ],
      });

      resolveFeishuToolAccount({
        api: { config: cfg },
        agentId: "agent-work",
      });

      expect(resolveFeishuAccountMock).toHaveBeenCalledWith(
        expect.objectContaining({ accountId: "default-account" }),
      );
    });
  });
});
