import type { AnyMessage } from "@agentclientprotocol/sdk";
import { expect, it } from "vitest";
import { AcpSessionNewOrdering } from "./session-new-ordering.js";

type Step = { inbound: AnyMessage } | AnyMessage;

/** Observes inbound traffic synchronously before dispatch, as serveAcpGateway does. */
async function runSteps(steps: Step[]): Promise<AnyMessage[]> {
  const ordering = new AcpSessionNewOrdering();
  const stream = new TransformStream<AnyMessage, AnyMessage>({
    transform(message, controller) {
      ordering.transformOutbound(message, controller);
    },
  });
  const output: AnyMessage[] = [];
  const drained = stream.readable.pipeTo(
    new WritableStream<AnyMessage>({
      write(message) {
        output.push(message);
      },
    }),
  );
  const writer = stream.writable.getWriter();
  for (const step of steps) {
    if ("inbound" in step) {
      ordering.observeInbound(step.inbound);
      continue;
    }
    await writer.write(step);
  }
  await writer.close();
  await drained;
  return output;
}

function request(id: number, method: string, params: unknown): AnyMessage {
  return { jsonrpc: "2.0", id, method, params };
}

function inbound(id: number, method: string, params: unknown): Step {
  return { inbound: request(id, method, params) };
}

const newSessionRequest = (id: number): Step => inbound(id, "session/new", { cwd: "/tmp" });

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
const load = (id: number) => inbound(id, "session/load", { sessionId: "a", cwd: "/tmp" });
const newA = newSessionRequest(1);
const newB = newSessionRequest(2);
const closeA = inbound(9, "session/close", { sessionId: "a" });
const rejectedSetup = inbound(1, "session/load", {
  sessionId: "a",
  cwd: "/tmp",
  mcpServers: [{}],
});
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

it.each<[string, Step[], AnyMessage[]]>([
  [
    "does not recognize a session named by an unaccepted prompt",
    [inbound(5, "session/prompt", { sessionId: "a", prompt: [] }), newB, a1, createdB],
    [createdB, a1],
  ],
  [
    "keeps numeric and string request IDs distinct",
    [newA, a1, stringIdResponse],
    [stringIdResponse],
  ],
  [
    "retires recognition on session close",
    [newA, createdA, closeA, newB, a1, createdB],
    [createdA, createdB, a1],
  ],
  [
    "drains failed creations in global arrival order",
    [newA, newB, a1, b1, a2, failA, failB],
    [failA, failB, a1, b1, a2],
  ],
  [
    "retires recognition after a rejected load",
    [rejectedSetup, failA, newB, a1, createdB],
    [failA, createdB, a1],
  ],
  [
    "preserves live recognition after a rejected reload",
    [newA, createdA, load(10), rejectedLoad, newB, a1],
    [createdA, rejectedLoad, a1],
  ],
  [
    "never lets a session update overtake its backlog",
    [newA, newB, a1, b1, a2, createdA, a3, createdB],
    [createdA, a1, a2, a3, createdB, b1],
  ],
  [
    "preserves an accepted load when an overlapping load fails",
    [load(10), load(11), acceptedLoad, rejectedLoad, newB, a1],
    [acceptedLoad, rejectedLoad, a1],
  ],
  [
    "does not settle a creation on an agent-initiated request with the same ID",
    [newA, a1, permission, createdA],
    [permission, createdA, a1],
  ],
  [
    "writes a full session buffer through without dropping its backlog",
    [newA, ...buffered],
    buffered,
  ],
  [
    "keeps ordering beyond the former 512 concurrent-session cap",
    [...burstResults.map((_, i) => newSessionRequest(i + 1)), ...burstUpdates, ...burstResults],
    burstResults.flatMap((result, i) => [result, burstUpdates[i]!]),
  ],
  [
    "keeps ordering beyond the former 1024 established-session cap",
    [
      ...establishedResults.flatMap((result, i) => [newSessionRequest(i + 1), result]),
      newSessionRequest(9000),
      lateUpdate,
      lateResult,
    ],
    [...establishedResults, lateResult, lateUpdate],
  ],
])("%s", async (_name, steps, expected) => {
  await expect(runSteps(steps)).resolves.toEqual(expected);
});
