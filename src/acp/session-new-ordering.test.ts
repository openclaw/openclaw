import type { AnyMessage } from "@agentclientprotocol/sdk";
import { describe, expect, it } from "vitest";
import { AcpSessionNewOrdering } from "./session-new-ordering.js";

type Step = { inbound: AnyMessage } | { outbound: AnyMessage };

/** Observes inbound traffic synchronously before dispatch, as serveAcpGateway does. */
async function runSteps(steps: Step[]): Promise<AnyMessage[]> {
  const ordering = new AcpSessionNewOrdering();
  const stream = new TransformStream<AnyMessage, AnyMessage>({
    transform(message, controller) {
      ordering.transformOutbound(message, controller);
    },
  });
  const outputPromise = (async () => {
    const reader = stream.readable.getReader();
    const output: AnyMessage[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        return output;
      }
      output.push(value);
    }
  })();
  const writer = stream.writable.getWriter();
  for (const step of steps) {
    if ("inbound" in step) {
      ordering.observeInbound(step.inbound);
      continue;
    }
    await writer.write(step.outbound);
  }
  await writer.close();
  return outputPromise;
}

function request(id: number, method: string, params: unknown): AnyMessage {
  return { jsonrpc: "2.0", id, method, params };
}

function newSessionRequest(id: number): AnyMessage {
  return request(id, "session/new", { cwd: "/tmp" });
}

function newSessionResponse(id: number, sessionId: string): AnyMessage {
  return { jsonrpc: "2.0", id, result: { sessionId } } as AnyMessage;
}

function sessionUpdate(sessionId: string, title = "Session"): AnyMessage {
  return {
    jsonrpc: "2.0",
    method: "session/update",
    params: { sessionId, update: { sessionUpdate: "session_info_update", title } },
  } as AnyMessage;
}

