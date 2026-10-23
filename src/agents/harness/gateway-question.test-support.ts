import { once } from "node:events";
import { rawDataToString } from "@openclaw/gateway-client/websocket-data";
import { WebSocket, WebSocketServer } from "ws";
import type * as Protocol from "../../../packages/gateway-protocol/src/index.js";
import {
  resetConfigRuntimeState,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import { QuestionManager, QuestionManagerError } from "../../gateway/question-manager.js";
import { createDeferredCore as deferred, type Deferred } from "../../shared/deferred.js";
import { withEnvAsync } from "../../test-utils/env.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../../test-utils/gateway-scheduler-clock.js";
// Collect the real transport before test deadlines; production still imports it lazily.
export { callGatewayTool } from "../tools/gateway.js";

type Held = { entered: Deferred; release: Deferred<boolean> };
type Holds = Partial<Record<"hello" | "registration" | "answer", Held>>;
function hold(holds: Holds, key: keyof Holds) {
  const gate = { entered: deferred(), release: deferred<boolean>() };
  holds[key] = gate;
  return {
    entered: gate.entered.promise,
    release: () => gate.release.resolve(true),
    fail: () => gate.release.resolve(false),
  };
}
type HoldControl = ReturnType<typeof hold>;

// Only the peer is synthetic: question claims use the production tool, one-shot
// call, client, and WebSocket send, with real QuestionManager terminal state.
export async function withQuestionGateway(
  run: (fixture: {
    manager: QuestionManager;
    clock: ReturnType<typeof createGatewaySchedulerClock>;
    backingRun: AbortController;
    requests: Protocol.RequestFrame[];
    waitStarted: Promise<void>;
    holdNextHello: () => HoldControl;
    onResolved: (callback: () => void) => void;
    dropNextResolveResponse: () => void;
    holdRegistration: () => { entered: Promise<void>; release: () => void };
    holdWaitAnswerResponse: () => HoldControl;
  }) => Promise<void>,
) {
  await withEnvAsync(
    {
      OPENCLAW_GATEWAY_URL: undefined,
      OPENCLAW_GATEWAY_PORT: undefined,
      OPENCLAW_GATEWAY_TOKEN: undefined,
      OPENCLAW_GATEWAY_PASSWORD: undefined,
    },
    async () => {
      const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
      await once(server, "listening");
      const address = server.address();
      if (typeof address === "string" || address === null || address.port === 18789) {
        throw new Error("expected an isolated question Gateway port");
      }
      setRuntimeConfigSnapshot({
        gateway: {
          mode: "local",
          port: address.port,
          auth: { mode: "token", token: "synthetic-question-test" },
        },
      });
      const clock = createGatewaySchedulerClock(Date.now());
      const manager = new QuestionManager(createTestGatewayScheduler(clock.clock));
      const backingRun = new AbortController();
      const requests: Protocol.RequestFrame[] = [];
      const waitStarted = deferred();
      const holds: Holds = {};
      let onResolved = () => {};
      let dropResolveResponse = false;
      server.on("connection", (socket) => {
        const send = (frame: object) => socket.send(JSON.stringify(frame));
        send({
          type: "event",
          event: "connect.challenge",
          payload: { nonce: "synthetic-question-nonce", ts: Date.now() },
        });
        socket.on("message", (raw) => {
          const frame = JSON.parse(rawDataToString(raw)) as Protocol.RequestFrame;
          const respond = (payload: unknown) => {
            if (socket.readyState === WebSocket.OPEN) {
              send({ type: "res", id: frame.id, ok: true, payload });
            }
          };
          const respondAfter = (gate: Held | undefined, payload: unknown) => {
            gate?.entered.resolve();
            return (gate?.release.promise ?? Promise.resolve(true)).then((allowed) =>
              allowed ? respond(payload) : socket.terminate(),
            );
          };
          if (frame.method === "connect") {
            const gate = holds.hello;
            delete holds.hello;
            void respondAfter(gate, { type: "hello-ok" });
            return;
          }
          requests.push(frame);
          try {
            if (frame.method === "question.request") {
              const request = frame.params as Protocol.QuestionRequestParams;
              const record = manager.request({
                ...request,
                timeoutMs: request.timeoutMs ?? 60_000,
                isRequesterActive: () => !backingRun.signal.aborted,
              });
              holds.registration?.entered.resolve();
              void (holds.registration?.release.promise ?? Promise.resolve()).then(() =>
                respond(record),
              );
            } else if (frame.method === "question.waitAnswer") {
              const request = frame.params as Protocol.QuestionWaitAnswerParams;
              void manager
                .waitAnswer(request.id, undefined, request.includeResolutionId)
                .then((result) => respondAfter(holds.answer, result));
              waitStarted.resolve();
            } else if (frame.method === "question.resolve") {
              const request = frame.params as Protocol.QuestionResolveParams;
              const result =
                "cancel" in request
                  ? manager.cancel(request.id, request.resolvedBy)
                  : manager.resolve(request.id, request.answers, request.resolvedBy, {
                      resolutionId: request.resolutionId,
                    });
              onResolved();
              if (dropResolveResponse) {
                dropResolveResponse = false;
                socket.terminate();
              } else {
                respond(result);
              }
            } else if (frame.method === "question.list") {
              respond({ questions: manager.list() });
            } else {
              throw new Error(`unexpected question fixture RPC: ${frame.method}`);
            }
          } catch (error) {
            if (!(error instanceof QuestionManagerError)) {
              throw error;
            }
            send({
              type: "res",
              id: frame.id,
              ok: false,
              error: {
                code: "INVALID_REQUEST",
                message: error.message,
                details: { reason: error.code },
              },
            });
          }
        });
      });
      try {
        await run({
          manager,
          clock,
          backingRun,
          requests,
          waitStarted: waitStarted.promise,
          holdNextHello: () => hold(holds, "hello"),
          holdRegistration: () => hold(holds, "registration"),
          holdWaitAnswerResponse: () => hold(holds, "answer"),
          onResolved: (callback) => {
            onResolved = callback;
          },
          dropNextResolveResponse: () => {
            dropResolveResponse = true;
          },
        });
      } finally {
        manager.reset();
        for (const socket of server.clients) {
          socket.terminate();
        }
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
        });
        resetConfigRuntimeState();
      }
    },
  );
}
