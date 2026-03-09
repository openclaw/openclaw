import type { Message } from "@a2a-js/sdk";
import type { ExecutionEventBus, RequestContext } from "@a2a-js/sdk/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { A2APluginConfig } from "./config.js";
import { OpenClawAgentExecutor } from "./executor.js";

// ── Mock fetch ───────────────────────────────────────────────────────

const mockFetch = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", mockFetch);
});

afterEach(() => {
  mockFetch.mockReset();
  vi.unstubAllGlobals();
});

// ── Helpers ──────────────────────────────────────────────────────────

function createConfig(overrides?: Partial<A2APluginConfig>): A2APluginConfig {
  return {
    enabled: true,
    card: {
      name: "Test",
      description: "Test",
      version: "1.0.0",
      skills: [],
      defaultInputModes: ["text"],
      defaultOutputModes: ["text"],
    },
    auth: { mode: "none" },
    routing: { defaultAgentId: "default" },
    peers: [],
    timeouts: { agentResponseMs: 30_000, taskRetentionMs: 86_400_000 },
    ...overrides,
  };
}

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

function createEventBus(): ExecutionEventBus & { events: unknown[] } {
  const events: unknown[] = [];
  let finishedCalled = false;
  return {
    events,
    publish(event: unknown) {
      events.push(event);
    },
    finished() {
      finishedCalled = true;
    },
    on: vi.fn(),
    off: vi.fn(),
    once: vi.fn(),
    removeAllListeners: vi.fn(),
    get _finished() {
      return finishedCalled;
    },
  } as unknown as ExecutionEventBus & { events: unknown[]; _finished: boolean };
}

function createContext(overrides?: Partial<RequestContext>): RequestContext {
  return {
    taskId: "task-1",
    contextId: "ctx-1",
    userMessage: {
      kind: "message",
      messageId: "msg-1",
      role: "user",
      parts: [{ kind: "text", text: "Hello agent!" }],
    } as Message,
    ...overrides,
  } as RequestContext;
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response;
}

// ── Tests: execute ───────────────────────────────────────────────────

