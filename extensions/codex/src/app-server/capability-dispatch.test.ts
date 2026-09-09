import { describe, expect, it, vi } from "vitest";
import {
  createCodexCapabilityDispatchTool,
  dispatchCodexCapability,
} from "./capability-dispatch.js";
import { readCodexPluginConfig } from "./config-parsing.js";
import { createCodexDynamicToolBridge } from "./dynamic-tools.js";

function client(statuses: Array<{ name: string; tools: Record<string, unknown> }>) {
  return {
    request: vi.fn(async (method: string) =>
      method === "mcpServerStatus/list"
        ? { data: statuses }
        : { content: [{ type: "text", text: "ok" }] },
    ),
  };
}
const status = (name: string, names: string[]) => ({
  name,
  tools: Object.fromEntries(names.map((name) => [name, {}])),
});

describe("owner-bound Codex capability dispatch", () => {
  it("is an explicit runtime opt-in", () => {
    expect(
      readCodexPluginConfig({ capabilityDispatch: { enabled: true } }).capabilityDispatch,
    ).toEqual({ enabled: true });
  });
  it.each([
    ["create", "knowledge_create"],
    ["update", "knowledge_update"],
    ["append", "knowledge_append"],
  ])("maps knowledge %s to %s", async (operation, expected) => {
    const live = client([status("knowledge", [expected])]);
    await dispatchCodexCapability({
      client: live as never,
      threadId: "owner-thread",
      input: {
        adapter: "knowledge",
        operation,
        authorization: { scope: "docs", purpose: "authorized test" },
      },
    });
    expect(live.request).toHaveBeenLastCalledWith("mcpServer/tool/call", {
      threadId: "owner-thread",
      server: "knowledge",
      tool: expected,
      arguments: {},
    });
  });
  it("rejects mutations before catalog access without authorization", async () => {
    const live = client([status("knowledge", ["knowledge_create"])]);
    const response = await dispatchCodexCapability({
      client: live as never,
      threadId: "owner-thread",
      input: { adapter: "knowledge", operation: "create" },
    });
    expect(response.details).toEqual({ status: "permission_denied" });
    expect(live.request).not.toHaveBeenCalled();
  });
  it("uses only the live owner thread and rejects an ambiguous catalog", async () => {
    const live = client([status("one", ["knowledge_read"]), status("two", ["knowledge_read"])]);
    const response = await dispatchCodexCapability({
      client: live as never,
      threadId: "owner-thread",
      input: { adapter: "knowledge", operation: "read" },
    });
    expect(response.details).toEqual({ status: "unavailable" });
    expect(live.request).toHaveBeenCalledWith("mcpServerStatus/list", {
      threadId: "owner-thread",
      detail: "full",
    });
    expect(live.request).toHaveBeenCalledTimes(1);
  });
  it("fails closed for an unsupported isolated Hindsight test scope", async () => {
    const live = client([]);
    const response = await dispatchCodexCapability({
      client: live as never,
      threadId: "owner-thread",
      input: {
        adapter: "hindsight",
        operation: "test_scope",
        authorization: { scope: "test", purpose: "verify isolation" },
      },
    });
    expect(response.details).toEqual({ status: "unavailable" });
    expect(live.request).not.toHaveBeenCalled();
  });
  it("cannot dispatch until the request controller supplies a live client", async () => {
    const live = client([status("knowledge", ["knowledge_read"])]);
    const bridge = createCodexDynamicToolBridge({
      tools: [createCodexCapabilityDispatchTool()],
      signal: new AbortController().signal,
    });
    const denied = await bridge.handleToolCall({
      threadId: "owner-thread",
      turnId: "turn",
      callId: "without",
      tool: "capability_dispatch",
      arguments: { adapter: "knowledge", operation: "read" },
    });
    expect(denied.success).toBe(false);
    const accepted = await bridge.handleToolCall(
      {
        threadId: "owner-thread",
        turnId: "turn",
        callId: "with",
        tool: "capability_dispatch",
        arguments: { adapter: "knowledge", operation: "read" },
      },
      { runtimeClient: live as never },
    );
    expect(accepted.success).toBe(true);
    expect(live.request).toHaveBeenCalledWith("mcpServerStatus/list", {
      threadId: "owner-thread",
      detail: "full",
    });
  });
});
