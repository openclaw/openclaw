import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import {
  databasePath,
  gatewayCall,
  readColdArchives,
  readTranscriptRows,
  runCli,
  seedColdStorageFixture,
  waitForArchives,
} from "./fixture.mjs";

const [phase, entry, proofDir] = process.argv.slice(2);
assert(phase && entry && proofDir);
const context = {
  entry,
  env: process.env,
  url: `ws://127.0.0.1:${process.env.PORT}`,
  token: process.env.OPENCLAW_GATEWAY_TOKEN,
};
const stateDir = process.env.OPENCLAW_STATE_DIR;
const fixturePath = path.join(proofDir, "fixture.json");

async function patchPolicy(coldStorage) {
  const before = await gatewayCall(context, "config.get", {});
  const result = await gatewayCall(context, "config.patch", {
    raw: JSON.stringify({ session: { maintenance: { coldStorage } } }),
    baseHash: before.hash,
  });
  assert.equal(result.restart, undefined, "cold policy must apply without a restart");
  const after = await gatewayCall(context, "config.get", {});
  assert.equal(after.configRevisionHash, after.appliedConfigHash);
}

async function assertHistory(session) {
  const history = await gatewayCall(context, "chat.history", {
    sessionKey: session.sessionKey,
    limit: 100,
  });
  assert.equal(history.sessionId, session.sessionId);
  assert(
    JSON.stringify(history.messages).includes(session.nonce),
    "history omitted the original recall code",
  );
  assert.deepEqual(
    readTranscriptRows(stateDir, session.sessionId),
    session.rows,
    "restoration changed original events",
  );
}

