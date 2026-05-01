import process from "node:process";
import type {
  AgentToolResultMiddlewareEvent,
  OpenClawAgentToolResult,
} from "openclaw/plugin-sdk/agent-harness";
import { beforeEach, describe, expect, it, vi } from "vitest";

type TokenjuiceToolResultHandler = (
  event: {
    toolName: string;
    input: Record<string, unknown>;
    content: OpenClawAgentToolResult["content"];
    details: unknown;
    isError?: boolean;
  },
  ctx: { cwd: string },
) => Promise<Partial<OpenClawAgentToolResult> | void> | Partial<OpenClawAgentToolResult> | void;

const { handlers, createTokenjuiceOpenClawEmbeddedExtension } = vi.hoisted(() => {
  const handlers: TokenjuiceToolResultHandler[] = [];
  const createTokenjuiceOpenClawEmbeddedExtension = vi.fn(
    () => (runtime: { on(event: string, handler: TokenjuiceToolResultHandler): void }) => {
      for (const handler of handlers) {
        runtime.on("tool_result", handler);
      }
    },
  );
  return {
    handlers,
    createTokenjuiceOpenClawEmbeddedExtension,
  };
});

vi.mock("./runtime-api.js", () => ({
  createTokenjuiceOpenClawEmbeddedExtension,
}));

import { createTokenjuiceAgentToolResultMiddleware } from "./tool-result-middleware.js";

const baseResult: OpenClawAgentToolResult = {
  content: [{ type: "text", text: "raw output" }],
  details: { status: "success", rawBytes: 64 },
};

function createTextUpdate(text: string, details?: unknown): Partial<OpenClawAgentToolResult> {
  return {
    content: [{ type: "text", text }],
    ...(details === undefined ? {} : { details }),
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function createEvent(
  overrides: Partial<AgentToolResultMiddlewareEvent> = {},
): AgentToolResultMiddlewareEvent {
  return {
    toolCallId: "tool-call-1",
    toolName: "exec",
    args: { cmd: "git status" },
    result: baseResult,
    ...overrides,
  };
}

describe("tokenjuice tool result middleware adapter", () => {
  beforeEach(() => {
    handlers.length = 0;
    createTokenjuiceOpenClawEmbeddedExtension.mockClear();
  });

  it("returns undefined when tokenjuice leaves the result unchanged", async () => {
    handlers.push(vi.fn(() => undefined));

    const middleware = createTokenjuiceAgentToolResultMiddleware();

    await expect(
      middleware(createEvent(), {
        runtime: "pi",
      }),
    ).resolves.toBeUndefined();
  });

  it("chains tokenjuice handlers with the latest content and details", async () => {
    const first = vi.fn(() =>
      createTextUpdate("compacted once", { status: "success", reducer: "first" }),
    );
    const second = vi.fn((event: Parameters<TokenjuiceToolResultHandler>[0]) =>
      createTextUpdate(
        `${event.content[0]?.type === "text" ? event.content[0].text : ""} then twice`,
        { ...asRecord(event.details), reducer: "second" },
      ),
    );
    handlers.push(first, second);

    const middleware = createTokenjuiceAgentToolResultMiddleware();
    const result = await middleware(createEvent({ isError: true }), {
      runtime: "codex",
    });

    expect(first).toHaveBeenCalledWith(
      {
        toolName: "exec",
        input: { cmd: "git status" },
        content: baseResult.content,
        details: baseResult.details,
        isError: true,
      },
      { cwd: process.cwd() },
    );
    expect(second).toHaveBeenCalledWith(
      expect.objectContaining({
        content: [{ type: "text", text: "compacted once" }],
        details: { status: "success", reducer: "first" },
      }),
      { cwd: process.cwd() },
    );
    expect(result).toEqual({
      result: {
        content: [{ type: "text", text: "compacted once then twice" }],
        details: { status: "success", reducer: "second" },
      },
    });
  });

  it("preserves previous fields when a tokenjuice handler returns a partial update", async () => {
    handlers.push(() => createTextUpdate("compacted"));

    const middleware = createTokenjuiceAgentToolResultMiddleware();

    await expect(middleware(createEvent(), { runtime: "pi" })).resolves.toEqual({
      result: {
        content: [{ type: "text", text: "compacted" }],
        details: baseResult.details,
      },
    });
  });

  it("passes cwd from event cwd before workdir and process cwd", async () => {
    const handler = vi.fn(() => undefined);
    handlers.push(handler);

    const middleware = createTokenjuiceAgentToolResultMiddleware();

    await middleware(
      createEvent({
        cwd: "/repo/from-event",
        args: { cmd: "git status", workdir: "/repo/from-args" },
      }),
      { runtime: "pi" },
    );

    expect(handler).toHaveBeenCalledWith(expect.any(Object), { cwd: "/repo/from-event" });
  });

  it("falls back to args.workdir when event cwd is blank", async () => {
    const handler = vi.fn(() => undefined);
    handlers.push(handler);

    const middleware = createTokenjuiceAgentToolResultMiddleware();

    await middleware(
      createEvent({
        cwd: " ",
        args: { cmd: "git status", workdir: "/repo/from-workdir" },
      }),
      { runtime: "codex" },
    );

    expect(handler).toHaveBeenCalledWith(expect.any(Object), { cwd: "/repo/from-workdir" });
  });
});