describe("AcpSessionNewOrdering", () => {
  it("does not establish a session ID named by a request the protocol has not accepted", async () => {
    const prompted = sessionUpdate("never-created");
    const result = newSessionResponse(2, "other-session");

    // A prompt cannot establish a session the translator will reject as unknown.
    await expect(
      runSteps([
        { inbound: request(5, "session/prompt", { sessionId: "never-created", prompt: [] }) },
        { inbound: newSessionRequest(2) },
        { outbound: prompted },
        { outbound: result },
      ]),
    ).resolves.toEqual([result, prompted]);
  });

  it("keeps a numeric request ID distinct from the same string ID", async () => {
    const stringIdResponse = { jsonrpc: "2.0", id: "2", result: { sessionId: "s" } } as AnyMessage;

    await expect(
      runSteps([
        { inbound: newSessionRequest(2) },
        { outbound: sessionUpdate("s") },
        { outbound: stringIdResponse },
      ]),
    ).resolves.toEqual([stringIdResponse]);
  });

  it("writes updates through once a session's buffer is full", async () => {
    const buffered = Array.from({ length: 256 }, (_, index) =>
      sessionUpdate("unbounded", `buffered-${index}`),
    );
    const overflow = sessionUpdate("unbounded", "overflow");

    const output = await runSteps([
      { inbound: newSessionRequest(1) },
      ...buffered.map((outbound) => ({ outbound })),
      { outbound: overflow },
    ]);

    // Overflow may bypass creation ordering, but must preserve the session's backlog.
    expect(output).toEqual([...buffered, overflow]);
  });

  it("releases an established session ID when the session closes", async () => {
    const created = newSessionResponse(2, "closing-session");
    const afterClose = sessionUpdate("closing-session", "after close");
    const other = newSessionResponse(3, "other-session");

    const output = await runSteps([
      { inbound: newSessionRequest(2) },
      { outbound: created },
      { inbound: request(9, "session/close", { sessionId: "closing-session" }) },
      { inbound: newSessionRequest(3) },
      { outbound: afterClose },
      { outbound: other },
    ]);

    // A late update must wait again once close has retired recognition.
    expect(output).toEqual([created, other, afterClose]);
  });

  it("releases interleaved updates in global arrival order when both creations fail", async () => {
    const a1 = sessionUpdate("session-a", "a1");
    const b1 = sessionUpdate("session-b", "b1");
    const a2 = sessionUpdate("session-a", "a2");
    const failA = { jsonrpc: "2.0", id: 1, error: { code: -32603, message: "a" } } as AnyMessage;
    const failB = { jsonrpc: "2.0", id: 2, error: { code: -32603, message: "b" } } as AnyMessage;

    const output = await runSteps([
      { inbound: newSessionRequest(1) },
      { inbound: newSessionRequest(2) },
      { outbound: a1 },
      { outbound: b1 },
      { outbound: a2 },
      { outbound: failA },
      { outbound: failB },
    ]);

    // Without any established session, drain globally rather than grouping a1 with a2.
    expect(output).toEqual([failA, failB, a1, b1, a2]);
  });

  it("keeps ordering through a burst larger than any cap this file ever carried", async () => {
    const steps: Step[] = [];
    // Past the 512 distinct-session cap this used to carry. A rate limit bounds
    // arrivals, not concurrency, so a slow backend can hold more than that.
    const BURST = 600;
    for (let id = 1; id <= BURST; id += 1) {
      steps.push({ inbound: newSessionRequest(id) });
    }
    // All updates arrive before any creation settles.
    const updates: AnyMessage[] = [];
    for (let id = 1; id <= BURST; id += 1) {
      const update = sessionUpdate(`s${id}`);
      updates.push(update);
      steps.push({ outbound: update });
    }
    const results: AnyMessage[] = [];
    for (let id = 1; id <= BURST; id += 1) {
      const result = newSessionResponse(id, `s${id}`);
      results.push(result);
      steps.push({ outbound: result });
    }

    const output = await runSteps(steps);

    for (const [i, result] of results.entries()) {
      const update = updates[i];
      if (!update) {
        throw new Error(`Missing update for result ${i}`);
      }
      expect(output.indexOf(result)).toBeGreaterThanOrEqual(0);
      expect(output.indexOf(result)).toBeLessThan(output.indexOf(update));
    }
  });

  it("keeps ordering for a bridge that outlives any established-session bound", async () => {
    const steps: Step[] = [];
    // A long-lived bridge that never closes its sessions: well past the 1024 bound
    // this used to carry, ordering must still hold for the next session created.
    for (let id = 1; id <= 1100; id += 1) {
      steps.push(
        { inbound: newSessionRequest(id) },
        { outbound: newSessionResponse(id, `s${id}`) },
      );
    }
    const update = sessionUpdate("late-session");
    const created = newSessionResponse(9000, "late-session");
    steps.push({ inbound: newSessionRequest(9000) }, { outbound: update }, { outbound: created });

    const output = await runSteps(steps);

    expect(output.slice(-2)).toEqual([created, update]);
  });

  it("retires a loaded session the agent rejected", async () => {
    const rejected = {
      jsonrpc: "2.0",
      id: 4,
      error: { code: -32602, message: "no" },
    } as AnyMessage;
    const late = sessionUpdate("client-chosen");
    const other = newSessionResponse(5, "other-session");

    const output = await runSteps([
      {
        inbound: request(4, "session/load", {
          sessionId: "client-chosen",
          cwd: "/tmp",
          mcpServers: [{}],
        }),
      },
      { outbound: rejected },
      { inbound: newSessionRequest(5) },
      { outbound: late },
      { outbound: other },
    ]);

    // Rejection must retire the client-chosen ID so its late update waits again.
    expect(output).toEqual([rejected, other, late]);
  });

  it("keeps recognizing a live session whose reload was rejected", async () => {
    const created = newSessionResponse(2, "live-session");
    const rejectedReload = {
      jsonrpc: "2.0",
      id: 6,
      error: { code: -32602, message: "no" },
    } as AnyMessage;
    const update = sessionUpdate("live-session", "still live");

    const output = await runSteps([
      { inbound: newSessionRequest(2) },
      { outbound: created },
      { inbound: request(6, "session/load", { sessionId: "live-session", cwd: "/tmp" }) },
      { outbound: rejectedReload },
      { inbound: newSessionRequest(7) },
      { outbound: update },
    ]);

    // Rejecting a reload must preserve recognition established by creation.
    expect(output).toEqual([created, rejectedReload, update]);
  });

  it("never lets an update pass an earlier one from the same session", async () => {
    const a1 = sessionUpdate("sa", "a1");
    const b1 = sessionUpdate("sb", "b1");
    const a2 = sessionUpdate("sa", "a2");
    const a3 = sessionUpdate("sa", "a3");
    const resultA = newSessionResponse(1, "sa");
    const resultB = newSessionResponse(2, "sb");

    const output = await runSteps([
      { inbound: newSessionRequest(1) },
      { inbound: newSessionRequest(2) },
      { outbound: a1 },
      { outbound: b1 },
      { outbound: a2 },
      { outbound: resultA },
      { outbound: a3 },
      { outbound: resultB },
    ]);

    // resultA releases sa's backlog in order, so a3 follows a2 rather than overtaking
    // it, and neither waits on sb.
    expect(output).toEqual([resultA, a1, a2, a3, resultB, b1]);
  });

  it("keeps recognition established by one load when an overlapping load fails", async () => {
    const load = (id: number) => request(id, "session/load", { sessionId: "shared", cwd: "/tmp" });
    const accepted = { jsonrpc: "2.0", id: 11, result: {} } as AnyMessage;
    const rejected = {
      jsonrpc: "2.0",
      id: 10,
      error: { code: -32602, message: "no" },
    } as AnyMessage;
    const update = sessionUpdate("shared");

    const output = await runSteps([
      { inbound: load(10) },
      { inbound: load(11) },
      // The second load succeeds first; the first is then rejected.
      { outbound: accepted },
      { outbound: rejected },
      { inbound: newSessionRequest(12) },
      { outbound: update },
    ]);

    // Load 11 confirmed the session. Load 10's rejection retires only its own claim,
    // so the session stays recognized and its update goes straight out.
    expect(output).toEqual([accepted, rejected, update]);
  });

  it("does not settle a correlation on an agent-initiated request that reuses the id", async () => {
    const update = sessionUpdate("s");
    // Agent-to-client request IDs may collide with an in-flight session/new.
    const permission = request(5, "session/request_permission", { options: [] });
    const created = newSessionResponse(5, "s");

    await expect(
      runSteps([
        { inbound: newSessionRequest(5) },
        { outbound: update },
        { outbound: permission },
        { outbound: created },
      ]),
    ).resolves.toEqual([permission, created, update]);
  });
});