if (phase === "seed") {
  const sessions = await seedColdStorageFixture({
    stateDir,
    workspaceDir: process.env.OPENCLAW_TEST_WORKSPACE_DIR,
  });
  const config = {
    gateway: {
      mode: "local",
      bind: "loopback",
      auth: { mode: "token", token: context.token },
      controlUi: { enabled: false },
    },
    agents: {
      defaults: {
        workspace: process.env.OPENCLAW_TEST_WORKSPACE_DIR,
        skipBootstrap: true,
        heartbeat: { every: "0m" },
      },
    },
    plugins: { enabled: false },
    session: {
      maintenance: {
        mode: "warn",
        pruneAfter: "3650d",
        archiveDashboardAfter: false,
        maxDiskBytes: false,
        coldStorage: { enabled: true, afterDays: 30 },
      },
    },
  };
  await fs.writeFile(process.env.OPENCLAW_CONFIG_PATH, JSON.stringify(config));
  await runCli(context, ["doctor", "--fix", "--yes", "--force"]);
  for (const session of sessions) {
    session.rows = readTranscriptRows(stateDir, session.sessionId);
    assert.equal(session.rows.length, 3, "Doctor must import all fixture events");
  }
  assert.deepEqual(readColdArchives(stateDir), []);
  await fs.writeFile(fixturePath, JSON.stringify(sessions));
} else {
  const sessions = JSON.parse(await fs.readFile(fixturePath, "utf8"));
  const [old, middle, recent] = sessions;
  if (phase === "exercise") {
    const archives = await waitForArchives(context, [old.sessionId]);
    assert.deepEqual(
      readTranscriptRows(stateDir, old.sessionId),
      [],
      "archival must remove hot event rows",
    );
    for (const session of [middle, recent]) {
      assert.deepEqual(
        readTranscriptRows(stateDir, session.sessionId),
        session.rows,
        "30-day cutoff archived recent history",
      );
    }
    assert.equal(archives[0].storage, "file");
    assert.match(archives[0].archive_name, /^[a-f0-9]{64}\.jsonl\.zst$/);
    await patchPolicy({ afterDays: 7 });
    await waitForArchives(context, [old.sessionId, middle.sessionId]);
    assert.deepEqual(readTranscriptRows(stateDir, middle.sessionId), []);
    assert.deepEqual(readTranscriptRows(stateDir, recent.sessionId), recent.rows);
    await patchPolicy({ enabled: false });

    const archivePath = path.join(
      stateDir,
      "agents",
      "main",
      "sessions",
      "cold",
      archives[0].archive_name,
    );
    const hiddenPath = `${archivePath}.test-missing`;
    const beforeMissing = readColdArchives(stateDir);
    await fs.rename(archivePath, hiddenPath);
    try {
      await assert.rejects(
        gatewayCall(context, "chat.history", { sessionKey: old.sessionKey, limit: 100 }),
        /missing or unreadable/,
      );
      await assert.rejects(
        runCli(context, [
          "backup",
          "sqlite",
          "create",
          "--agent",
          "main",
          "--repository",
          path.join(proofDir, "missing-backup"),
          "--json",
        ]),
        /missing or unreadable/,
      );
      assert.deepEqual(
        readColdArchives(stateDir),
        beforeMissing,
        "missing file must retain its recovery reference",
      );
      assert.deepEqual(readTranscriptRows(stateDir, old.sessionId), []);
    } finally {
      await fs.rename(hiddenPath, archivePath);
    }
    const backup = JSON.parse(
      await runCli(context, [
        "backup",
        "sqlite",
        "create",
        "--agent",
        "main",
        "--repository",
        path.join(proofDir, "backups"),
        "--json",
      ]),
    );
    assert.equal(backup.ok, true);
    const recoveredState = path.join(proofDir, "recovered");
    const target = databasePath(recoveredState);
    await fs.mkdir(path.dirname(target), { recursive: true });
    const restored = JSON.parse(
      await runCli(context, [
        "backup",
        "sqlite",
        "restore",
        backup.snapshotPath,
        "--target",
        target,
        "--json",
      ]),
    );
    assert.equal(restored.ok, true);
    assert(
      readColdArchives(recoveredState).every((row) => row.storage === "sqlite"),
      "backup must embed cold payloads",
    );
    await fs.copyFile(process.env.OPENCLAW_CONFIG_PATH, path.join(recoveredState, "openclaw.json"));
    await assertHistory(old);
    assert.deepEqual(
      readColdArchives(stateDir).map((row) => row.session_id),
      [middle.sessionId],
    );
    console.log(
      "Automatic 30/7-day archival, hot reload, missing-file refusal, portable backup and exact history restoration passed",
    );
  } else if (phase === "restart" || phase === "recovered") {
    const config = await gatewayCall(context, "config.get", {});
    assert.equal(config.config.session.maintenance.coldStorage.enabled, false);
    assert.equal(config.config.session.maintenance.coldStorage.afterDays, 7);
    if (phase === "recovered") {
      await assert.rejects(fs.stat(path.join(stateDir, "agents", "main", "sessions", "cold")), {
        code: "ENOENT",
      });
      assert.equal(readColdArchives(stateDir).length, 2);
    } else {
      assert.equal(readColdArchives(stateDir).length, 1);
    }
    const archivesBeforeListing = readColdArchives(stateDir);
    const listingParams = {
      agentId: "main",
      archived: "all",
      limit: 100,
      includeDerivedTitles: true,
      includeLastMessage: true,
    };
    const listing = await gatewayCall(context, "sessions.list", listingParams);
    for (const session of sessions) {
      const listed = listing.sessions.find((row) => row.key === session.sessionKey);
      assert.equal(
        listed?.sessionId,
        session.sessionId,
        "Activity must list cold histories after restart",
      );
      assert.equal(listed?.label, session.label);
    }
    assert.deepEqual(
      readColdArchives(stateDir),
      archivesBeforeListing,
      "listing must leave cold payloads archived",
    );
    for (const archive of archivesBeforeListing) {
      assert.deepEqual(readTranscriptRows(stateDir, archive.session_id), []);
    }
    for (const session of sessions) {
      await assertHistory(session);
    }
    assert.deepEqual(readColdArchives(stateDir), []);
    const restoredListing = await gatewayCall(context, "sessions.list", listingParams);
    for (const session of sessions) {
      assert.equal(
        restoredListing.sessions.find((row) => row.key === session.sessionKey)?.lastMessagePreview,
        "I will remember it.",
        "Activity must refresh omitted previews after restoration",
      );
    }
    console.log(`${phase}: all transcript bytes survived, with cold storage disabled`);
  } else {
    throw new Error(`Unknown phase: ${phase}`);
  }
}