describe("OpenClawAgentExecutor", () => {
  describe("execute", () => {
    it("publishes working status, then completed with reply", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          choices: [{ message: { content: "Hello from gateway!" } }],
        }),
      );

      const cfg = createConfig();
      const executor = new OpenClawAgentExecutor(cfg, "http://127.0.0.1:18789", undefined, logger);
      const bus = createEventBus();
      const ctx = createContext();

      await executor.execute(ctx, bus);

      // Should have 2 events: working + completed
      expect(bus.events).toHaveLength(2);

      const working = bus.events[0] as { kind: string; status: { state: string } };
      expect(working.kind).toBe("status-update");
      expect(working.status.state).toBe("working");

      const completed = bus.events[1] as {
        kind: string;
        final: boolean;
        status: { state: string; message: Message };
      };
      expect(completed.kind).toBe("status-update");
      expect(completed.final).toBe(true);
      expect(completed.status.state).toBe("completed");

      // Check reply text
      const replyParts = completed.status.message.parts;
      expect(replyParts).toHaveLength(1);
      expect((replyParts![0] as { text: string }).text).toBe("Hello from gateway!");
    });

    it("publishes failed status for empty message", async () => {
      const cfg = createConfig();
      const executor = new OpenClawAgentExecutor(cfg, "http://127.0.0.1:18789", undefined, logger);
      const bus = createEventBus();
      const ctx = createContext({
        userMessage: {
          kind: "message",
          messageId: "msg-empty",
          role: "user",
          parts: [],
        } as Message,
      });

      await executor.execute(ctx, bus);

      expect(bus.events).toHaveLength(1);
      const event = bus.events[0] as {
        status: { state: string; message: Message };
        final: boolean;
      };
      expect(event.status.state).toBe("failed");
      expect(event.final).toBe(true);
      expect((event.status.message.parts![0] as { text: string }).text).toContain("Empty message");
    });

    it("publishes failed status on gateway error", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ error: "server error" }, 500));

      const cfg = createConfig();
      const executor = new OpenClawAgentExecutor(cfg, "http://127.0.0.1:18789", undefined, logger);
      const bus = createEventBus();
      const ctx = createContext();

      await executor.execute(ctx, bus);

      // working + failed
      expect(bus.events).toHaveLength(2);
      const failed = bus.events[1] as { status: { state: string } };
      expect(failed.status.state).toBe("failed");
    });

    it("publishes failed status when gateway returns empty response", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ choices: [] }));

      const cfg = createConfig();
      const executor = new OpenClawAgentExecutor(cfg, "http://127.0.0.1:18789", undefined, logger);
      const bus = createEventBus();
      const ctx = createContext();

      await executor.execute(ctx, bus);

      const failed = bus.events[1] as {
        status: { state: string; message: Message };
      };
      expect(failed.status.state).toBe("failed");
      expect((failed.status.message.parts![0] as { text: string }).text).toContain(
        "empty response",
      );
    });

    it("always calls finished() even on error", async () => {
      mockFetch.mockRejectedValueOnce(new Error("Network error"));

      const cfg = createConfig();
      const executor = new OpenClawAgentExecutor(cfg, "http://127.0.0.1:18789", undefined, logger);
      const bus = createEventBus();
      const ctx = createContext();

      await executor.execute(ctx, bus);

      expect((bus as unknown as { _finished: boolean })._finished).toBe(true);
    });

    it("uses default agent ID from config", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          choices: [{ message: { content: "reply" } }],
        }),
      );

      const cfg = createConfig({ routing: { defaultAgentId: "my-custom-agent" } });
      const executor = new OpenClawAgentExecutor(cfg, "http://127.0.0.1:18789", undefined, logger);
      const bus = createEventBus();
      const ctx = createContext();

      await executor.execute(ctx, bus);

      // Check the fetch call body
      const fetchBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(fetchBody.model).toBe("my-custom-agent");
    });

    it("uses agent ID from message metadata when present", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          choices: [{ message: { content: "reply" } }],
        }),
      );

      const cfg = createConfig();
      const executor = new OpenClawAgentExecutor(cfg, "http://127.0.0.1:18789", undefined, logger);
      const bus = createEventBus();
      const ctx = createContext({
        userMessage: {
          kind: "message",
          messageId: "msg-routed",
          role: "user",
          parts: [{ kind: "text", text: "Hello" }],
          metadata: { "openclaw.agentId": "specific-agent" },
        } as Message,
      });

      await executor.execute(ctx, bus);

      const fetchBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(fetchBody.model).toBe("specific-agent");
    });

    it("includes gateway auth token in request", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          choices: [{ message: { content: "reply" } }],
        }),
      );

      const cfg = createConfig();
      const executor = new OpenClawAgentExecutor(
        cfg,
        "http://127.0.0.1:18789",
        "gw-secret-token",
        logger,
      );
      const bus = createEventBus();
      const ctx = createContext();

      await executor.execute(ctx, bus);

      const fetchHeaders = mockFetch.mock.calls[0][1].headers;
      expect(fetchHeaders.Authorization).toBe("Bearer gw-secret-token");
    });

    it("omits Authorization header when no gateway token", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          choices: [{ message: { content: "reply" } }],
        }),
      );

      const cfg = createConfig();
      const executor = new OpenClawAgentExecutor(cfg, "http://127.0.0.1:18789", undefined, logger);
      const bus = createEventBus();
      const ctx = createContext();

      await executor.execute(ctx, bus);

      const fetchHeaders = mockFetch.mock.calls[0][1].headers;
      expect(fetchHeaders.Authorization).toBeUndefined();
    });

    it("calls correct gateway endpoint URL", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          choices: [{ message: { content: "reply" } }],
        }),
      );

      const cfg = createConfig();
      const executor = new OpenClawAgentExecutor(cfg, "http://10.0.0.1:9090", undefined, logger);
      const bus = createEventBus();
      const ctx = createContext();

      await executor.execute(ctx, bus);

      expect(mockFetch.mock.calls[0][0]).toBe("http://10.0.0.1:9090/v1/chat/completions");
    });

    it("extracts text from multiple text parts", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          choices: [{ message: { content: "combined reply" } }],
        }),
      );

      const cfg = createConfig();
      const executor = new OpenClawAgentExecutor(cfg, "http://127.0.0.1:18789", undefined, logger);
      const bus = createEventBus();
      const ctx = createContext({
        userMessage: {
          kind: "message",
          messageId: "msg-multi",
          role: "user",
          parts: [
            { kind: "text", text: "Line 1" },
            { kind: "data", data: { key: "value" } },
            { kind: "text", text: "Line 2" },
          ],
        } as Message,
      });

      await executor.execute(ctx, bus);

      // Should combine text parts
      const fetchBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(fetchBody.messages[0].content).toBe("Line 1\nLine 2");
    });

    it("sets correct taskId and contextId in events", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          choices: [{ message: { content: "reply" } }],
        }),
      );

      const cfg = createConfig();
      const executor = new OpenClawAgentExecutor(cfg, "http://127.0.0.1:18789", undefined, logger);
      const bus = createEventBus();
      const ctx = createContext({ taskId: "my-task", contextId: "my-ctx" });

      await executor.execute(ctx, bus);

      for (const event of bus.events) {
        const e = event as { taskId: string; contextId: string };
        expect(e.taskId).toBe("my-task");
        expect(e.contextId).toBe("my-ctx");
      }
    });
  });

  describe("cancelTask", () => {
    it("publishes canceled status and calls finished", async () => {
      const cfg = createConfig();
      const executor = new OpenClawAgentExecutor(cfg, "http://127.0.0.1:18789", undefined, logger);
      const bus = createEventBus();

      await executor.cancelTask("task-cancel-1", bus);

      expect(bus.events).toHaveLength(1);
      const event = bus.events[0] as {
        kind: string;
        taskId: string;
        final: boolean;
        status: { state: string };
      };
      expect(event.kind).toBe("status-update");
      expect(event.taskId).toBe("task-cancel-1");
      expect(event.final).toBe(true);
      expect(event.status.state).toBe("canceled");
      expect((bus as unknown as { _finished: boolean })._finished).toBe(true);
    });
  });
});
