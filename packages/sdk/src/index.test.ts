import { describe, expect, it } from "vitest";
import { EventHub, OpenClaw, normalizeGatewayEvent } from "./index.js";
import type { GatewayEvent, GatewayRequestOptions, OpenClawTransport } from "./types.js";

type RequestCall = {
  method: string;
  params?: unknown;
  options?: GatewayRequestOptions;
};

class FakeTransport implements OpenClawTransport {
  readonly calls: RequestCall[] = [];
  private readonly eventHub = new EventHub<GatewayEvent>();

  constructor(private readonly responses: Record<string, unknown>) {}

  async request<T = unknown>(
    method: string,
    params?: unknown,
    options?: GatewayRequestOptions,
  ): Promise<T> {
    this.calls.push({ method, params, options });
    return this.responses[method] as T;
  }

  events(filter?: (event: GatewayEvent) => boolean): AsyncIterable<GatewayEvent> {
    return this.eventHub.stream(filter);
  }

  emit(event: GatewayEvent): void {
    this.eventHub.publish(event);
  }

  close(): void {
    this.eventHub.close();
  }
}

describe("OpenClaw SDK", () => {
  it("runs an agent through the Gateway agent method", async () => {
    const transport = new FakeTransport({
      agent: { status: "accepted", runId: "run_123" },
      "agent.wait": { status: "ok", runId: "run_123", sessionKey: "main" },
    });
    const oc = new OpenClaw({ transport });
    const agent = await oc.agents.get("main");

    const run = await agent.run({
      input: "ship it",
      model: "sonnet-4.6",
      sessionKey: "main",
      timeoutMs: 30_000,
      idempotencyKey: "idempotent-test",
    });
    const result = await run.wait({ timeoutMs: 500 });

    expect(run.id).toBe("run_123");
    expect(result).toMatchObject({
      runId: "run_123",
      sessionKey: "main",
      status: "completed",
    });
    expect(transport.calls).toEqual([
      {
        method: "agent",
        options: { expectFinal: false, timeoutMs: 30_000 },
        params: {
          agentId: "main",
          idempotencyKey: "idempotent-test",
          message: "ship it",
          model: "sonnet-4.6",
          sessionKey: "main",
          timeout: 30,
        },
      },
      {
        method: "agent.wait",
        options: { timeoutMs: null },
        params: { runId: "run_123", timeoutMs: 500 },
      },
    ]);
  });

  it("preserves numeric wait timestamps", async () => {
    const transport = new FakeTransport({
      "agent.wait": { status: "ok", runId: "run_numeric", startedAt: 123, endedAt: 456 },
    });
    const oc = new OpenClaw({ transport });

    const result = await oc.runs.wait("run_numeric");

    expect(result).toMatchObject({
      runId: "run_numeric",
      status: "completed",
      startedAt: 123,
      endedAt: 456,
    });
    expect(transport.calls).toEqual([
      {
        method: "agent.wait",
        params: { runId: "run_numeric" },
        options: { timeoutMs: null },
      },
    ]);
  });

  it("splits provider-qualified model refs and rejects unsupported run options", async () => {
    const transport = new FakeTransport({
      agent: { status: "accepted", runId: "run_openrouter" },
    });
    const oc = new OpenClaw({ transport });

    await oc.runs.create({
      input: "use a routed model",
      model: "openrouter/deepseek/deepseek-r1",
      idempotencyKey: "model-ref-test",
    });

    expect(transport.calls[0]).toMatchObject({
      method: "agent",
      params: {
        message: "use a routed model",
        provider: "openrouter",
        model: "deepseek/deepseek-r1",
        idempotencyKey: "model-ref-test",
      },
    });
    await expect(
      oc.runs.create({
        input: "unsupported",
        idempotencyKey: "unsupported-options-test",
        workspace: { cwd: "/tmp/project" },
        runtime: { type: "managed", provider: "testbox" },
        environment: { type: "local" },
        approvals: "ask",
      }),
    ).rejects.toThrow(
      "OpenClaw Gateway does not support per-run SDK options yet: workspace, runtime, environment, approvals",
    );
  });

  it("ceil-converts run timeoutMs to Gateway timeout seconds", async () => {
    const transport = new FakeTransport({
      agent: { status: "accepted", runId: "run_timeout" },
    });
    const oc = new OpenClaw({ transport });

    await oc.runs.create({
      input: "short run",
      timeoutMs: 1_500,
      idempotencyKey: "timeout-test",
    });

    expect(transport.calls[0]).toMatchObject({
      method: "agent",
      options: { expectFinal: false, timeoutMs: 1_500 },
      params: {
        message: "short run",
        timeout: 2,
        idempotencyKey: "timeout-test",
      },
    });
    await expect(
      oc.runs.create({
        input: "bad timeout",
        timeoutMs: Number.NaN,
        idempotencyKey: "bad-timeout-test",
      }),
    ).rejects.toThrow("timeoutMs must be a finite non-negative number");
  });

  it("throws explicit unsupported errors for SDK namespaces without Gateway RPCs", async () => {
    const transport = new FakeTransport({});
    const oc = new OpenClaw({ transport });

    await expect(oc.tasks.list()).rejects.toThrow(
      "oc.tasks.list is not supported by the current OpenClaw Gateway yet",
    );
    await expect(oc.tasks.get("task_123")).rejects.toThrow(
      "oc.tasks.get is not supported by the current OpenClaw Gateway yet",
    );
    await expect(oc.tasks.cancel("task_123")).rejects.toThrow(
      "oc.tasks.cancel is not supported by the current OpenClaw Gateway yet",
    );
    await expect(oc.tools.invoke("demo")).rejects.toThrow(
      "oc.tools.invoke is not supported by the current OpenClaw Gateway yet",
    );
    await expect(oc.artifacts.list()).rejects.toThrow(
      "oc.artifacts.list is not supported by the current OpenClaw Gateway yet",
    );
    await expect(oc.environments.list()).rejects.toThrow(
      "oc.environments.list is not supported by the current OpenClaw Gateway yet",
    );
    expect(transport.calls).toEqual([]);
  });

  it("cancels runs and checks model auth status through current Gateway methods", async () => {
    const transport = new FakeTransport({
      agent: { status: "accepted", runId: "run_without_session" },
      "sessions.abort": { ok: true, status: "aborted", abortedRunId: "run_without_session" },
      "models.authStatus": { providers: [] },
    });
    const oc = new OpenClaw({ transport });

    const run = await oc.runs.create({
      input: "start",
      idempotencyKey: "cancel-test",
    });
    await run.cancel();
    await oc.models.status({ probe: false });

    expect(transport.calls.map((call) => call.method)).toEqual([
      "agent",
      "sessions.abort",
      "models.authStatus",
    ]);
    expect(transport.calls[1]?.params).toEqual({ runId: "run_without_session" });
    expect(transport.calls[2]?.params).toEqual({ probe: false });
  });

  it("creates a session and sends a message as a run", async () => {
    const transport = new FakeTransport({
      "sessions.create": { key: "session-main", label: "Main" },
      "sessions.send": { status: "accepted", runId: "run_session" },
    });
    const oc = new OpenClaw({ transport });

    const session = await oc.sessions.create({ key: "session-main" });
    const run = await session.send({ message: "continue", thinking: "medium" });

    expect(run.id).toBe("run_session");
    expect(transport.calls).toEqual([
      {
        method: "sessions.create",
        options: undefined,
        params: { key: "session-main" },
      },
      {
        method: "sessions.send",
        options: { expectFinal: true },
        params: { key: "session-main", message: "continue", thinking: "medium" },
      },
    ]);
  });

  it("normalizes Gateway agent stream events into SDK events", () => {
    const ts = 1_777_000_000_000;

    expect(
      normalizeGatewayEvent({
        event: "agent",
        seq: 1,
        payload: { runId: "run_1", stream: "lifecycle", ts, data: { phase: "start" } },
      }),
    ).toMatchObject({
      type: "run.started",
      runId: "run_1",
      data: { phase: "start" },
    });
    expect(
      normalizeGatewayEvent({
        event: "agent",
        seq: 2,
        payload: { runId: "run_1", stream: "assistant", ts, data: { delta: "hello" } },
      }),
    ).toMatchObject({
      type: "assistant.delta",
      runId: "run_1",
      data: { delta: "hello" },
    });
    expect(
      normalizeGatewayEvent({
        event: "agent",
        seq: 3,
        payload: { runId: "run_1", stream: "lifecycle", ts, data: { phase: "end" } },
      }),
    ).toMatchObject({
      type: "run.completed",
      runId: "run_1",
      data: { phase: "end" },
    });
    expect(
      normalizeGatewayEvent({
        event: "agent",
        seq: 4,
        payload: {
          runId: "run_1",
          stream: "lifecycle",
          ts,
          data: { phase: "end", aborted: true },
        },
      }),
    ).toMatchObject({
      type: "run.timed_out",
      runId: "run_1",
      data: { phase: "end", aborted: true },
    });
    expect(
      normalizeGatewayEvent({
        event: "agent",
        seq: 5,
        payload: {
          runId: "run_1",
          stream: "lifecycle",
          ts,
          data: { phase: "end", aborted: true, stopReason: "rpc" },
        },
      }),
    ).toMatchObject({
      type: "run.cancelled",
      runId: "run_1",
      data: { phase: "end", aborted: true, stopReason: "rpc" },
    });
    expect(
      normalizeGatewayEvent({
        event: "agent",
        seq: 6,
        payload: {
          runId: "run_1",
          stream: "lifecycle",
          ts,
          data: { phase: "end", stopReason: "timeout" },
        },
      }),
    ).toMatchObject({
      type: "run.timed_out",
      runId: "run_1",
      data: { phase: "end", stopReason: "timeout" },
    });
  });
});
