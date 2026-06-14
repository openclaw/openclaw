/**
 * Tests baseline tool availability for assembled agent tools.
 * Ensures control-plane tools remain present and node-originated runs receive
 * the restricted node-safe subset.
 */
import { describe, expect, it, vi } from "vitest";
import "./test-helpers/fast-coding-tools.js";
import "./test-helpers/fast-openclaw-tools.js";
import { createOpenClawCodingTools } from "./agent-tools.js";

vi.mock("./channel-tools.js", () => {
  const passthrough = <T>(tool: T) => tool;
  const stubTool = (name: string) => ({
    name,
    description: `${name} stub`,
    parameters: { type: "object", properties: {} },
    execute: vi.fn(),
  });
  return {
    listChannelAgentTools: () => [stubTool("plugin_login")],
    copyChannelAgentToolMeta: passthrough,
    getChannelAgentToolMeta: () => undefined,
  };
});

describe("tool availability", () => {
  it("keeps control-plane tools available", () => {
    const tools = createOpenClawCodingTools();
    const toolNames = tools.map((tool) => tool.name);
    expect(toolNames).toContain("plugin_login");
    expect(toolNames).toContain("cron");
    expect(toolNames).toContain("gateway");
    expect(toolNames).toContain("nodes");
  });

  it("keeps canvas available by current trust model", () => {
    const tools = createOpenClawCodingTools();
    const toolNames = tools.map((tool) => tool.name);
    expect(toolNames).toContain("canvas");
  });

  it("restricts node-originated runs to the node-safe tool subset", () => {
    const tools = createOpenClawCodingTools({ messageProvider: "node" });
    const toolNames = tools.map((tool) => tool.name);
    expect(toolNames).toContain("canvas");
    expect(toolNames).not.toContain("exec");
    expect(toolNames).not.toContain("read");
    expect(toolNames).not.toContain("write");
    expect(toolNames).not.toContain("edit");
    expect(toolNames).not.toContain("message");
    expect(toolNames).not.toContain("sessions_send");
    expect(toolNames).not.toContain("subagents");
  });

  it("threads the explicit transport channel into approval routing when tool-policy provider differs", () => {
    // Split-channel embedded runs: tool policy can come from a derived provider
    // (for example `discord-voice` for tool restrictions) while the actual
    // transport routing back to the chat must use the canonical transport
    // channel (`discord`). The gateway approval-route check keys off
    // `turnSourceChannel`, so a split run that only carried `messageProvider`
    // would target the wrong approval surface or hit no-approval-route.
    const tools = createOpenClawCodingTools({
      messageProvider: "discord-voice",
      messageChannel: "discord",
      currentChannelId: "discord:#general",
      agentAccountId: "default",
    });
    // exec/process tools are re-spread by applyDeferredFollowupToolDescriptions
    // which drops non-enumerable symbol properties; pick a tool that survives
    // the spread (cron is a control-plane tool kept verbatim).
    const cronTool = tools.find((tool) => tool.name === "cron");
    expect(cronTool).toBeDefined();
    const hookContextSymbol = Object.getOwnPropertySymbols(cronTool!).find(
      (s) => s.description === "beforeToolCallHookContext",
    );
    expect(hookContextSymbol).toBeDefined();
    const ctx = (cronTool as unknown as Record<symbol, { turnSourceChannel?: string }>)[
      hookContextSymbol as symbol
    ];
    expect(ctx?.turnSourceChannel).toBe("discord");
  });

  it("falls back to messageProvider for turnSourceChannel when no explicit transport channel is supplied", () => {
    const tools = createOpenClawCodingTools({ messageProvider: "telegram" });
    const cronTool = tools.find((tool) => tool.name === "cron");
    expect(cronTool).toBeDefined();
    const hookContextSymbol = Object.getOwnPropertySymbols(cronTool!).find(
      (s) => s.description === "beforeToolCallHookContext",
    );
    expect(hookContextSymbol).toBeDefined();
    const ctx = (cronTool as unknown as Record<symbol, { turnSourceChannel?: string }>)[
      hookContextSymbol as symbol
    ];
    expect(ctx?.turnSourceChannel).toBe("telegram");
  });
});
