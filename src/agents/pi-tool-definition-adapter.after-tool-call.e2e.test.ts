import type { AgentTool } from "@mariozechner/pi-agent-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { toToolDefinitions } from "./pi-tool-definition-adapter.js";

const hookMocks = vi.hoisted(() => ({
  runBeforeToolCallHook: vi.fn(async ({ params }: { params: unknown }) => ({
    blocked: false,
    params,
  })),
}));

vi.mock("./pi-tools.before-tool-call.js", () => ({
  runBeforeToolCallHook: hookMocks.runBeforeToolCallHook,
}));

describe("pi tool definition adapter hook isolation", () => {
  beforeEach(() => {
    hookMocks.runBeforeToolCallHook.mockReset();
    hookMocks.runBeforeToolCallHook.mockImplementation(async ({ params }) => ({
      blocked: false,
      params,
    }));
  });

  it("executes tools without invoking hook wrappers", async () => {
    const tool = {
      name: "read",
      label: "Read",
      description: "reads",
      parameters: {},
      execute: vi.fn(async () => ({ content: [], details: { ok: true } })),
    } satisfies AgentTool<unknown, unknown>;

    const defs = toToolDefinitions([tool]);
    const result = await defs[0].execute("call-ok", { path: "/tmp/file" }, undefined, undefined);

    expect(result.details).toMatchObject({ ok: true });
    expect(hookMocks.runBeforeToolCallHook).not.toHaveBeenCalled();
  });

  it("keeps normalized error results and still skips hook wrappers", async () => {
    const tool = {
      name: "bash",
      label: "Bash",
      description: "throws",
      parameters: {},
      execute: vi.fn(async () => {
        throw new Error("boom");
      }),
    } satisfies AgentTool<unknown, unknown>;

    const defs = toToolDefinitions([tool]);
    const result = await defs[0].execute("call-err", { cmd: "ls" }, undefined, undefined);

    expect(result.details).toMatchObject({
      status: "error",
      tool: "exec",
      error: "boom",
    });
    expect(hookMocks.runBeforeToolCallHook).not.toHaveBeenCalled();
  });
});
