import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createBuildSmokeEnv } from "../../../lib/build-smoke-env.mts";
import { parseJsonOutputValues } from "../json-output.mjs";
import { startNodeFixture } from "./release-process.mjs";

const readJson = async (file) => JSON.parse(await fs.readFile(file, "utf8"));
const urlFor = (fixture) => `ws://127.0.0.1:${fixture.port}`;

async function releaseIdentity(codeRoot) {
  const root = path.resolve(codeRoot);
  await fs.access(path.join(root, "openclaw.mjs"));
  const [build, manifest] = await Promise.all([
    readJson(path.join(root, "dist", "build-info.json")),
    readJson(path.join(root, "package.json")),
  ]);
  assert(build.version && build.buildId, "Release lacks positive build identity");
  assert.equal(build.version, manifest.version, "Release manifest/build version mismatch");
  assert(manifest.openclaw?.schemaVersions, "Release manifest lacks schema versions");
  return { build: { ...build, root }, schemaVersions: manifest.openclaw?.schemaVersions };
}

async function command(fixture, codeRoot, args, timeout = 30_000) {
  const process = startNodeFixture([path.resolve(codeRoot, "openclaw.mjs"), ...args], fixture.env);
  let timer;
  /** @type {Error | undefined} */
  let failure;
  try {
    const exit = await Promise.race([
      process.done,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Release CLI timed out after ${timeout}ms`)),
          timeout,
        );
      }),
    ]);
    if (process.error()) {
      throw Object.assign(new Error(`Release CLI failed to spawn: ${process.error().message}`), {
        failureKind: "setup",
      });
    }
    assert.equal(exit.code, 0, `Release CLI exited ${exit.code} (${exit.signal ?? "no signal"})`);
    const values = parseJsonOutputValues(process.output());
    assert.equal(values.length, 1, "Release CLI did not return exactly one JSON value");
    return values[0];
  } catch (error) {
    failure = error instanceof Error ? error : new Error(String(error), { cause: error });
    throw failure;
  } finally {
    clearTimeout(timer);
    const exit = await process.stop();
    if (failure) {
      failure.command = { exit, output: process.output(), error: process.error()?.message };
    }
  }
}

function gatewayCall(fixture, codeRoot, method, params) {
  return command(
    fixture,
    codeRoot,
    [
      "gateway",
      "call",
      method,
      "--url",
      urlFor(fixture),
      "--token",
      fixture.token,
      "--timeout",
      "30000",
      "--json",
      "--params",
      JSON.stringify(params),
    ],
    45_000,
  );
}

async function waitReady(fixture, gateway) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (gateway.error()) {
      throw Object.assign(gateway.error(), { failureKind: "setup" });
    }
    assert(
      gateway.child.exitCode === null && gateway.child.signalCode === null,
      `Reader Gateway exited before readiness (${gateway.child.exitCode}, ${gateway.child.signalCode})`,
    );
    try {
      const response = await fetch(`http://127.0.0.1:${fixture.port}/readyz`, {
        signal: AbortSignal.timeout(Math.min(1000, deadline - Date.now())),
      });
      await response.body?.cancel();
      if (response.ok) {
        return;
      }
    } catch {
      // Connection refusal is normal until this release opens its Gateway listener.
    }
    await delay(Math.min(250, Math.max(0, deadline - Date.now())));
  }
  throw new Error("Reader Gateway did not become ready within 120 seconds");
}

