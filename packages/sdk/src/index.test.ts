import { describe, expect, it } from "vitest";
import {
  FakeTransport,
  createAgentEvent,
  createClientFixture,
  observeGatewaySequence,
  type RequestCall,
} from "./client.test-support.js";
import { OpenClaw, normalizeGatewayEvent } from "./index.js";
import type { GatewayEvent, OpenClawEvent, OpenClawTransport, RunResult } from "./types.js";

class DelayedConnectTransport extends FakeTransport {
  connectCalls = 0;
  private finishConnectCurrent: (() => void) | null = null;

  async connect(): Promise<void> {
    this.connectCalls += 1;
    await new Promise<void>((resolve) => {
      this.finishConnectCurrent = resolve;
    });
  }

  finishConnect(): void {
    const finish = this.finishConnectCurrent;
    if (!finish) {
      throw new Error("expected pending connect");
    }
    this.finishConnectCurrent = null;
    finish();
  }
}

class ClosingEventPumpTransport extends FakeTransport {
  onFirstEventPoll?: () => void;

  override events(): AsyncIterable<GatewayEvent> {
    return {
      [Symbol.asyncIterator]: (): AsyncIterator<GatewayEvent> => {
        let firstPoll = true;
        return {
          next: async (): Promise<IteratorResult<GatewayEvent>> => {
            if (firstPoll) {
              firstPoll = false;
              this.onFirstEventPoll?.();
              await new Promise<void>((resolve) => {
                setTimeout(resolve, 0);
              });
            }
            return { done: true, value: undefined as never };
          },
        };
      },
    };
  }
}

class EventsOnlyTransport implements OpenClawTransport {
  constructor(private readonly eventSource: AsyncIterable<GatewayEvent>) {}

  async request<T = unknown>(): Promise<T> {
    return {} as T;
  }

  events(): AsyncIterable<GatewayEvent> {
    return this.eventSource;
  }
}

function requireTransportCall(calls: readonly RequestCall[], index: number): RequestCall {
  const call = calls[index];
  if (!call) {
    throw new Error(`Expected transport call ${index}`);
  }
  return call;
}

function createListFixture() {
  return createClientFixture({
    "agents.list": { agents: [] },
    "sessions.list": { sessions: [] },
    "tasks.list": { tasks: [] },
    "models.list": { models: [] },
    "tools.catalog": { tools: [] },
    "exec.approval.list": { approvals: [] },
    "environments.list": { environments: [] },
  });
}

function waitForSnapshot(runId: string, fields: Record<string, unknown> = {}) {
  const snapshot = { status: "timeout", runId, ...fields };
  return createClientFixture({ "agent.wait": snapshot }).oc.runs.wait(runId);
}

