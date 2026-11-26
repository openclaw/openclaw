import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { startNodeFixture } from "./release-process.mjs";
import { MIN_MIGRATION_BYTES } from "./sqlite-migration-facts.mjs";

const pluginId = "upgrade-survivor-nightly";
const shutdownGraceMs = 120_000;

// Serialized into the one trusted fixture plugin. All SDK URLs below come from
// createRequire(installedBaseline/package.json), never the candidate checkout.
function registerBaselineSeed(api, fixture) {
  let started = false;
  api.on("gateway_start", (_event, context) => {
    if (started) {
      return;
    }
    started = true;
    // gateway_start is a notification, not a minutes-long startup barrier. The
    // receipt is the controller's only completion signal; no readiness is faked.
    void seed(context).catch(
      /** @param {unknown} error */
      async (error) => {
        const failureFiles = await import("node:fs");
        const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
        failureFiles.writeFileSync(
          fixture.receiptPath + ".tmp",
          JSON.stringify({ status: "error", error: detail }) + "\n",
        );
        failureFiles.renameSync(fixture.receiptPath + ".tmp", fixture.receiptPath);
      },
    );
  });

  async function seed(context) {
    const { default: seedAssert } = await import("node:assert/strict");
    const { default: seedFiles } = await import("node:fs");
    const { createHash, randomBytes: payloadBytes, randomUUID } = await import("node:crypto");
    const { resolveStorePath, upsertSessionEntry } = await import(fixture.sdk.sessionStore);
    const { appendSessionTranscriptMessagesByIdentity } = await import(fixture.sdk.transcript);
    const { createPluginStateSyncKeyedStore } = await import(fixture.sdk.pluginState);
    const { readOccupiedSqliteBytes } = await import(fixture.factsUrl);
    seedAssert.equal(typeof resolveStorePath, "function");
    seedAssert.equal(typeof upsertSessionEntry, "function");
    seedAssert.equal(typeof appendSessionTranscriptMessagesByIdentity, "function");
    seedAssert.equal(typeof createPluginStateSyncKeyedStore, "function");
    seedAssert(context.abortSignal, "Released gateway_start must supply its drain signal");
    context.abortSignal.throwIfAborted();

    const agentId = "nightly";
    const sessionKey = "agent:nightly:migration";
    const sessionId = randomUUID();
    const storePath = resolveStorePath(undefined, { agentId, env: process.env });
    await upsertSessionEntry({
      agentId,
      sessionKey,
      storePath,
      env: process.env,
      entry: { sessionId, updatedAt: Date.now() },
    });
    const shared = {
      pluginId: fixture.pluginId,
      namespace: "migration",
      key: "sentinel",
      value: {
        label: "Published baseline shared state — 東京",
        nonce: payloadBytes(32).toString("hex"),
      },
    };
    const store = createPluginStateSyncKeyedStore(shared.pluginId, {
      namespace: shared.namespace,
      maxEntries: 1,
      overflowPolicy: "reject-new",
      env: process.env,
    });
    store.register(shared.key, shared.value);
    seedAssert.deepEqual(store.lookup(shared.key), shared.value);

    const hash = (text) => createHash("sha256").update(text).digest("hex");
    let firstWitness;
    let transcript;
    let occupiedBytes = 0;
    let messageCount = 0;
    let batches = 0;
    while (occupiedBytes < fixture.minimumBytes) {
      context.abortSignal.throwIfAborted();
      // The released facade maps its caller array. Bound that array separately
      // from its internal 512-event/1-MiB transaction flushing. Random input is
      // genuine message text, not padding; compressed storage decides growth.
      const messages = Array.from({ length: 64 }, () => {
        const now = Date.now();
        return {
          eventId: randomUUID(),
          now,
          message: {
            role: "user",
            timestamp: now,
            content: [{ type: "text", text: payloadBytes(192 * 1024).toString("base64") }],
          },
        };
      });
      const witness = (input) => ({
        eventId: input.eventId,
        textSha256: hash(input.message.content[0].text),
      });
      firstWitness ??= witness(messages[0]);
      // Expected hashes come from input before the real writer sees it.
      transcript = [firstWitness, witness(messages[32]), witness(messages[63])];
      const results = await appendSessionTranscriptMessagesByIdentity({
        agentId,
        sessionKey,
        sessionId,
        storePath,
        config: api.config,
        messages,
      });
      seedAssert.equal(results.length, messages.length, "Baseline writer dropped message inputs");
      for (const [index, result] of results.entries()) {
        seedAssert.equal(result.appended, true, "Baseline writer did not append fresh input");
        seedAssert.equal(result.messageId, messages[index].eventId);
      }
      messageCount += messages.length;
      batches += 1;
      // Observational read-only PRAGMAs only; no harness checkpoint or seal.
      occupiedBytes = readOccupiedSqliteBytes(fixture.agentPath);
      if (batches % 16 === 0) {
        api.logger.info(`nightly seed: messages=${messageCount} occupiedBytes=${occupiedBytes}`);
      }
    }
    context.abortSignal.throwIfAborted();
    const receipt = {
      status: "complete",
      occupiedBytes,
      messageCount,
      batches,
      witnesses: { agentId, sessionKey, sessionId, transcript, shared },
    };
    seedFiles.writeFileSync(fixture.receiptPath + ".tmp", JSON.stringify(receipt, null, 2) + "\n");
    seedFiles.renameSync(fixture.receiptPath + ".tmp", fixture.receiptPath);
  }
}

