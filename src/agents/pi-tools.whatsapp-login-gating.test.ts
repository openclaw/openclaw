import { describe, expect, it, vi } from "vitest";
import "./test-helpers/fast-coding-tools.js";
import { createBotCodingTools } from "./pi-tools.js";

vi.mock("./channel-tools.js", () => {
  const stubTool = (name: string) => ({
    name,
    description: `${name} stub`,
    parameters: { type: "object", properties: {} },
    execute: vi.fn(),
  });
  return {
    listChannelAgentTools: () => [stubTool("whatsapp_login")],
  };
});

describe("owner-only tool gating", () => {
  it("removes owner-only tools for unauthorized senders", () => {
    const tools = createBotCodingTools({ senderIsOwner: false });
    const toolNames = tools.map((tool) => tool.name);
    expect(toolNames).not.toContain("whatsapp_login");
    expect(toolNames).not.toContain("cron");
    expect(toolNames).not.toContain("gateway");
  });

  it("keeps owner-only tools for authorized senders", () => {
    const tools = createBotCodingTools({ senderIsOwner: true });
    const toolNames = tools.map((tool) => tool.name);
    expect(toolNames).toContain("whatsapp_login");
    expect(toolNames).toContain("cron");
    expect(toolNames).toContain("gateway");
  });

  it("defaults to removing owner-only tools when owner status is unknown", () => {
    const tools = createBotCodingTools();
    const toolNames = tools.map((tool) => tool.name);
    expect(toolNames).not.toContain("whatsapp_login");
    expect(toolNames).not.toContain("cron");
    expect(toolNames).not.toContain("gateway");
  });
});