describe("OpenClaw SDK", () => {
  it("runs an agent through the Gateway agent method", async () => {
    const { transport, oc } = createClientFixture({
      agent: { status: "accepted", runId: "run_123" },
      "agent.wait": { status: "ok", runId: "run_123", sessionKey: "main" },
    });
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
    expect(result.runId).toBe("run_123");
    expect(result.sessionKey).toBe("main");
    expect(result.status).toBe("completed");
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

  it.each<[string, Record<string, unknown>, RunResult["status"]]>([
    [
      "maps aborted wait snapshots to cancelled even when Gateway status is timeout",
      {
        stopReason: "rpc",
        error: "aborted by operator",
      },
      "cancelled",
    ],
    [
      "maps restart wait snapshots to cancelled",
      {
        stopReason: "restart",
        providerStarted: true,
      },
      "cancelled",
    ],
    [
      "maps provider-started rpc timeout wait snapshots to timed_out",
      {
        stopReason: "rpc",
        timeoutPhase: "provider",
        providerStarted: true,
        error: "provider request timed out",
      },
      "timed_out",
    ],
    [
      "maps provider timeout wait errors to timed_out",
      {
        status: "error",
        timeoutPhase: "provider",
        providerStarted: true,
        error: "provider request timed out",
      },
      "timed_out",
    ],
    [
      "does not map provider-started wait errors to timed_out without timeout attribution",
      {
        status: "error",
        providerStarted: true,
        error: "provider authentication failed",
      },
      "failed",
    ],
    [
      "does not treat successful provider-started wait snapshots as timed_out",
      {
        status: "ok",
        providerStarted: true,
      },
      "completed",
    ],
    [
      "maps auth-revoked wait snapshots to cancelled",
      {
        stopReason: "auth-revoked",
        error: "provider auth was removed",
      },
      "cancelled",
    ],
    ["keeps wait-only deadlines non-terminal", {}, "accepted"],
    [
      "keeps queued wait snapshots non-terminal",
      {
        status: "pending",
        timeoutPhase: "queue",
        providerStarted: false,
      },
      "accepted",
    ],
    [
      "keeps provider-attributed pending-error wait deadlines non-terminal",
      {
        error: "provider request timed out",
        pendingError: true,
        timeoutPhase: "provider",
        providerStarted: true,
      },
      "accepted",
    ],
    [
      "maps terminal runtime timeout snapshots to timed_out",
      {
        stopReason: "timeout",
        error: "agent runtime timeout",
      },
      "timed_out",
    ],
  ])("%s", async (_label, fields, expectedStatus) => {
    const result = await waitForSnapshot("run_wait", fields);
    expect(result.runId).toBe("run_wait");
    expect(result.status).toBe(expectedStatus);
    expect(result.error).toEqual(fields.error ? { message: fields.error } : undefined);
  });

  it("keeps superseded writer runs cancelled in both events and waits", async () => {
    const event = normalizeGatewayEvent(
      createAgentEvent("run_superseded", 1, 123, "lifecycle", {
        phase: "end",
        aborted: true,
        status: "superseded",
        stopReason: "superseded",
        endedAt: 123,
      }),
    );
    const result = await waitForSnapshot("run_superseded", {
      status: "error",
      stopReason: "superseded",
      endedAt: 123,
    });

    expect.soft(event.type).toBe("run.cancelled");
    expect(result.status).toBe("cancelled");
  });

  it("maps terminal timeout snapshots without stop reasons to timed_out", async () => {
    const { transport, oc } = createClientFixture({
      "agent.wait": { status: "timeout", runId: "run_timed_out", startedAt: 123, endedAt: 456 },
    });
    const result = await oc.runs.wait("run_timed_out");

    expect(result.runId).toBe("run_timed_out");
    expect(result.status).toBe("timed_out");
    expect(result.startedAt).toBe(123);
    expect(result.endedAt).toBe(456);
    expect(result.error).toBeUndefined();
    expect(transport.calls).toEqual([
      { method: "agent.wait", params: { runId: "run_timed_out" }, options: { timeoutMs: null } },
    ]);
  });

  it("splits provider-qualified model refs and rejects unsupported run options", async () => {
    const { transport, oc } = createClientFixture({
      agent: { status: "accepted", runId: "run_openrouter" },
    });

    await oc.runs.create({
      input: "use a routed model",
      model: "openrouter/deepseek/deepseek-r1",
      idempotencyKey: "model-ref-test",
    });

    expect(requireTransportCall(transport.calls, 0)).toEqual({
      method: "agent",
      options: { expectFinal: false },
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
    const { transport, oc } = createClientFixture({
      agent: { status: "accepted", runId: "run_timeout" },
    });

    await oc.runs.create({
      input: "short run",
      timeoutMs: 1_500,
      idempotencyKey: "timeout-test",
    });
    await oc.runs.create({
      input: "run without SDK watchdog",
      timeoutMs: 0,
      idempotencyKey: "no-watchdog-test",
    });

    expect(requireTransportCall(transport.calls, 0)).toEqual({
      method: "agent",
      options: { expectFinal: false, timeoutMs: 1_500 },
      params: {
        message: "short run",
        timeout: 2,
        idempotencyKey: "timeout-test",
      },
    });
    expect(requireTransportCall(transport.calls, 1)).toEqual({
      method: "agent",
      options: { expectFinal: false, timeoutMs: null },
      params: {
        message: "run without SDK watchdog",
        timeout: 0,
        idempotencyKey: "no-watchdog-test",
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

  it("calls artifact Gateway RPCs", async () => {
    const artifact = { id: "artifact_123", type: "image", title: "demo.png" };
    const { transport, oc } = createClientFixture({
      "artifacts.list": { artifacts: [structuredClone(artifact)] },
      "artifacts.get": { artifact: structuredClone(artifact) },
      "artifacts.download": {
        artifact: structuredClone(artifact),
        encoding: "base64",
        data: "aGVsbG8=",
      },
    });
    const artifactList = await oc.artifacts.list({ sessionKey: "agent:main:main" });
    expect(artifactList.artifacts).toEqual([artifact]);
    const artifactGet = await oc.artifacts.get("artifact_123", { sessionKey: "agent:main:main" });
    expect(artifactGet.artifact).toEqual(artifact);
    const artifactDownload = await oc.artifacts.download("artifact_123", {
      sessionKey: "agent:main:main",
    });
    expect(artifactDownload.artifact).toEqual(artifact);
    expect(artifactDownload.encoding).toBe("base64");
    expect(artifactDownload.data).toBe("aGVsbG8=");

    expect(transport.calls).toEqual([
      {
        method: "artifacts.list",
        options: undefined,
        params: { sessionKey: "agent:main:main" },
      },
      {
        method: "artifacts.get",
        options: undefined,
        params: { artifactId: "artifact_123", sessionKey: "agent:main:main" },
      },
      {
        method: "artifacts.download",
        options: undefined,
        params: { artifactId: "artifact_123", sessionKey: "agent:main:main" },
      },
    ]);
  });

  it("requires artifact query scope before calling Gateway", async () => {
    const { transport, oc } = createClientFixture();

    await expect(oc.artifacts.list(undefined as never)).rejects.toThrow(
      "oc.artifacts.list requires one of sessionKey, runId, or taskId",
    );
    await expect(oc.artifacts.get("artifact_123", undefined as never)).rejects.toThrow(
      "oc.artifacts.get requires one of sessionKey, runId, or taskId",
    );
    await expect(oc.artifacts.download("artifact_123", undefined as never)).rejects.toThrow(
      "oc.artifacts.download requires one of sessionKey, runId, or taskId",
    );
    expect(transport.calls).toStrictEqual([]);
  });

  it("invokes tools through the Gateway tools.invoke method", async () => {
    const { transport, oc } = createClientFixture({
      "tools.invoke": { ok: true, toolName: "demo", output: { value: 1 }, source: "core" },
    });

    const result = await oc.tools.invoke("demo", {
      args: { mode: "test" },
      sessionKey: "agent:main:main",
      confirm: false,
      idempotencyKey: "tools-invoke-test",
    });
    expect(result.ok).toBe(true);
    expect(result.toolName).toBe("demo");
    expect(result.output).toEqual({ value: 1 });
    expect(transport.calls).toEqual([
      {
        method: "tools.invoke",
        params: {
          name: "demo",
          conversationReadOrigin: "direct-operator",
          args: { mode: "test" },
          sessionKey: "agent:main:main",
          confirm: false,
          idempotencyKey: "tools-invoke-test",
        },
        options: undefined,
      },
    ]);
  });

  it("calls task ledger Gateway methods", async () => {
    const task = {
      id: "task_123",
      status: "running",
      title: "Investigate issue",
      lastActivity: "Running focused tests",
      diffStat: { files: 2, added: 12, removed: 3 },
    };
    const listedTask = {
      ...task,
      runId: "run_123",
      sessionKey: "agent:main:main",
      lastActivity: "Editing the registry",
    };
    const { transport, oc } = createClientFixture({
      "tasks.list": { tasks: [structuredClone(listedTask)] },
      "tasks.get": { task: structuredClone(task) },
      "tasks.cancel": {
        found: true,
        cancelled: true,
        task: { id: "task_123", status: "cancelled" },
      },
    });
    const taskList = await oc.tasks.list({
      status: "running",
      agentId: "main",
      sessionKey: "agent:main:main",
      sortBy: "endedAt",
    });
    expect(taskList.tasks).toEqual([listedTask]);
    const taskGet = await oc.tasks.get("task_123");
    expect(taskGet.task).toEqual(task);
    const taskCancel = await oc.tasks.cancel("task_123", { reason: "user stopped task" });
    expect(taskCancel.found).toBe(true);
    expect(taskCancel.cancelled).toBe(true);
    expect(taskCancel.task).toEqual({ id: "task_123", status: "cancelled" });

    expect(transport.calls).toEqual([
      {
        method: "tasks.list",
        params: {
          status: "running",
          agentId: "main",
          sessionKey: "agent:main:main",
          sortBy: "endedAt",
        },
        options: undefined,
      },
      {
        method: "tasks.get",
        params: { taskId: "task_123" },
        options: undefined,
      },
      {
        method: "tasks.cancel",
        params: { taskId: "task_123", reason: "user stopped task" },
        options: undefined,
      },
    ]);
  });

  it("manages environments through current Gateway methods", async () => {
    const gatewayEnvironment = {
      id: "gateway",
      type: "local",
      label: "Gateway local",
      status: "available",
      capabilities: ["agent.run"],
    };
    const workerEnvironment = {
      id: "worker_123",
      type: "worker",
      status: "available",
      worker: {
        providerId: "static-ssh",
        leaseId: "lease_123",
        state: "ready",
        ageMs: 1000,
        idleMs: 250,
        attachedSessionIds: [],
        tunnelStatus: "stopped",
      },
    };
    const { transport, oc } = createClientFixture({
      "environments.list": { environments: [gatewayEnvironment] },
      "environments.status": gatewayEnvironment,
      "environments.create": workerEnvironment,
      "environments.destroy": { ...workerEnvironment, status: "unavailable" },
    });
    await expect(oc.environments.list()).resolves.toEqual({
      environments: [gatewayEnvironment],
    });
    await expect(oc.environments.status("gateway")).resolves.toEqual(gatewayEnvironment);
    await expect(
      oc.environments.create({ profileId: "development", idempotencyKey: "request_123" }),
    ).resolves.toEqual(workerEnvironment);
    await expect(oc.environments.destroy("worker_123")).resolves.toEqual({
      ...workerEnvironment,
      status: "unavailable",
    });
    await expect(oc.environments.delete("worker_123")).rejects.toThrow(
      "oc.environments.delete is not supported by the current OpenClaw Gateway yet",
    );
    expect(transport.calls).toEqual([
      { method: "environments.list", params: {}, options: undefined },
      { method: "environments.status", params: { environmentId: "gateway" }, options: undefined },
      {
        method: "environments.create",
        params: { profileId: "development", idempotencyKey: "request_123" },
        options: undefined,
      },
      {
        method: "environments.destroy",
        params: { environmentId: "worker_123" },
        options: undefined,
      },
    ]);
  });

  it("sends empty params for no-arg Gateway list helpers", async () => {
    const { transport, oc } = createListFixture();
    await expect(oc.agents.list()).resolves.toEqual({ agents: [] });
    await expect(oc.sessions.list()).resolves.toEqual({ sessions: [] });
    await expect(oc.tasks.list()).resolves.toEqual({ tasks: [] });
    await expect(oc.models.list()).resolves.toEqual({ models: [] });
    await expect(oc.tools.list()).resolves.toEqual({ tools: [] });
    await expect(oc.approvals.list()).resolves.toEqual({ approvals: [] });
    await expect(oc.environments.list()).resolves.toEqual({ environments: [] });

    expect(transport.calls).toEqual([
      { method: "agents.list", params: {}, options: undefined },
      { method: "sessions.list", params: {}, options: undefined },
      { method: "tasks.list", params: {}, options: undefined },
      { method: "models.list", params: {}, options: undefined },
      { method: "tools.catalog", params: {}, options: undefined },
      { method: "exec.approval.list", params: {}, options: undefined },
      { method: "environments.list", params: {}, options: undefined },
    ]);
  });

  it("preserves explicit null params for Gateway list validation", async () => {
    type ListMethod = (this: unknown, params: unknown) => Promise<unknown>;
    const { transport, oc } = createListFixture();
    await (oc.agents.list as unknown as ListMethod).call(oc.agents, null);
    await (oc.sessions.list as unknown as ListMethod).call(oc.sessions, null);
    await (oc.tasks.list as unknown as ListMethod).call(oc.tasks, null);
    await oc.models.list(null);
    await oc.tools.list(null);
    await oc.approvals.list(null);
    await oc.environments.list(null);

    expect(transport.calls).toEqual([
      { method: "agents.list", params: null, options: undefined },
      { method: "sessions.list", params: null, options: undefined },
      { method: "tasks.list", params: null, options: undefined },
      { method: "models.list", params: null, options: undefined },
      { method: "tools.catalog", params: null, options: undefined },
      { method: "exec.approval.list", params: null, options: undefined },
      { method: "environments.list", params: null, options: undefined },
    ]);
  });

  it("rejects tools.effective without a session key before RPC", async () => {
    type EffectiveMethod = (this: unknown, params?: unknown) => Promise<unknown>;
    const { transport, oc } = createClientFixture({
      "tools.effective": { tools: [] },
    });

    await expect((oc.tools.effective as unknown as EffectiveMethod).call(oc.tools)).rejects.toThrow(
      "oc.tools.effective requires sessionKey",
    );
    await expect(
      (oc.tools.effective as unknown as EffectiveMethod).call(oc.tools, {}),
    ).rejects.toThrow("oc.tools.effective requires sessionKey");

    expect(transport.calls).toEqual([]);
  });

  it("keeps close terminal when it races a pending connect", async () => {
    const transport = new DelayedConnectTransport({
      "agents.list": { agents: [] },
    });
    const oc = new OpenClaw({ transport });

    const connect = oc.connect();
    const close = oc.close();
    transport.finishConnect();

    await expect(connect).rejects.toThrow("OpenClaw SDK client is closed");
    await close;
    await expect(oc.agents.list()).rejects.toThrow("OpenClaw SDK client is closed");
    await expect(oc.events()[Symbol.asyncIterator]().next()).rejects.toThrow(
      "OpenClaw SDK client is closed",
    );
    expect(() => oc.rawEvents()).toThrow("OpenClaw SDK client is closed");
    expect(transport.connectCalls).toBe(1);
    expect(transport.calls).toEqual([]);
  });

  it("calls exec approval Gateway RPCs with protocol params", async () => {
    const { transport, oc } = createClientFixture({
      "exec.approval.list": { approvals: [] },
      "exec.approval.resolve": { ok: true },
    });

    await expect(oc.approvals.list()).resolves.toEqual({ approvals: [] });
    const staleDecision = { id: "stale-approval", decision: "allow-once" as const };
    await expect(oc.approvals.respond("approval-123", staleDecision)).resolves.toEqual({
      ok: true,
    });

    expect(transport.calls).toEqual([
      {
        method: "exec.approval.list",
        options: undefined,
        params: {},
      },
      {
        method: "exec.approval.resolve",
        options: undefined,
        params: { id: "approval-123", decision: "allow-once" },
      },
    ]);
  });

  it("does not request after close races event pump startup", async () => {
    const transport = new ClosingEventPumpTransport({
      "agents.list": { agents: [] },
    });
    const oc = new OpenClaw({ transport });
    let closePromise: Promise<void> | undefined;
    transport.onFirstEventPoll = () => {
      closePromise = oc.close();
    };

    await expect(oc.agents.list()).rejects.toThrow("OpenClaw SDK client is closed");
    await closePromise;
    expect(transport.calls).toEqual([]);
  });

  it("cancels runs and checks model auth status through current Gateway methods", async () => {
    const { transport, oc } = createClientFixture({
      agent: { status: "accepted", runId: "run_without_session" },
      "sessions.abort": { ok: true, status: "aborted", abortedRunId: "run_without_session" },
      "models.authStatus": { providers: [] },
    });

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
    expect(requireTransportCall(transport.calls, 1).params).toEqual({
      runId: "run_without_session",
    });
    expect(requireTransportCall(transport.calls, 2).params).toEqual({ probe: false });
  });

  it("rejects normalized event streams when the event pump fails before yielding", async () => {
    const failure = new Error("synthetic transport event failure");
    const transport = new EventsOnlyTransport({
      [Symbol.asyncIterator](): AsyncIterator<GatewayEvent> {
        return {
          next: async () => {
            throw failure;
          },
        };
      },
    });
    const oc = new OpenClaw({ transport });
    const iterator = oc.events()[Symbol.asyncIterator]();
    let futureIterator: AsyncIterator<OpenClawEvent> | undefined;

    try {
      await expect(iterator.next()).rejects.toThrow("synthetic transport event failure");

      futureIterator = oc.events()[Symbol.asyncIterator]();
      await expect(futureIterator.next()).rejects.toThrow("synthetic transport event failure");
    } finally {
      await futureIterator?.return?.();
      await iterator.return?.();
      await oc.close();
    }
  });

  it.each(["ends", "fails"])(
    "replays run events for late consumers after the pump %s",
    async (end) => {
      const failure =
        end === "fails" ? new Error("synthetic post-yield transport event failure") : null;
      const rawEvent = createAgentEvent("run_pump_failure", 1, 1_777_000_000_050, "lifecycle", {
        phase: "start",
      });
      const transport = new EventsOnlyTransport({
        async *[Symbol.asyncIterator]() {
          yield rawEvent;
          if (failure) {
            throw failure;
          }
        },
      });
      const oc = new OpenClaw({ transport });
      const run = await oc.runs.get("run_pump_failure");
      let iterator: AsyncIterator<OpenClawEvent> | undefined;

      try {
        for (let consumer = 0; consumer < 2; consumer += 1) {
          iterator = run.events()[Symbol.asyncIterator]();
          await expect(iterator.next()).resolves.toMatchObject({
            done: false,
            value: { type: "run.started", runId: "run_pump_failure" },
          });
          if (failure) {
            await expect(iterator.next()).rejects.toThrow(failure);
          } else {
            await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
          }
        }
      } finally {
        await iterator?.return?.();
        await oc.close();
      }
    },
  );

  it("retains a quiet run for independent filtered consumers while another run is busy", async () => {
    const { transport, oc } = createClientFixture();
    const run = await oc.runs.get("quiet");
    const all = run.events()[Symbol.asyncIterator]();
    const filteredSource = run.events((event) => event.type === "assistant.delta");
    const filtered = filteredSource[Symbol.asyncIterator]();
    const failedSource = run.events(() => {
      throw new Error("consumer filter failed");
    });
    const failed = failedSource[Symbol.asyncIterator]();

    try {
      await oc.connect();
      const observedLast = observeGatewaySequence(oc, 2003);
      transport.emit(createAgentEvent(run.id, 1, 1, "lifecycle", { phase: "start" }));
      transport.emit(createAgentEvent(run.id, 2, 2, "assistant", { delta: "retained" }));
      for (let seq = 3; seq <= 2003; seq += 1) {
        transport.emit(createAgentEvent("busy", seq, seq, "assistant", { delta: "busy" }));
      }
      await observedLast;

      await expect(all.next()).resolves.toMatchObject({
        done: false,
        value: { type: "run.started", raw: { seq: 1 } },
      });
      await expect(filtered.next()).resolves.toMatchObject({
        done: false,
        value: { type: "assistant.delta", data: { delta: "retained" }, raw: { seq: 2 } },
      });
      await expect(failed.next()).rejects.toThrow("consumer filter failed");
      await all.return?.();

      transport.emit(createAgentEvent(run.id, 2004, 2004, "assistant", { delta: "live" }));
      await expect(filtered.next()).resolves.toMatchObject({
        done: false,
        value: { data: { delta: "live" }, raw: { seq: 2004 } },
      });
      await expect(all.next()).resolves.toEqual({ done: true, value: undefined });
    } finally {
      await all.return?.();
      await filtered.return?.();
      await failed.return?.();
      await oc.close();
    }
  });

  it("does not resurrect an evicted run when it becomes active again", async () => {
    const { transport, oc } = createClientFixture();
    let iterator: AsyncIterator<OpenClawEvent> | undefined;

    try {
      await oc.connect();
      const observedLast = observeGatewaySequence(oc, 101);
      for (let seq = 1; seq <= 101; seq += 1) {
        transport.emit(createAgentEvent(`run-${seq}`, seq, seq, "assistant", { delta: "old" }));
      }
      await observedLast;

      iterator = oc.runEvents("run-1")[Symbol.asyncIterator]();
      const first = iterator.next();
      transport.emit(createAgentEvent("run-1", 102, 102, "assistant", { delta: "new" }));
      await expect(first).resolves.toMatchObject({
        done: false,
        value: { data: { delta: "new" }, raw: { seq: 102 } },
      });
      await oc.close();
      await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
    } finally {
      await iterator?.return?.();
      await oc.close();
    }
  });

  it("creates a session and sends a message as a run", async () => {
    const { transport, oc } = createClientFixture({
      "sessions.create": { key: "session-main", label: "Main" },
      "sessions.send": { status: "accepted", runId: "run_session" },
      "sessions.compact": { ok: true, compacted: true },
    });

    const session = await oc.sessions.create({
      key: "session-main",
      thinkingLevel: "high",
      parentSessionKey: "main",
      emitCommandHooks: true,
      succeedsParent: false,
    });
    const run = await session.send({ message: "continue", thinking: "medium", timeoutMs: 1_500 });
    const noTimeoutRun = await session.send({ message: "continue without timeout", timeoutMs: 0 });
    await session.compact();

    expect(run.id).toBe("run_session");
    expect(noTimeoutRun.id).toBe("run_session");
    expect(transport.calls).toEqual([
      {
        method: "sessions.create",
        options: undefined,
        params: {
          key: "session-main",
          thinkingLevel: "high",
          parentSessionKey: "main",
          emitCommandHooks: true,
          succeedsParent: false,
        },
      },
      {
        method: "sessions.send",
        options: { expectFinal: true, timeoutMs: 1_500 },
        params: { key: "session-main", message: "continue", thinking: "medium", timeoutMs: 1_500 },
      },
      {
        method: "sessions.send",
        options: { expectFinal: true, timeoutMs: null },
        params: { key: "session-main", message: "continue without timeout", timeoutMs: 0 },
      },
      {
        method: "sessions.compact",
        options: { timeoutMs: null },
        params: { key: "session-main" },
      },
    ]);
  });

  it("keeps key-only Session.abort compatible by omitting clearQueued", async () => {
    const { transport, oc } = createClientFixture({
      "sessions.create": { key: "session-main", label: "Main" },
      "sessions.abort": { ok: true, abortedRunId: null, status: "no-active-run" },
    });

    const session = await oc.sessions.create({ key: "session-main" });
    await session.abort();

    expect(transport.calls.at(-1)).toEqual({
      method: "sessions.abort",
      options: undefined,
      params: { key: "session-main" },
    });
  });

  it("normalizes Gateway agent stream events into SDK events", () => {
    const ts = 1_777_000_000_000;
    const check = (
      type: OpenClawEvent["type"],
      seq: number,
      data: Record<string, unknown>,
      stream = "lifecycle",
    ) => {
      const event = normalizeGatewayEvent(
        createAgentEvent("run_1", seq, ts, stream, structuredClone(data)),
      );
      expect(event.type).toBe(type);
      expect(event.runId).toBe("run_1");
      expect(event.data).toEqual(data);
    };

    check("run.started", 1, { phase: "start" });
    check("assistant.delta", 2, { delta: "hello" }, "assistant");
    check("run.completed", 3, { phase: "end" });
    check("run.cancelled", 4, { phase: "end", aborted: true });
    check("run.cancelled", 5, { phase: "end", aborted: true, stopReason: "rpc" });
    check("run.cancelled", 6, {
      phase: "end",
      aborted: true,
      stopReason: "restart",
      providerStarted: true,
    });
    check("run.cancelled", 7, {
      phase: "error",
      aborted: true,
      stopReason: "restart",
      error: "agent run aborted for restart",
    });
    check("run.timed_out", 8, {
      phase: "end",
      aborted: true,
      stopReason: "rpc",
      timeoutPhase: "provider",
      providerStarted: true,
    });
    check("run.timed_out", 9, {
      phase: "error",
      error: "provider request timed out",
      timeoutPhase: "provider",
      providerStarted: true,
    });
    check("run.failed", 10, {
      phase: "error",
      executionSettled: true,
      error: "provider authentication failed",
      providerStarted: true,
    });
    check("run.timed_out", 11, {
      phase: "end",
      timeoutPhase: "provider",
      providerStarted: true,
    });
    check("run.completed", 12, {
      phase: "end",
      providerStarted: true,
    });
    check("run.cancelled", 13, {
      phase: "end",
      status: "cancelled",
      aborted: true,
      stopReason: "auth-revoked",
    });
    check("run.timed_out", 14, { phase: "end", stopReason: "timeout" });
  });
});