async function withGateway(fixture, codeRoot, run) {
  const { build } = await releaseIdentity(codeRoot);
  const receipt = { status: "failed", expectedBuild: build, observedBuild: null, ready: false };
  const gateway = startNodeFixture(
    [path.resolve(codeRoot, "openclaw.mjs"), "gateway", "run", "--port", String(fixture.port)],
    fixture.env,
  );
  /** @type {Error | undefined} */
  let failure;
  try {
    await waitReady(fixture, gateway);
    receipt.ready = true;
    receipt.probe = await command(fixture, codeRoot, [
      "gateway",
      "probe",
      "--url",
      urlFor(fixture),
      "--token",
      fixture.token,
      "--json",
    ]);
    const target = receipt.probe.targets?.find((entry) => entry.url === urlFor(fixture));
    assert.equal(target?.connect?.ok, true, "Reader probe could not authenticate to its Gateway");
    receipt.observedBuild = {
      source: "probe-rpc",
      version: target.server?.version,
      buildId: target.server?.buildId,
    };
    if (
      receipt.observedBuild.version !== build.version ||
      receipt.observedBuild.buildId !== build.buildId
    ) {
      throw Object.assign(new Error("Live reader identity differs from the invoked release"), {
        failureKind: "setup",
      });
    }
    receipt.reads = await run();
    assert(
      gateway.child.exitCode === null && gateway.child.signalCode === null,
      "Reader Gateway exited during RPC assertions",
    );
    receipt.status = "passed";
  } catch (error) {
    failure = error instanceof Error ? error : new Error(String(error), { cause: error });
    receipt.failureKind = error?.failureKind ?? "compatibility";
    receipt.failure = { message: failure.message, command: error?.command };
  } finally {
    const exit = await gateway.stop();
    receipt.gateway = { exit, output: gateway.output(), error: gateway.error()?.message };
  }
  if (failure) {
    throw Object.assign(failure, { receipt });
  }
  return receipt;
}

function historyMessages(history) {
  return history.messages.map((message) => {
    const { __openclaw: metadata } = message;
    const id = metadata?.id ?? message.id;
    assert.equal(typeof id, "string", "History message lacks a public stable ID");
    return { id, role: message.role, content: message.content };
  });
}

function cronContent(job) {
  // Exclude scheduling observations/timestamps; retain authored identity and content verbatim.
  return Object.fromEntries(
    [
      "id",
      "agentId",
      "name",
      "enabled",
      "schedule",
      "sessionTarget",
      "wakeMode",
      "payload",
      "delivery",
    ]
      .filter((key) => Object.hasOwn(job, key))
      .map((key) => [key, job[key]]),
  );
}

async function readFixture(fixture, codeRoot) {
  const sessions = [];
  for (const expected of fixture.expected.sessions) {
    const listing = await gatewayCall(fixture, codeRoot, "sessions.list", {
      agentId: expected.agentId,
      label: expected.label,
      limit: 10,
    });
    assert.equal(listing.sessions.length, 1, "Reader did not uniquely list the seeded session");
    const listed = listing.sessions[0];
    const history = await gatewayCall(fixture, codeRoot, "chat.history", {
      agentId: expected.agentId,
      sessionKey: expected.key,
      limit: 20,
    });
    assert.equal(history.sessionId, expected.sessionId, "History selected a different session");
    const observed = {
      agentId: expected.agentId,
      key: listed.key,
      sessionId: listed.sessionId,
      label: listed.label,
      messages: historyMessages(history),
    };
    assert.deepEqual(
      observed,
      expected,
      "Reader changed session identity, label, or exact history",
    );
    sessions.push(observed);
  }
  const listing = await gatewayCall(fixture, codeRoot, "cron.list", { includeDisabled: true });
  const cron = [];
  for (const expected of fixture.expected.cron) {
    const matches = listing.jobs.filter((job) => job.id === expected.id);
    assert.equal(matches.length, 1, "Reader did not uniquely list the seeded cron job");
    const observed = cronContent(matches[0]);
    assert.deepEqual(observed, expected, "Reader changed cron identity or content");
    cron.push(observed);
  }
  return { sessions, cron };
}

