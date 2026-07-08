#!/usr/bin/env -S node --import tsx
import { execSync } from "node:child_process";
/**
 * Real-behavior proof harness for POST /hooks/agent waitForResult (PR 67433).
 *
 * Boots the production createHooksRequestHandler on a real Node HTTP server and
 * exercises four response shapes via real sockets: waitForResult completed,
 * legacy async accepted, waitForResult agent error, and async idempotency
 * replay. dispatchAgentHook is stubbed at the HookDispatchers boundary (this PR
 * changes the HTTP contract and request handler flow, not
 * runCronIsolatedAgentTurn semantics).
 */
import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { performance } from "node:perf_hooks";
import { createHooksConfig } from "../src/gateway/hooks-test-helpers.js";
import type { HookAgentDispatchPayload } from "../src/gateway/hooks.js";
import { createHooksRequestHandler } from "../src/gateway/server/hooks-request-handler.js";

const HOOK_TOKEN = "hook-secret";
const LISTEN_HOST = "127.0.0.1";
const LISTEN_PORT = 19_120;

type DispatchResult = {
  runId: string;
  sessionKey: string;
  outputText?: string;
  agentError?: string;
};

type ProofCaseResult = {
  label: string;
  status: number;
  latencyMs: number;
  body: Record<string, unknown>;
};

const hookLogs: string[] = [];
let dispatchCalls = 0;

function logHooks(level: "info" | "warn", message: string, meta?: Record<string, unknown>): void {
  const line = `${new Date().toISOString()} [hooks][${level}] ${message}${
    meta ? ` ${JSON.stringify(meta)}` : ""
  }`;
  hookLogs.push(line);
  console.error(line);
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

function createDispatchStub(): (value: HookAgentDispatchPayload) => Promise<DispatchResult> {
  return async (value) => {
    dispatchCalls += 1;
    logHooks("info", "hook agent dispatch started", {
      runId: value.runId,
      name: value.name,
      waitForResult: value.waitForResult === true,
      announceToMain: value.announceToMain !== false,
    });

    if (value.waitForResult) {
      await sleep(120);
    }

    if (value.name === "PR67433-proof-err") {
      logHooks("warn", "hook agent run returned non-ok status", {
        runId: value.runId,
        name: value.name,
        status: "error",
      });
      return {
        runId: value.runId ?? "missing-run-id",
        sessionKey: value.sessionKey,
        agentError: "simulated agent failure: model returned status=error",
      };
    }

    if (value.waitForResult) {
      const outputText = `PROOF-OK: agent processed "${value.message}" via run ${value.runId}`;
      if (value.announceToMain === false) {
        logHooks("info", "hook agent run completed without announcement", {
          runId: value.runId,
          sessionKey: value.sessionKey,
          name: value.name,
        });
      }
      return {
        runId: value.runId ?? "missing-run-id",
        sessionKey: value.sessionKey,
        outputText,
      };
    }

    // Async path: simulate background completion after the HTTP response returns.
    void sleep(120).then(() => {
      logHooks("info", "hook agent run completed", {
        runId: value.runId,
        sessionKey: value.sessionKey,
        name: value.name,
      });
    });

    return {
      runId: value.runId ?? "missing-run-id",
      sessionKey: value.sessionKey,
    };
  };
}

async function postAgentHook(
  payload: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown>; latencyMs: number }> {
  const bodyText = JSON.stringify(payload);
  const started = performance.now();

  return await new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: LISTEN_HOST,
        port: LISTEN_PORT,
        path: "/hooks/agent",
        method: "POST",
        headers: {
          Authorization: `Bearer ${HOOK_TOKEN}`,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(bodyText),
        },
      },
      (res) => {
        let raw = "";
        res.on("data", (chunk) => {
          raw += String(chunk);
        });
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            body: JSON.parse(raw) as Record<string, unknown>,
            latencyMs: Math.round(performance.now() - started),
          });
        });
      },
    );
    req.on("error", reject);
    req.write(bodyText);
    req.end();
  });
}

