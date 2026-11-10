import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { stopProcessGroup } from "../stop-process-group.mjs";

const [mode, packageRoot] = process.argv.slice(2);
const artifacts = process.env.OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT;
const configPath = process.env.OPENCLAW_CONFIG_PATH;
assert(packageRoot && artifacts && configPath, "Missing isolated survivor paths");
const manifestPath = path.join(packageRoot, "package.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
assert.equal(manifest.name, "openclaw");
const installedRequire = createRequire(manifestPath);
const sdk = (name) =>
  import(pathToFileURL(installedRequire.resolve(`openclaw/plugin-sdk/${name}`)).href);
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const beforePath = path.join(artifacts, "session-share-before.json");
const shareConfig = { groups: ["Team"] };
const commands = ["openclaw.sessions.list.v1", "openclaw.sessions.read.v1"];
const fixtures = [
  { key: "agent:main:upgrade-shared", category: "Team", text: "Preserved Team transcript" },
  { key: "agent:main:upgrade-private", category: "Private", text: "Excluded private transcript" },
];
function record(stage, value) {
  const result = { stage, ...value };
  fs.writeFileSync(
    path.join(artifacts, `session-share-${stage}.json`),
    `${JSON.stringify(result, null, 2)}\n`,
  );
  console.log(JSON.stringify(result));
}
function packageIdentity() {
  const build = readJson(path.join(packageRoot, "dist/build-info.json"));
  assert.equal(build.version, manifest.version);
  assert.match(build.commit, /^[a-f0-9]{40}$/u);
  return {
    version: manifest.version,
    commit: build.commit,
    manifestSha256: createHash("sha256").update(fs.readFileSync(manifestPath)).digest("hex"),
  };
}
function assertConfig() {
  const config = readJson(configPath);
  assert.deepEqual(
    config.gateway?.nodes?.pairing,
    { autoApproveLocal: false, sshVerify: false },
    "Upgrade changed the fixture's explicit pairing owner",
  );
  assert.equal(
    config.agents?.defaults?.models?.["openai/*"]?.agentRuntime?.id,
    "openclaw",
    "Upgrade changed the data-only fixture runtime",
  );
  const plugin = config.plugins.entries["session-share"];
  assert.equal(plugin.enabled, true);
  assert.deepEqual(plugin.config.share, shareConfig, "Upgrade changed source sharing selection");
  assert.equal(Object.hasOwn(plugin.config.share, "involvingProfileId"), false);
  return plugin.config.share;
}
async function inspectRows(before) {
  const { getSessionEntryAsync, resolveStorePath } = await sdk("session-store-runtime");
  const { readVisibleSessionTranscriptMessageEntries } = await sdk("session-transcript-runtime");
  // Bind the fixture store without config loading that could repair the first-hop result.
  const storePath = resolveStorePath(readJson(configPath).session?.store, {
    agentId: "main",
    env: process.env,
  });
  const rows = [];
  for (const expected of before.sessions) {
    const scope = { agentId: "main", sessionKey: expected.key, storePath };
    const entry = await getSessionEntryAsync(scope);
    assert.equal(entry?.sessionId, expected.sessionId, "Upgrade changed stored session identity");
    assert.equal(entry?.category, expected.category, "Upgrade changed stored group");
    const transcript = await readVisibleSessionTranscriptMessageEntries({
      ...scope,
      sessionId: expected.sessionId,
    });
    assert(
      transcript.some(({ message }) => JSON.stringify(message.content).includes(expected.text)),
      "Upgrade lost the stored transcript",
    );
    rows.push({ ...expected, transcriptPreserved: true });
  }
  return rows;
}
async function withReceiver(run) {
  const { GatewayClient } = await sdk("gateway-runtime");
  let client;
  let node;
  try {
    await new Promise((resolve, reject) => {
      client = new GatewayClient({
        url: "ws://127.0.0.1:18789",
        token: process.env.GATEWAY_AUTH_TOKEN_REF,
        deviceIdentity: null,
        clientName: "gateway-client",
        mode: "backend",
        role: "operator",
        scopes: ["operator.admin"],
        onHelloOk: resolve,
        onConnectError: reject,
      });
      client.start();
    });
    const rpc = (method, params) => client.request(method, params, { timeoutMs: 120_000 });
    await run(rpc, async () => {
      const output = fs.openSync(path.join(artifacts, `session-share-${mode}-node.log`), "a");
      try {
        node = spawn(
          process.execPath,
          [
            path.join(packageRoot, "openclaw.mjs"),
            "node",
            "run",
            "--host",
            "127.0.0.1",
            "--port",
            "18789",
          ],
          {
            env: {
              ...process.env,
              OPENCLAW_GATEWAY_TOKEN: process.env.GATEWAY_AUTH_TOKEN_REF,
              OPENCLAW_NO_AUTO_UPDATE: "1",
            },
            detached: true,
            stdio: ["ignore", output, output],
          },
        );
      } finally {
        fs.closeSync(output);
      }
      await once(node, "spawn");
      const deadline = Date.now() + 90_000;
      while (Date.now() < deadline) {
        assert.equal(node.exitCode, null, "Source node exited before pairing");
        for (const method of ["device", "node"]) {
          const pending = (await rpc(`${method}.pair.list`, {})).pending ?? [];
          for (const request of pending) {
            if (method === "node" || request.role === "node") {
              await rpc(`${method}.pair.approve`, { requestId: request.requestId });
            }
          }
        }
        const connected = (await rpc("node.list", {})).nodes?.filter((row) => row.connected) ?? [];
        assert(connected.length <= 1, "Unexpected second source node");
        // Device connection can precede the separate command-surface approval.
        if (
          connected.length === 1 &&
          commands.every((command) => connected[0].commands?.includes(command))
        ) {
          return connected[0].nodeId;
        }
        await delay(100);
      }
      throw new Error("Source node did not pair");
    });
  } finally {
    // The same installed node must leave before replacing its package during update.
    if (node?.pid) {
      await stopProcessGroup(node, { graceMs: 5_000, ignoreSignalErrors: true });
    }
    client?.stop();
  }
}
async function assertCatalog(rpc, startNode, sessions) {
  const hostId = `node:${await startNode()}`;
  const deadline = Date.now() + 30_000;
  let catalog;
  let host;
  do {
    const result = await rpc("sessions.catalog.list", {
      catalogId: "openclaw",
      hostIds: [hostId],
      limitPerHost: 100,
    });
    catalog = result.catalogs.find(({ id }) => id === "openclaw");
    assert(catalog, "Receiver omitted OpenClaw catalog");
    // The shipped baseline reports its first snapshot as CATALOG_LOADING.
    if (catalog.error?.code !== "CATALOG_LOADING") {
      assert.equal(catalog.error, undefined);
    }
    host = catalog.hosts.find((row) => row.hostId === hostId);
    if (host?.error?.code !== "CATALOG_LOADING") {
      assert.equal(host?.error, undefined);
    }
    if (!catalog.error && !host?.error && !catalog.pending && !host?.pending) {
      break;
    }
    await delay(100);
  } while (Date.now() < deadline);
  assert(
    catalog && !catalog.error && !catalog.pending && host && !host.error && !host.pending,
    "Receiver catalog did not settle",
  );
  assert.deepEqual(
    host.sessions.map(({ threadId }) => threadId),
    [fixtures[0].key],
  );
  const read = (threadId) =>
    rpc("sessions.catalog.read", { catalogId: "openclaw", hostId, threadId });
  const allowed = await read(fixtures[0].key);
  assert(allowed.items.some((item) => item.text === fixtures[0].text));
  await assert.rejects(read(fixtures[1].key), /not visible|not shared/iu);
  record(mode, {
    package: packageIdentity(),
    share: assertConfig(),
    sessions,
    receiver: {
      listed: host.sessions.map(({ threadId }) => threadId),
      delivered: allowed.items.map(({ type, text }) => ({ type, text })),
      excluded: fixtures[1].key,
    },
  });
}

if (mode === "configure") {
  assert.equal(manifest.version, "2026.10.7");
  const values = {
    gateway: {
      mode: "local",
      port: 18789,
      bind: "loopback",
      reload: { mode: "off" },
      auth: {
        mode: "token",
        token: { source: "env", provider: "default", id: "GATEWAY_AUTH_TOKEN_REF" },
      },
      controlUi: { enabled: false },
      // The fixture owns approval; silent local approval would race its pending request IDs.
      nodes: {
        pairing: { autoApproveLocal: false, sshVerify: false },
        commands: { allow: commands },
      },
    },
    agents: {
      entries: { main: {} },
      defaults: {
        workspace: process.env.OPENCLAW_TEST_WORKSPACE_DIR,
        skipBootstrap: true,
        // This data-only fixture must not inherit an implicit external agent runtime.
        models: { "openai/*": { agentRuntime: { id: "openclaw" } } },
      },
    },
    plugins: {
      allow: ["session-share"],
      slots: { memory: "none" },
      entries: { "session-share": { enabled: true, config: { share: shareConfig } } },
    },
  };
  const result = spawnSync(
    "openclaw",
    [
      "config",
      "set",
      "--batch-json",
      JSON.stringify(Object.entries(values).map(([key, value]) => ({ path: key, value }))),
    ],
    { encoding: "utf8", timeout: 120_000, maxBuffer: 4 * 1024 * 1024 },
  );
  assert.equal(result.status, 0, result.stderr);
  assertConfig();
} else if (mode === "seed" || mode === "candidate") {
  await withReceiver(async (rpc, startNode) => {
    let before;
    if (mode === "seed") {
      assert.equal(manifest.version, "2026.10.7");
      const sessions = [];
      for (const fixture of fixtures) {
        const created = await rpc("sessions.create", {
          key: fixture.key,
          agentId: "main",
          category: fixture.category,
          visibility: "shared",
        });
        assert.equal(created.ok, true);
        assert.equal(created.key, fixture.key);
        assert.equal(typeof created.sessionId, "string");
        const injected = await rpc("chat.inject", {
          sessionKey: fixture.key,
          agentId: "main",
          message: fixture.text,
        });
        assert.equal(injected.ok, true);
        sessions.push({ ...fixture, sessionId: created.sessionId });
      }
      before = { baseline: packageIdentity(), share: assertConfig(), sessions };
      fs.writeFileSync(beforePath, `${JSON.stringify(before, null, 2)}\n`);
    } else {
      before = readJson(beforePath);
    }
    await assertCatalog(rpc, startNode, await inspectRows(before));
  });
} else if (mode === "inspect") {
  const before = readJson(beforePath);
  const candidate = packageIdentity();
  assert.equal(candidate.commit, process.env.OPENCLAW_DOCKER_E2E_SELECTED_SHA);
  assert.notEqual(candidate.commit, before.baseline.commit);
  record("first-hop", {
    baseline: before.baseline,
    candidate,
    share: assertConfig(),
    sessions: await inspectRows(before),
    beforeStandaloneDoctor: true,
  });
} else {
  throw new Error("Expected configure, seed, inspect, or candidate");
}
