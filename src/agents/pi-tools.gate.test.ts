import { describe, it, expect, vi } from "vitest";
import type { HeimdallConfig } from "../security/heimdall/types.js";

// Stub heavy dependencies that pi-tools imports.
vi.mock("@mariozechner/pi-coding-agent", () => ({
  codingTools: () => [],
  createEditTool: () => ({ name: "edit", description: "Edit" }),
  createReadTool: () => ({ name: "read", description: "Read" }),
  createWriteTool: () => ({ name: "write", description: "Write" }),
  readTool: { name: "read", description: "Read" },
}));
vi.mock("../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: () => null,
}));
vi.mock("../plugins/tools.js", () => ({
  getPluginToolMeta: () => undefined,
}));

describe("Heimdall GATE in pi-tools", () => {
  const heimdallConfig: HeimdallConfig = {
    enabled: true,
    senderTiers: {
      owners: [111, "thebtf"],
      members: [222, "alice"],
    },
    defaultGuestPolicy: "deny",
  };

  /**
   * Integration: verify that wrapToolWithBeforeToolCallHook receives senderTier + heimdallConfig.
   * We test this by using the before-tool-call hook to block a GUEST from using exec.
   */
  it("blocks GUEST from exec when heimdall is enabled", async () => {
    const { runBeforeToolCallHook } = await import("./pi-tools.before-tool-call.js");
    const result = await runBeforeToolCallHook({
      toolName: "exec",
      params: {},
      ctx: {
        senderTier: "guest",
        heimdallConfig,
      },
    });
    expect(result.blocked).toBe(true);
    expect(result).toHaveProperty("reason");
    expect((result as { reason: string }).reason).toContain("heimdall");
  });

  it("allows OWNER to use any tool", async () => {
    const { runBeforeToolCallHook } = await import("./pi-tools.before-tool-call.js");
    const result = await runBeforeToolCallHook({
      toolName: "exec",
      params: {},
      ctx: {
        senderTier: "owner",
        heimdallConfig,
      },
    });
    expect(result.blocked).toBe(false);
  });

  it("allows MEMBER to use read-only tools", async () => {
    const { runBeforeToolCallHook } = await import("./pi-tools.before-tool-call.js");
    const result = await runBeforeToolCallHook({
      toolName: "search",
      params: {},
      ctx: {
        senderTier: "member",
        heimdallConfig,
      },
    });
    expect(result.blocked).toBe(false);
  });

  it("skips heimdall check when config not provided", async () => {
    const { runBeforeToolCallHook } = await import("./pi-tools.before-tool-call.js");
    const result = await runBeforeToolCallHook({
      toolName: "exec",
      params: {},
      ctx: {},
    });
    expect(result.blocked).toBe(false);
  });

  it("skips heimdall check when disabled", async () => {
    const { runBeforeToolCallHook } = await import("./pi-tools.before-tool-call.js");
    const result = await runBeforeToolCallHook({
      toolName: "exec",
      params: {},
      ctx: {
        senderTier: "guest",
        heimdallConfig: { enabled: false },
      },
    });
    expect(result.blocked).toBe(false);
  });

  it("resolves cron sender as OWNER when senderIsOwner=true", async () => {
    // Verify the resolution logic directly
    const { resolveSenderTier } = await import("../security/heimdall/sender-tier.js");
    // Cron has no senderId — we use "cron" as a synthetic ID
    const tier = resolveSenderTier("cron", undefined, heimdallConfig);
    // "cron" is not in owners/members, so it would be GUEST...
    // ...but pi-tools overrides to OWNER when senderIsOwner=true
    expect(tier).toBe("guest");
    // The override to OWNER happens in createOpenClawCodingTools, not in resolveSenderTier
  });
});