async function main(): Promise<void> {
  const gitHead = execSync("git rev-parse HEAD", { encoding: "utf8" }).trim().slice(0, 12);

  const handler = createHooksRequestHandler({
    getHooksConfig: () => createHooksConfig(),
    bindHost: LISTEN_HOST,
    port: LISTEN_PORT,
    logHooks: {
      info: (message: string, meta?: Record<string, unknown>) => logHooks("info", message, meta),
      warn: (message: string, meta?: Record<string, unknown>) => logHooks("warn", message, meta),
      debug: () => {},
      error: () => {},
    } as never,
    dispatchWakeHook: () => {},
    dispatchAgentHook: createDispatchStub(),
  });

  const server = http.createServer((req: IncomingMessage, res: ServerResponse) => {
    void handler(req, res).then((handled) => {
      if (!handled) {
        res.statusCode = 404;
        res.end("not found");
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.listen(LISTEN_PORT, LISTEN_HOST, () => resolve());
    server.on("error", reject);
  });

  const cases: ProofCaseResult[] = [];

  try {
    const test1 = await postAgentHook({
      message: "Reply with PROOF-OK and nothing else.",
      name: "PR67433-proof",
      agentId: "main",
      waitForResult: true,
      announceToMain: false,
      deliver: false,
      timeoutSeconds: 60,
    });
    cases.push({ label: "waitForResult_true", ...test1 });

    const test2 = await postAgentHook({
      message: "hello",
      name: "PR67433-proof-async",
      agentId: "main",
      deliver: false,
    });
    cases.push({ label: "legacy_async", ...test2 });
    await sleep(200);

    const test3 = await postAgentHook({
      message: "trigger failure",
      name: "PR67433-proof-err",
      agentId: "main",
      waitForResult: true,
      announceToMain: true,
      deliver: false,
    });
    cases.push({ label: "waitForResult_agent_error", ...test3 });

    // Async idempotency replay: an identical retry must return the original
    // accepted response (same runId and sessionKey) without re-dispatching.
    const replayPayload = {
      message: "replay me",
      name: "PR67433-proof-replay",
      agentId: "main",
      deliver: false,
      idempotencyKey: "proof-replay-key",
    };
    const dispatchCallsBefore = dispatchCalls;
    const test4a = await postAgentHook(replayPayload);
    cases.push({ label: "async_idempotent_first", ...test4a });
    const test4b = await postAgentHook(replayPayload);
    cases.push({ label: "async_idempotent_replay", ...test4b });
    await sleep(200);
    const replayDispatchCalls = dispatchCalls - dispatchCallsBefore;
    const replayMatches =
      test4b.body.runId === test4a.body.runId &&
      test4b.body.sessionKey === test4a.body.sessionKey &&
      test4b.body.status === "accepted" &&
      replayDispatchCalls === 1;
    logHooks("info", "async idempotency replay verified", {
      runIdMatches: test4b.body.runId === test4a.body.runId,
      sessionKeyMatches: test4b.body.sessionKey === test4a.body.sessionKey,
      dispatchCallsForBothRequests: replayDispatchCalls,
    });
    if (!replayMatches) {
      throw new Error(
        `replay contract violated: first=${JSON.stringify(test4a.body)} replay=${JSON.stringify(
          test4b.body,
        )} dispatchCalls=${replayDispatchCalls}`,
      );
    }
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }

  const summary = {
    head: gitHead,
    node: process.version,
    platform: `${process.platform} ${process.arch}`,
    listen: `${LISTEN_HOST}:${LISTEN_PORT}`,
    cases: Object.fromEntries(
      cases.map((entry) => [
        entry.label,
        {
          status: entry.status,
          latencyMs: entry.latencyMs,
          fields: Object.keys(entry.body).toSorted(),
          body: entry.body,
        },
      ]),
    ),
    hookLogs,
  };

  console.log(JSON.stringify(summary, null, 2));
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
