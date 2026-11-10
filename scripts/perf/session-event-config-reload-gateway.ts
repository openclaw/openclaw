/**
 * Real isolated Gateway RPC/cron proof with a loopback model and a scheduling
 * barrier at native transcript preparation. No production seam or Team data.
 * node --import ./scripts/tsx.mjs scripts/perf/session-event-config-reload-gateway.ts
 *   --output <new-directory> [--expect revoked] [--change mcp|plugin]
 * Run from each pinned checkout; child workers use that same source tree.
 * The model first establishes next_check, then the next attempt is held while
 * config.patch changes an unrelated MCP server, or enables the bundled Advisor plugin
 * as the Labs switch does. Capture the failed baseline too.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { CronRunLogEntry } from "../../src/cron/run-log-types.ts";
import type { CronJob } from "../../src/cron/types.ts";
import { buildMockOpenAiResponsesProvider } from "../../src/gateway/test-openai-responses-model.ts";
import { listKnownProviderAuthEnvVarNamesCore } from "../../src/secrets/provider-env-vars.ts";
import {
  connectRestartClient,
  writeRestartToolCall,
} from "../../test/gateway-restart.test-support.ts";
import { writeOpenAiResponsesText } from "../../test/helpers/openai-responses-sse.ts";
import { createOpenClawTestInstance } from "../../test/helpers/openclaw-test-instance.ts";

const { values } = parseArgs({
  options: {
    output: { type: "string" },
    expect: { type: "string", default: "retained" },
    change: { type: "string", default: "mcp" },
  },
});
assert(values.output);
assert(values.change === "mcp" || values.change === "plugin");
const change =
  values.change === "plugin"
    ? { plugins: { entries: { advisor: { enabled: true } } } }
    : { mcp: { servers: { unrelated: { enabled: false, command: "true" } } } };
const output = path.resolve(values.output);
await mkdir(output);
const source = fileURLToPath(new URL("../../", import.meta.url));
const held: ServerResponse[] = [];
let hold = true;
const preparations = new Map<string, number>();
let requests = 0;
const server = createServer((request, response) => {
  void (async () => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(Buffer.from(chunk));
    }
    if (request.url === "/gate") {
      const key = Buffer.concat(chunks).toString("utf8").split(":run:")[0];
      assert(key);
      const count = (preparations.get(key) ?? 0) + 1;
      preparations.set(key, count);
      if (hold && count > 1) {
        held.push(response);
      } else {
        response.end("continue");
      }
      return;
    }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    requests++;
    const input = Array.isArray(body.input) ? body.input : [];
    const lastUser = input.findLastIndex((item: { role?: string }) => item.role === "user");
    const hasOutput = input
      .slice(lastUser + 1)
      .some((item: { type?: string }) => item.type === "function_call_output");
    if (!hasOutput) {
      writeRestartToolCall(
        response,
        randomUUID(),
        "automations",
        { action: "next_check", in: "3s" },
        requests,
      );
    } else {
      writeOpenAiResponsesText(response, {
        text: "Synthetic scheduled work complete.",
        messageId: randomUUID(),
        responseId: randomUUID(),
      });
    }
  })().catch((error: unknown) => {
    response.writeHead(500);
    response.end(String(error));
  });
});
await new Promise<void>((resolve) => {
  server.listen(0, "127.0.0.1", resolve);
});
const address = server.address();
assert(address && typeof address !== "string");
const baseUrl = `http://127.0.0.1:${address.port}`;
const provider = buildMockOpenAiResponsesProvider(`${baseUrl}/v1`, "synthetic-model");
const instance = await createOpenClawTestInstance({
  name: "config-reload",
  entrypoint: [
    "--import",
    "./scripts/tsx.mjs",
    "scripts/perf/session-event-config-reload-entry.ts",
  ],
  startTimeoutMs: 180_000,
  env: {
    ...Object.fromEntries(listKnownProviderAuthEnvVarNamesCore().map((name) => [name, undefined])),
    OPENCLAW_CONFIG_RELOAD_FIXTURE_GATE: `${baseUrl}/gate`,
    OPENCLAW_CONFIG_RELOAD_FIXTURE_CHANGE: values.change,
    OPENCLAW_SKIP_CRON: "0",
    OPENCLAW_TEST_MINIMAL_GATEWAY: "0",
    OPENCLAW_AGENT_RUNTIME: undefined,
    OPENCLAW_BUNDLED_PLUGINS_DIR: undefined,
  },
});
let client: Awaited<ReturnType<typeof connectRestartClient>> | undefined;
const wait = async (ready: () => boolean | Promise<boolean>, label: string) => {
  const deadline = Date.now() + 90_000;
  while (!(await ready())) {
    assert(Date.now() < deadline, `${label} timed out`);
    await delay(50);
  }
};
try {
  await instance.state.writeConfig({
    gateway: {
      mode: "local",
      auth: { mode: "token", token: instance.gatewayToken },
      controlUi: { enabled: false },
    },
    agents: {
      defaults: {
        workspace: instance.state.workspaceDir,
        skipBootstrap: true,
        model: { primary: provider.modelRef },
        modelPolicy: { allow: [provider.modelRef] },
        models: {
          [provider.modelRef]: { agentRuntime: { id: "openclaw" }, params: { transport: "sse" } },
        },
        thinkingDefault: "off",
        timeoutSeconds: 120,
      },
      entries: { main: { workspace: instance.state.workspaceDir } },
    },
    models: { providers: { [provider.providerId]: provider.config } },
    plugins: { enabled: false },
    skills: { load: { watch: false } },
    tools: { allow: ["automations"], codeMode: { enabled: false }, toolSearch: false },
    cron: { enabled: true },
  });
  await instance.startGateway();
  console.log("Gateway ready");
  client = await connectRestartClient(instance, { env: instance.env, deviceIdentity: null });
  const jobs: CronJob[] = [];
  const sessions = [];
  for (const index of [0, 1]) {
    sessions.push(
      await client.request<{ key: string }>(
        "sessions.create",
        {
          agentId: "main",
          label: `Synthetic reload ${index}`,
          idempotencyKey: `reload-${index}`,
        },
        { timeoutMs: 120_000 },
      ),
    );
  }
  const firstAt = new Date(Date.now() + 10_000);
  const expr = `${firstAt.getUTCSeconds()} ${firstAt.getUTCMinutes()} ${firstAt.getUTCHours()} * * *`;
  for (const [index, session] of sessions.entries()) {
    jobs.push(
      await client.request<CronJob>("cron.add", {
        name: `Synthetic reload ${index}`,
        enabled: true,
        schedule: { kind: "cron", expr, tz: "UTC" },
        sessionTarget: `session:${session.key}`,
        wakeMode: "now",
        pacing: { min: "3s", max: "1h" },
        payload: { kind: "agentTurn", message: "Set next check to three seconds and finish." },
        delivery: { mode: "none" },
      }),
    );
  }
  console.log(
    "Created jobs",
    jobs.map((job) => job.id),
  );
  await wait(() => held.length === 2, "two native target preparations");
  const initial = await Promise.all(
    jobs.map((job) =>
      client!.request<{ entries: CronRunLogEntry[] }>("cron.runs", { id: job.id, limit: 1 }),
    ),
  );
  const before = await Promise.all(
    jobs.map((job) => client!.request<CronJob>("cron.get", { id: job.id })),
  );
  console.log("Two preparation gates held");
  const config = await client.request<{ hash: string }>("config.get", {});
  const patchStarted = performance.now();
  const patch = await client.request(
    "config.patch",
    {
      baseHash: config.hash,
      raw: JSON.stringify(change),
    },
    { timeoutMs: 90_000 },
  );
  const patchMs = performance.now() - patchStarted;
  hold = false;
  for (const response of held.splice(0)) {
    response.end("patched");
  }
  await wait(async () => {
    const current = await Promise.all(
      jobs.map((job) => client!.request<CronJob>("cron.get", { id: job.id })),
    );
    return current.every((job) => !job.state.runningAtMs);
  }, "scheduled outcomes");
  const outcomes = await Promise.all(
    jobs.map((job) =>
      client!.request<{ entries: CronRunLogEntry[] }>("cron.runs", { id: job.id, limit: 1 }),
    ),
  );
  const after = await Promise.all(
    jobs.map((job) => client!.request<CronJob>("cron.get", { id: job.id })),
  );
  for (const job of jobs) {
    await client.request("cron.update", { id: job.id, patch: { enabled: false } });
  }
  const result = {
    source,
    initial,
    before,
    patch,
    patchMs,
    outcomes,
    after,
    requests,
    preparations: Object.fromEntries(preparations),
  };
  await writeFile(path.join(output, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result));
  for (const page of initial) {
    const run = page.entries[0];
    assert(run?.status === "ok", "Initial scheduled run must succeed");
    assert(run.nextRunAtMs && run.runAtMs && run.durationMs !== undefined);
    assert(
      run.nextRunAtMs - run.runAtMs - run.durationMs <= 5_000,
      "The real automations tool must establish next_check pacing",
    );
  }
  for (const [index, page] of outcomes.entries()) {
    const run = page.entries[0];
    assert.equal(run?.status, values.expect === "retained" ? "ok" : "error");
    if (values.expect === "retained") {
      const state = after[index]?.state;
      assert(state?.nextRunAtMs && state.lastRunAtMs && state.lastDurationMs !== undefined);
      assert(
        state.nextRunAtMs - state.lastRunAtMs - state.lastDurationMs <= 5_000,
        "Unrelated reload must preserve schedule pacing",
      );
    } else {
      assert(instance.logs().includes("Session event configuration changed; inspect the run"));
    }
  }
} finally {
  hold = false;
  for (const response of held.splice(0)) {
    response.end("continue");
  }
  client?.stop();
  await writeFile(path.join(output, "gateway.log"), instance.logs());
  await instance.cleanup();
  server.closeAllConnections();
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}
