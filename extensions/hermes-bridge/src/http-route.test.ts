import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { resolveHermesBridgeConfig } from "./config.js";
import { createHermesBridgeHttpHandler } from "./http-route.js";

function makeRequest(params: {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
}): IncomingMessage {
  const rawBody = params.body === undefined ? "" : JSON.stringify(params.body);
  const req = Readable.from(rawBody ? [rawBody] : []) as IncomingMessage;
  req.method = params.method ?? "POST";
  Object.defineProperty(req, "headers", {
    value: params.headers ?? {},
    configurable: true,
  });
  return req;
}

function makeResponse() {
  const headers = new Map<string, string>();
  const res = {
    statusCode: 200,
    setHeader(name: string, value: string) {
      headers.set(name.toLowerCase(), value);
    },
    end(body?: string) {
      this.body = body ?? "";
    },
    body: "",
  } as unknown as ServerResponse & { body: string };
  return { res, headers };
}

async function invoke(params: {
  token?: string;
  envToken?: string;
  config?: unknown;
  body?: unknown;
}) {
  const handler = createHermesBridgeHttpHandler({
    resolveConfig: () =>
      resolveHermesBridgeConfig(
        params.config ?? {
          enabled: true,
          sharedSecretEnv: "HERMES_TOKEN",
          allowedTasks: ["status.echo"],
          allowedTools: [],
        },
      ),
    env: { HERMES_TOKEN: params.envToken ?? "secret" },
  });
  const { res } = makeResponse();
  await handler(
    makeRequest({
      headers: params.token ? { "x-openclaw-hermes-token": params.token } : {},
      body: params.body ?? {
        requestId: "req-1",
        taskId: "status.echo",
        requestedBy: "hermes",
        intent: "echo hello",
        input: { message: "hello" },
      },
    }),
    res,
  );
  return { statusCode: res.statusCode, body: JSON.parse(res.body) as unknown };
}

describe("Hermes bridge HTTP route", () => {
  it("rejects requests without the plugin-local Hermes token", async () => {
    await expect(invoke({ token: undefined })).resolves.toMatchObject({
      statusCode: 401,
      body: { ok: false, status: "blocked", error: { type: "invalid_token" } },
    });
  });

  it("fails closed when the shared-secret env var is missing", async () => {
    await expect(invoke({ token: "secret", envToken: "" })).resolves.toMatchObject({
      statusCode: 503,
      body: { ok: false, status: "failed", error: { type: "missing_secret" } },
    });
  });

  it("executes allowlisted mock tasks when gateway and plugin auth have passed", async () => {
    await expect(invoke({ token: "secret" })).resolves.toMatchObject({
      statusCode: 200,
      body: {
        ok: true,
        requestId: "req-1",
        idempotencyKey: "req-1",
        taskId: "status.echo",
        mode: "mock",
        status: "succeeded",
        output: { message: "hello" },
      },
    });
  });

  it("rejects unknown or unallowlisted task IDs", async () => {
    await expect(
      invoke({
        token: "secret",
        body: { taskId: "email.send", input: { body: "no side effects" } },
      }),
    ).resolves.toMatchObject({
      statusCode: 404,
      body: { ok: false, status: "failed", error: { type: "unknown_task" } },
    });
  });

  it("deduplicates requests with the same idempotencyKey", async () => {
    const store = new Map();
    const handler = createHermesBridgeHttpHandler({
      resolveConfig: () =>
        resolveHermesBridgeConfig({
          enabled: true,
          sharedSecretEnv: "HERMES_TOKEN",
          allowedTasks: ["status.echo"],
        }),
      env: { HERMES_TOKEN: "secret" },
      idempotencyStore: store,
    });
    for (const message of ["first", "second"]) {
      const { res } = makeResponse();
      await handler(
        makeRequest({
          headers: { "x-openclaw-hermes-token": "secret" },
          body: {
            idempotencyKey: "same-key",
            taskId: "status.echo",
            input: { message },
          },
        }),
        res,
      );
    }

    expect(store.get("same-key")).toMatchObject({
      output: { message: "first" },
    });
  });

  it("does not silently run mock-only tasks as real non-dry-run work", async () => {
    await expect(
      invoke({
        token: "secret",
        config: {
          enabled: true,
          mode: "live",
          hermesMode: "real",
          sharedSecretEnv: "HERMES_TOKEN",
          allowedTasks: ["status.echo"],
          allowedTools: [],
        },
        body: {
          taskId: "status.echo",
          dryRun: false,
          input: { message: "real please" },
        },
      }),
    ).resolves.toMatchObject({
      statusCode: 404,
      body: {
        ok: false,
        status: "blocked",
        error: { type: "real_task_unavailable" },
      },
    });
  });

  it("accepts the MVP Hermes dry-run task organizer request", async () => {
    await expect(
      invoke({
        token: "secret",
        config: {
          enabled: true,
          sharedSecretEnv: "HERMES_TOKEN",
          allowedTasks: ["tasks.organize_today"],
          allowedTools: [],
        },
        body: {
          requestId: "mvp-acceptance",
          taskId: "tasks.organize_today",
          intent: "請 OpenClaw 幫我整理今天的任務，但只做 dry-run。",
          allowedTools: [],
          dryRun: true,
          input: {
            request: "請 OpenClaw 幫我整理今天的任務，但只做 dry-run。",
          },
        },
      }),
    ).resolves.toMatchObject({
      statusCode: 200,
      body: {
        status: "succeeded",
        summary: "Dry-run completed. No external side effects were performed.",
        output: {
          dryRun: true,
          sideEffectsPerformed: false,
        },
      },
    });
  });

  it("accepts a dry-run OpenClaw agent team delegation request", async () => {
    await expect(
      invoke({
        token: "secret",
        config: {
          enabled: true,
          sharedSecretEnv: "HERMES_TOKEN",
          allowedTasks: ["agents.ask_team"],
          allowedTools: [],
        },
        body: {
          requestId: "team-dry-run",
          taskId: "agents.ask_team",
          intent: "請 OpenClaw agent 團隊協助分析目前 Hermes bridge 狀態，但只做 dry-run。",
          allowedTools: [],
          dryRun: true,
          input: {
            team: "openclaw",
            question: "為何 Hermes 還無法呼叫 OpenClaw agent 團隊？",
          },
        },
      }),
    ).resolves.toMatchObject({
      statusCode: 200,
      body: {
        status: "succeeded",
        summary: "Dry-run completed. No OpenClaw agents were started.",
        output: {
          team: "openclaw",
          dryRun: true,
          agentsStarted: false,
          sideEffectsPerformed: false,
        },
      },
    });
  });
});
