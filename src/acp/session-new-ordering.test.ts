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
  const a1 = sessionUpdate("a", "a1");
  const a2 = sessionUpdate("a", "a2");
  const a3 = sessionUpdate("a", "a3");
  const b1 = sessionUpdate("b", "b1");
  const createdA = newSessionResponse(1, "a");
  const createdB = newSessionResponse(2, "b");
  const failed = (id: number): AnyMessage => ({
    jsonrpc: "2.0",
    id,
    error: { code: -32602, message: "rejected" },
  });
  const load = (id: number) => request(id, "session/load", { sessionId: "a", cwd: "/tmp" });
  const failA = failed(1);
  const failB = failed(2);
  const acceptedLoad: AnyMessage = { jsonrpc: "2.0", id: 11, result: {} };
  const rejectedLoad = failed(10);
  const stringIdResponse: AnyMessage = { jsonrpc: "2.0", id: "1", result: { sessionId: "a" } };
  const permission = request(1, "session/request_permission", { options: [] });

  const buffered = Array.from({ length: 257 }, (_, i) => sessionUpdate("unbounded", `update-${i}`));
  const burstResults = Array.from({ length: 600 }, (_, i) => newSessionResponse(i + 1, `s${i}`));
  const burstUpdates = Array.from({ length: 600 }, (_, i) => sessionUpdate(`s${i}`));
  const establishedResults = Array.from({ length: 1100 }, (_, i) =>
    newSessionResponse(i + 1, `s${i}`),
  );
  const lateUpdate = sessionUpdate("late-session");
  const lateResult = newSessionResponse(9000, "late-session");

  it.each<{ name: string; steps: Step[]; expected: AnyMessage[] }>([
    {
      name: "does not recognize a session named by an unaccepted prompt",
      steps: [
        { inbound: request(5, "session/prompt", { sessionId: "a", prompt: [] }) },
        { inbound: newSessionRequest(2) },
        { outbound: a1 },
        { outbound: createdB },
      ],
      expected: [createdB, a1],
    },
    {
      name: "keeps numeric and string request IDs distinct",
      steps: [{ inbound: newSessionRequest(1) }, { outbound: a1 }, { outbound: stringIdResponse }],
      expected: [stringIdResponse],
    },
    {
      name: "retires recognition on session close",
      steps: [
        { inbound: newSessionRequest(1) },
        { outbound: createdA },
        { inbound: request(9, "session/close", { sessionId: "a" }) },
        { inbound: newSessionRequest(2) },
        { outbound: a1 },
        { outbound: createdB },
      ],
      expected: [createdA, createdB, a1],
    },
    {
      name: "drains failed creations in global arrival order",
      steps: [
        { inbound: newSessionRequest(1) },
        { inbound: newSessionRequest(2) },
        { outbound: a1 },
        { outbound: b1 },
        { outbound: a2 },
        { outbound: failA },
        { outbound: failB },
      ],
      expected: [failA, failB, a1, b1, a2],
    },
    {
      name: "retires recognition after a rejected load",
      steps: [
        { inbound: request(1, "session/load", { sessionId: "a", cwd: "/tmp", mcpServers: [{}] }) },
        { outbound: failA },
        { inbound: newSessionRequest(2) },
        { outbound: a1 },
        { outbound: createdB },
      ],
      expected: [failA, createdB, a1],
    },
    {
      name: "preserves live recognition after a rejected reload",
      steps: [
        { inbound: newSessionRequest(1) },
        { outbound: createdA },
        { inbound: load(10) },
        { outbound: rejectedLoad },
        { inbound: newSessionRequest(2) },
        { outbound: a1 },
      ],
      expected: [createdA, rejectedLoad, a1],
    },
    {
      name: "never lets a session update overtake its backlog",
      steps: [
        { inbound: newSessionRequest(1) },
        { inbound: newSessionRequest(2) },
        { outbound: a1 },
        { outbound: b1 },
        { outbound: a2 },
        { outbound: createdA },
        { outbound: a3 },
        { outbound: createdB },
      ],
      expected: [createdA, a1, a2, a3, createdB, b1],
    },
    {
      name: "preserves an accepted load when an overlapping load fails",
      steps: [
        { inbound: load(10) },
        { inbound: load(11) },
        { outbound: acceptedLoad },
        { outbound: rejectedLoad },
        { inbound: newSessionRequest(2) },
        { outbound: a1 },
      ],
      expected: [acceptedLoad, rejectedLoad, a1],
    },
    {
      name: "does not settle a creation on an agent-initiated request with the same ID",
      steps: [
        { inbound: newSessionRequest(1) },
        { outbound: a1 },
        { outbound: permission },
        { outbound: createdA },
      ],
      expected: [permission, createdA, a1],
    },
    {
      name: "writes a full session buffer through without dropping its backlog",
      steps: [{ inbound: newSessionRequest(1) }, ...buffered.map((outbound) => ({ outbound }))],
      expected: buffered,
    },
    {
      name: "keeps ordering beyond the former 512 concurrent-session cap",
      steps: [
        ...burstResults.map((_, i) => ({ inbound: newSessionRequest(i + 1) })),
        ...burstUpdates.map((outbound) => ({ outbound })),
        ...burstResults.map((outbound) => ({ outbound })),
      ],
      expected: burstResults.flatMap((result, i) => [result, burstUpdates[i]!]),
    },
    {
      name: "keeps ordering beyond the former 1024 established-session cap",
      steps: [
        ...establishedResults.flatMap((outbound, i) => [
          { inbound: newSessionRequest(i + 1) },
          { outbound },
        ]),
        { inbound: newSessionRequest(9000) },
        { outbound: lateUpdate },
        { outbound: lateResult },
      ],
      expected: [...establishedResults, lateResult, lateUpdate],
    },
  ])("$name", async ({ steps, expected }) => {
    await expect(runSteps(steps)).resolves.toEqual(expected);
  });
});