async function availablePort() {
  const server = net.createServer();
  const listening = once(server, "listening");
  server.listen(0, "127.0.0.1");
  await listening;
  const port = server.address().port;
  const closed = once(server, "close");
  server.close();
  await closed;
  return port;
}

export async function seedBaselineMigrationFixture({
  baselineRoot: baselineInput,
  root: rootInput,
  artifacts: artifactsInput,
  minimumBytes = MIN_MIGRATION_BYTES,
}) {
  assert(Number.isSafeInteger(minimumBytes) && minimumBytes > 0, "Invalid occupied-byte target");
  const baselineRoot = fs.realpathSync(baselineInput);
  const root = path.resolve(rootInput);
  const artifacts = path.resolve(artifactsInput);
  const packageJsonPath = path.join(baselineRoot, "package.json");
  const baselineManifest = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
  const catalog = JSON.parse(
    fs.readFileSync(
      new URL("../../../lib/upgrade-survivor-scenarios.json", import.meta.url),
      "utf8",
    ),
  );
  assert.equal(baselineManifest.name, "openclaw", "Baseline must be the installed release package");
  assert(catalog.oldestSupportedBaseline, "Nightly requires the catalog's support floor");
  assert.equal(baselineManifest.version, catalog.oldestSupportedBaseline);
  const installedRequire = createRequire(packageJsonPath);
  const resolveSdk = (subpath) => {
    assert(baselineManifest.exports?.[`./plugin-sdk/${subpath}`], `Missing public SDK: ${subpath}`);
    const resolved = fs.realpathSync(installedRequire.resolve(`openclaw/plugin-sdk/${subpath}`));
    assert(
      resolved.startsWith(baselineRoot + path.sep),
      `SDK resolved outside the installed baseline: ${resolved}`,
    );
    return pathToFileURL(resolved).href;
  };
  const sdk = {
    sessionStore: resolveSdk("session-store-runtime"),
    transcript: resolveSdk("session-transcript-runtime"),
    pluginState: resolveSdk("plugin-state-store-runtime"),
  };
  const home = path.join(root, "home");
  const stateDir = path.join(root, "state");
  const configPath = path.join(stateDir, "openclaw.json");
  const agentPath = path.join(stateDir, "agents", "nightly", "agent", "openclaw-agent.sqlite");
  const statePath = path.join(stateDir, "state", "openclaw.sqlite");
  const pluginRoot = path.join(root, "fixture-plugin");
  const workspace = path.join(root, "workspace");
  const tempDir = path.join(root, "tmp");
  const receiptPath = path.join(artifacts, "sqlite-migration-seed.json");
  assert(!fs.existsSync(stateDir), "Refusing to seed existing state");
  assert(!fs.existsSync(receiptPath), "Refusing to reuse a previous seed receipt");
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  fs.mkdirSync(artifacts, { recursive: true });
  for (const directory of [home, stateDir, pluginRoot, workspace, tempDir]) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  const writeJson = (file, value) =>
    fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  writeJson(path.join(pluginRoot, "package.json"), {
    name: "@openclaw-test/nightly-migration-seed",
    version: "1.0.0",
    type: "module",
    openclaw: { extensions: ["./index.mjs"] },
  });
  writeJson(path.join(pluginRoot, "openclaw.plugin.json"), {
    id: pluginId,
    configSchema: { type: "object", properties: {}, additionalProperties: false },
  });
  const fixture = {
    sdk,
    pluginId,
    agentPath,
    minimumBytes,
    receiptPath,
    factsUrl: new URL("./sqlite-migration-facts.mjs", import.meta.url).href,
  };
  fs.writeFileSync(
    path.join(pluginRoot, "index.mjs"),
    `const fixture = ${JSON.stringify(fixture)};\n${registerBaselineSeed.toString()}\nexport default { id: ${JSON.stringify(pluginId)}, register(api) { registerBaselineSeed(api, fixture); } };\n`,
    { flag: "wx", mode: 0o600 },
  );
  const port = await availablePort();
  writeJson(configPath, {
    gateway: {
      mode: "local",
      bind: "loopback",
      port,
      auth: { mode: "token", token: randomBytes(32).toString("hex") },
      controlUi: { enabled: false },
    },
    agents: {
      ownership: "explicit",
      defaults: { systemAgent: { agentId: "nightly" } },
      entries: { nightly: { workspace } },
    },
    session: {
      maintenance: { mode: "warn", maxDiskBytes: false, coldStorage: { enabled: false } },
    },
    cron: { enabled: false },
    plugins: {
      allow: [pluginId],
      load: { paths: [pluginRoot] },
      entries: { [pluginId]: { enabled: true } },
      slots: { memory: "none" },
    },
  });
  // Start from an allowlist, so neither inherited OPENCLAW_* nor provider keys,
  // NODE_OPTIONS preloads, operator profiles or external homes enter this Gateway.
  const env = Object.fromEntries(
    ["PATH", "LANG", "LC_ALL", "TZ", "LD_LIBRARY_PATH"]
      .filter((key) => process.env[key] !== undefined)
      .map((key) => [key, process.env[key]]),
  );
  Object.assign(env, {
    HOME: home,
    TMPDIR: tempDir,
    TMP: tempDir,
    TEMP: tempDir,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
    XDG_DATA_HOME: path.join(home, ".local", "share"),
    OPENCLAW_HOME: home,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_NO_RESPAWN: "1",
  });
  const cli = baselineManifest.bin?.openclaw;
  assert.equal(typeof cli, "string", "Installed baseline has no OpenClaw executable");
  const gateway = startNodeFixture([path.resolve(baselineRoot, cli), "gateway", "run"], env);
  let exit;
  let receipt;
  let exited = false;
  void gateway.exited.then(() => {
    exited = true;
  });
  try {
    while (!fs.existsSync(receiptPath)) {
      assert(!gateway.error(), `Cannot spawn baseline Gateway: ${gateway.error()}`);
      assert(!exited, `Baseline Gateway exited before seed completion: ${gateway.output()}`);
      await delay(250);
    }
    receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8"));
    assert.equal(receipt.status, "complete", receipt.error ?? "Incomplete baseline seed");
    assert(receipt.occupiedBytes >= minimumBytes, "Writer did not reach occupied-byte target");
    assert.equal(receipt.witnesses.transcript.length, 3);
    assert(!exited, "Baseline Gateway exited without the controller's graceful stop");
  } finally {
    // v2026.11.7 run-loop.ts handles SIGTERM and awaits server.close; its
    // server-close.ts drains sdk-work, closeSdkResources, transcript-workers and
    // agent-databases. No public shutdown SDK exists in this published package.
    // Give that owner time to close and reap; a helper SIGKILL is never success.
    // https://github.com/openclaw/openclaw/blob/v2026.11.7/src/gateway/server-close.ts#L613-L655
    try {
      exit = await gateway.stop("SIGTERM", shutdownGraceMs);
    } finally {
      fs.writeFileSync(path.join(artifacts, "sqlite-migration-seed-gateway.log"), gateway.output());
    }
  }
  assert.deepEqual(exit, { code: 0, signal: null }, "Baseline Gateway did not exit cleanly");
  // Parent independently checks the closed files' WAL and occupied pages. A live
  // progress observation above is not a claim that shutdown checkpointed them.
  return {
    env,
    home,
    stateDir,
    configPath,
    agentPath,
    statePath,
    baselineManifest,
    witnesses: receipt.witnesses,
  };
}