export async function createReaderFixture({ codeRoot, root, port, env = process.env }) {
  const home = path.resolve(root, "home");
  const fixtureEnv = {
    ...createBuildSmokeEnv(home, env),
    OPENCLAW_RELEASE_LAUNCHER_FORWARDED: "1",
    OPENCLAW_DISABLE_BONJOUR: "1",
    OPENCLAW_NO_ONBOARD: "1",
    OPENCLAW_NO_PROMPT: "1",
    CI: "true",
  };
  const stateDir = fixtureEnv.OPENCLAW_STATE_DIR;
  const configPath = fixtureEnv.OPENCLAW_CONFIG_PATH;
  // Refuse to reuse a previous run's state rather than silently contaminating the baseline.
  await fs.mkdir(path.dirname(home), { recursive: true });
  await fs.mkdir(home, { mode: 0o700 });
  await fs.mkdir(stateDir, { mode: 0o700 });
  const agents = ["ops", "research"];
  for (const agentId of agents) {
    await fs.mkdir(path.join(stateDir, "workspaces", agentId), { recursive: true });
  }
  const token = `reader-fixture-${randomUUID()}`;
  await fs.writeFile(
    configPath,
    JSON.stringify({
      gateway: {
        mode: "local",
        bind: "loopback",
        port,
        controlUi: { enabled: false },
        auth: { mode: "token", token },
      },
      agents: {
        ownership: "explicit",
        defaults: { systemAgent: { agentId: "research" } },
        entries: Object.fromEntries(
          agents.map((agentId) => [
            agentId,
            {
              workspace: path.join(stateDir, "workspaces", agentId),
            },
          ]),
        ),
      },
      cron: { enabled: false },
      plugins: { enabled: false },
      update: { checkOnStart: false },
    }),
    { mode: 0o600 },
  );
  const identity = await releaseIdentity(codeRoot);
  const fixture = {
    home,
    stateDir,
    configPath,
    token,
    ...identity,
    expected: { sessions: [], cron: [] },
    env: fixtureEnv,
    port,
  };
  fixture.seedReceipt = await withGateway(fixture, codeRoot, async () => {
    for (const agentId of agents) {
      const label = `reader-continuity-${agentId}`;
      const key = `agent:${agentId}:${label}`;
      const created = await gatewayCall(fixture, codeRoot, "sessions.create", {
        agentId,
        key,
        label,
      });
      assert(created.ok && created.sessionId && created.key === key, "Session writer failed");
      assert.equal(created.runStarted, false, "Fixture unexpectedly started inference");
      const message = `Synthetic prior-reader continuity witness: ${agentId}`;
      const injected = await gatewayCall(fixture, codeRoot, "chat.inject", {
        agentId,
        sessionKey: key,
        message,
      });
      assert(injected.ok && injected.messageId, "History writer did not commit its message");
      const history = await gatewayCall(fixture, codeRoot, "chat.history", {
        agentId,
        sessionKey: key,
        limit: 20,
      });
      assert.equal(history.sessionId, created.sessionId, "Seed history selected another session");
      const messages = historyMessages(history);
      const written = messages.filter((entry) => entry.id === injected.messageId);
      assert.equal(written.length, 1, "Seed history did not retain the injected identity");
      assert.equal(written[0].role, "assistant");
      assert(JSON.stringify(written[0].content).includes(message), "Seed history lost its message");
      fixture.expected.sessions.push({
        agentId,
        key,
        label,
        sessionId: created.sessionId,
        messages,
      });
    }
    const definition = {
      agentId: "ops",
      name: "reader-continuity-cron",
      enabled: false,
      schedule: { kind: "cron", expr: "17 3 * * *", tz: "UTC" },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
      payload: { kind: "systemEvent", text: "Synthetic shared-store reader continuity witness" },
    };
    const job = await gatewayCall(fixture, codeRoot, "cron.add", definition);
    assert.equal(typeof job.id, "string", "Cron writer did not return an identity");
    for (const [key, value] of Object.entries(definition)) {
      if (key !== "schedule") {
        assert.deepEqual(job[key], value, `Cron writer changed ${key}`);
      }
    }
    assert.equal(job.schedule.kind, definition.schedule.kind);
    assert.equal(job.schedule.expr, definition.schedule.expr);
    assert.equal(job.schedule.tz, definition.schedule.tz);
    fixture.expected.cron.push(cronContent(job));
    return await readFixture(fixture, codeRoot);
  });
  return fixture;
}

// Refusals are failures here. The caller can classify the untouched exit/output receipt.
export async function smokeReaderFixture(fixture, codeRoot, options = {}) {
  const reader = {
    ...fixture,
    port: options.port ?? fixture.port,
    env: {
      ...fixture.env,
      ...options.env,
      OPENCLAW_RELEASE_LAUNCHER_FORWARDED: "1",
    },
  };
  return await withGateway(reader, codeRoot, () => readFixture(reader, codeRoot));
}
