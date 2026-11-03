import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const stage = process.argv[2];
assert(["seed", "upgraded", "first", "second"].includes(stage));
const state = process.env.OPENCLAW_STATE_DIR;
const runtime = process.env.OPENCLAW_UPGRADE_SURVIVOR_RUNTIME_ROOT;
const artifacts = process.env.OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT;
const configPath = process.env.OPENCLAW_CONFIG_PATH;
assert(state && runtime && artifacts && configPath, "Missing isolated survivor paths");
assert(path.resolve(state).startsWith(`${path.resolve(runtime)}/`));
assert(path.resolve(configPath).startsWith(`${path.resolve(state)}/`));
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const policy = { roles: null, identityScopes: null };
const owners = ["discord:upgrade-survivor-owner"];
const db = new DatabaseSync(path.join(state, "state", "openclaw.sqlite"), {
  readOnly: stage !== "seed",
});
try {
  if (stage === "seed") {
    const config = readJson(configPath);
    config.commands = { ...config.commands, ownerAllowFrom: owners };
    config.gateway = {
      ...config.gateway,
      mode: "local",
      bind: "loopback",
      auth: { mode: "token", token: "upgrade-survivor-token" },
    };
    fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
    // The published driver owns this schema. Supply an existing policy specimen
    // in its generic machine-state table; never create a candidate database here.
    db.prepare(
      "INSERT INTO config_machine_state (state_key, value_json, updated_at_ms) VALUES (?, ?, ?)",
    ).run("operator.channelPolicy", JSON.stringify(policy), 1710000000000);
  }
  assert.equal(db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
  const userVersion = db.prepare("PRAGMA user_version").get().user_version;
  const applied = db
    .prepare(
      "SELECT value_json FROM config_machine_state WHERE state_key = 'state.schema.contentVersion'",
    )
    .get();
  const contentVersion = Math.max(userVersion, applied ? JSON.parse(applied.value_json) : 0);
  const row = db
    .prepare(
      "SELECT value_json FROM config_machine_state WHERE state_key = 'operator.channelPolicy'",
    )
    .get();
  assert(row, "Existing operator.channelPolicy disappeared");
  const value = JSON.parse(row.value_json);
  const { configuredOwnerPolicy, ...retained } = value;
  assert.deepEqual(retained, policy, "Upgrade changed the existing role/identity policy");
  if (stage === "seed") {
    assert.equal(configuredOwnerPolicy, undefined);
  } else {
    assert.equal(contentVersion, 19, "Updater did not apply candidate state schema");
    assert.deepEqual(readJson(configPath).commands.ownerAllowFrom, owners);
    if (stage !== "upgraded") {
      assert.match(
        configuredOwnerPolicy?.id ?? "",
        /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u,
      );
      assert.deepEqual(configuredOwnerPolicy, {
        id: configuredOwnerPolicy.id,
        fingerprint: createHash("sha256").update(JSON.stringify(owners)).digest("base64url"),
      });
      if (stage === "second") {
        assert.deepEqual(value, readJson(path.join(artifacts, "channel-policy-first.json")).value);
      }
    }
  }
  fs.writeFileSync(
    path.join(artifacts, `channel-policy-${stage}.json`),
    `${JSON.stringify(
      {
        userVersion,
        contentVersion,
        value,
      },
      null,
      2,
    )}\n`,
    { flag: "wx" },
  );
} finally {
  db.close();
}
