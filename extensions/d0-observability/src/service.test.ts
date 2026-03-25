import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildD0RunTraceparent } from "../../../src/infra/d0-traceparent.js";
import { createD0RunObservabilityService, createD0RunObservabilityState } from "./service.js";

function createRuntimeHarness() {
  let listener: ((event: Record<string, unknown>) => void) | undefined;

  return {
    runtime: {
      events: {
        onAgentEvent: vi.fn((nextListener: (event: Record<string, unknown>) => void) => {
          listener = nextListener;
          return () => {
            listener = undefined;
          };
        }),
      },
    },
    emit(event: Record<string, unknown>) {
      listener?.(event);
    },
  };
}

describe("d0-observability service", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let abortTimeoutSpy: ReturnType<typeof vi.spyOn>;
  let timeoutSignal: AbortSignal;

  beforeEach(() => {
    timeoutSignal = new AbortController().signal;
    abortTimeoutSpy = vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeoutSignal);
    fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: vi.fn(),
    });
  });

  afterEach(() => {
    abortTimeoutSpy.mockRestore();
  });

  it("emits grouped run lifecycle events with a stable traceparent", async () => {
    const state = createD0RunObservabilityState();
    state.recordPrompt("session-1", "hello from tg", "user");
    const harness = createRuntimeHarness();
    const service = createD0RunObservabilityService({
      runtime: harness.runtime as never,
      state,
      fetchImpl: fetchMock as never,
    });

    await service.start({
      config: {
        env: {
          DWS_API_URL: "https://dws.test",
        },
        gateway: {
          auth: {
            token: "gateway-token-1",
          },
        },
      },
      workspaceDir: "/tmp/workspace",
      stateDir: "/tmp/state",
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
    });

    harness.emit({
      runId: "run-1",
      sessionKey: "session-1",
      stream: "lifecycle",
      ts: Date.parse("2026-03-25T21:10:00.000Z"),
      data: {
        phase: "start",
        startedAt: Date.parse("2026-03-25T21:10:00.000Z"),
      },
    });
    harness.emit({
      runId: "run-1",
      sessionKey: "session-1",
      stream: "assistant",
      ts: Date.parse("2026-03-25T21:10:01.000Z"),
      data: {
        text: "Hi there",
        delta: "Hi there",
      },
    });
    harness.emit({
      runId: "run-1",
      sessionKey: "session-1",
      stream: "lifecycle",
      ts: Date.parse("2026-03-25T21:10:03.000Z"),
      data: {
        phase: "end",
        endedAt: Date.parse("2026-03-25T21:10:03.000Z"),
      },
    });

    await Promise.resolve();
    await Promise.resolve();

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://dws.test/v1/backend/d0/run-observability",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer gateway-token-1",
          "Content-Type": "application/json",
          traceparent: buildD0RunTraceparent("run-1"),
        }),
        signal: timeoutSignal,
        body: JSON.stringify({
          eventType: "run_started",
          runId: "run-1",
          sessionKey: "session-1",
          input: "hello from tg",
          triggerSource: "user",
          startedAt: "2026-03-25T21:10:00.000Z",
        }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://dws.test/v1/backend/d0/run-observability",
      expect.objectContaining({
        body: JSON.stringify({
          eventType: "first_response",
          runId: "run-1",
          sessionKey: "session-1",
          startedAt: "2026-03-25T21:10:00.000Z",
          firstResponseAt: "2026-03-25T21:10:01.000Z",
        }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      "https://dws.test/v1/backend/d0/run-observability",
      expect.objectContaining({
        body: JSON.stringify({
          eventType: "run_finished",
          runId: "run-1",
          sessionKey: "session-1",
          finalOutput: "Hi there",
          success: true,
          endedAt: "2026-03-25T21:10:03.000Z",
        }),
      }),
    );
  });

  it("emits tool_finished with captured args, result, and timing", async () => {
    const state = createD0RunObservabilityState();
    const harness = createRuntimeHarness();
    const service = createD0RunObservabilityService({
      runtime: harness.runtime as never,
      state,
      fetchImpl: fetchMock as never,
    });

    await service.start({
      config: {
        env: {
          DWS_API_URL: "https://dws.test",
        },
        gateway: {
          auth: {
            token: "gateway-token-1",
          },
        },
      },
      workspaceDir: "/tmp/workspace",
      stateDir: "/tmp/state",
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
    });

    harness.emit({
      runId: "run-2",
      sessionKey: "session-2",
      stream: "lifecycle",
      ts: Date.parse("2026-03-25T21:11:00.000Z"),
      data: {
        phase: "start",
        startedAt: Date.parse("2026-03-25T21:11:00.000Z"),
      },
    });
    harness.emit({
      runId: "run-2",
      sessionKey: "session-2",
      stream: "tool",
      ts: Date.parse("2026-03-25T21:11:01.000Z"),
      data: {
        phase: "start",
        name: "BROWSER_OPEN",
        toolCallId: "tool-2",
        args: {
          url: "https://donutbrowser.ai",
        },
      },
    });
    harness.emit({
      runId: "run-2",
      sessionKey: "session-2",
      stream: "tool",
      ts: Date.parse("2026-03-25T21:11:03.000Z"),
      data: {
        phase: "result",
        name: "BROWSER_OPEN",
        toolCallId: "tool-2",
        isError: false,
        result: {
          ok: true,
        },
      },
    });

    await Promise.resolve();
    await Promise.resolve();

    expect(fetchMock).toHaveBeenCalledWith(
      "https://dws.test/v1/backend/d0/run-observability",
      expect.objectContaining({
        signal: timeoutSignal,
        body: JSON.stringify({
          eventType: "tool_finished",
          runId: "run-2",
          sessionKey: "session-2",
          toolCallId: "tool-2",
          toolName: "BROWSER_OPEN",
          input: {
            url: "https://donutbrowser.ai",
          },
          output: {
            ok: true,
          },
          startedAt: "2026-03-25T21:11:01.000Z",
          endedAt: "2026-03-25T21:11:03.000Z",
        }),
      }),
    );
  });

  it("emits tool_update when the runtime publishes partial tool progress", async () => {
    const state = createD0RunObservabilityState();
    const harness = createRuntimeHarness();
    const service = createD0RunObservabilityService({
      runtime: harness.runtime as never,
      state,
      fetchImpl: fetchMock as never,
    });

    await service.start({
      config: {
        env: {
          DWS_API_URL: "https://dws.test",
        },
        gateway: {
          auth: {
            token: "gateway-token-1",
          },
        },
      },
      workspaceDir: "/tmp/workspace",
      stateDir: "/tmp/state",
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
    });

    harness.emit({
      runId: "run-2b",
      sessionKey: "session-2b",
      stream: "tool",
      ts: Date.parse("2026-03-25T21:11:02.000Z"),
      data: {
        phase: "update",
        name: "BROWSER_OPEN",
        toolCallId: "tool-2b",
        partialResult: {
          status: "loading",
        },
      },
    });

    await Promise.resolve();
    await Promise.resolve();

    expect(fetchMock).toHaveBeenCalledWith(
      "https://dws.test/v1/backend/d0/run-observability",
      expect.objectContaining({
        signal: timeoutSignal,
        body: JSON.stringify({
          eventType: "tool_update",
          runId: "run-2b",
          sessionKey: "session-2b",
          toolCallId: "tool-2b",
          toolName: "BROWSER_OPEN",
          partialResult: {
            status: "loading",
          },
        }),
      }),
    );
  });

  it("warns when backend ingestion returns a non-ok response without breaking runtime flow", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 401,
      text: vi.fn(),
    });
    const state = createD0RunObservabilityState();
    state.recordPrompt("session-3", "hello", "user");
    const harness = createRuntimeHarness();
    const warn = vi.fn();
    const service = createD0RunObservabilityService({
      runtime: harness.runtime as never,
      state,
      fetchImpl: fetchMock as never,
    });

    await service.start({
      config: {
        env: {
          DWS_API_URL: "https://dws.test",
        },
        gateway: {
          auth: {
            token: "gateway-token-1",
          },
        },
      },
      workspaceDir: "/tmp/workspace",
      stateDir: "/tmp/state",
      logger: {
        info: vi.fn(),
        warn,
        error: vi.fn(),
      },
    });

    harness.emit({
      runId: "run-3",
      sessionKey: "session-3",
      stream: "lifecycle",
      ts: Date.parse("2026-03-25T21:12:00.000Z"),
      data: {
        phase: "start",
        startedAt: Date.parse("2026-03-25T21:12:00.000Z"),
      },
    });

    await Promise.resolve();
    await Promise.resolve();

    expect(warn).toHaveBeenCalledWith(
      "d0-observability: backend rejected run event run_started with status 401",
    );
  });
});
