import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { readDatabase } from "./observations.mjs";

const enabled = () =>
  ["2026.9.33", "2026.9.34"].includes(process.env.OPENCLAW_UPGRADE_SURVIVOR_BASELINE_VERSION);
const stateDir = () => process.env.OPENCLAW_STATE_DIR;
const source = () => path.join(stateDir(), "agents/main/agent/openclaw-agent.sqlite");
const marker = () => path.join(stateDir(), "agents/main/agent/auth-state.json");
const evidence = () =>
  path.join(
    process.env.OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT,
    "legacy-operator-doctor-repairs.json",
  );

export function prepareLegacyOperatorAuth() {
  if (!enabled()) {
    return;
  }
  fs.rmSync(evidence(), { force: true });
  // Preserve the published CLI's legacy owner until it has authored real rows.
  fs.mkdirSync(path.dirname(marker()), { recursive: true });
  fs.writeFileSync(marker(), "{}\n", { mode: 0o600 });
}

export function seedLegacyOperatorAuth() {
  if (!enabled()) {
    return;
  }
  for (const [args, input] of [
    [
      [
        "models",
        "auth",
        "paste-token",
        "--provider",
        "synthetic",
        "--profile-id",
        "synthetic:survivor",
      ],
      "survivor-synthetic-token\n",
    ],
    [
      ["models", "auth", "order", "set", "--provider", "synthetic", "synthetic:survivor"],
      undefined,
    ],
  ]) {
    const result = spawnSync("openclaw", args, { encoding: "utf8", input });
    assert.equal(result.status, 0, `published auth seed failed: ${result.stderr}`);
  }
  fs.rmSync(marker());
}

function authRows(db) {
  return {
    store: db
      .prepare(
        "SELECT store_json AS value, updated_at FROM auth_profile_store WHERE store_key = 'primary'",
      )
      .get(),
    state: db
      .prepare(
        "SELECT state_json AS value, updated_at FROM auth_profile_state WHERE state_key = 'primary'",
      )
      .get(),
  };
}

export function seedLegacyOperatorDoctorRepairs() {
  if (!enabled()) {
    return;
  }
  const auth = readDatabase(source(), authRows);
  assert(
    JSON.parse(auth.store.value).profiles["synthetic:survivor"],
    "legacy auth profile missing",
  );
  assert(auth.state, "legacy auth state missing");
  const db = new DatabaseSync(source());
  try {
    const row = db
      .prepare("SELECT session_key, entry_json FROM session_nodes WHERE current_session_id = ?")
      .get("legacy-operator-baseline");
    assert(row, "published baseline turn did not create a session");
    const entry = JSON.parse(row.entry_json);
    for (const key of ["label", "displayName", "subject", "groupChannel", "space"]) {
      delete entry[key];
    }
    db.prepare("UPDATE session_nodes SET entry_json = ? WHERE session_key = ?").run(
      JSON.stringify(entry),
      row.session_key,
    );
    fs.writeFileSync(evidence(), JSON.stringify({ auth, sessionKey: row.session_key, entry }), {
      mode: 0o600,
    });
  } finally {
    db.close();
  }
}

export function assertLegacyOperatorDoctorRepairs() {
  if (!enabled()) {
    return;
  }
  const before = JSON.parse(fs.readFileSync(evidence(), "utf8"));
  readDatabase(source(), (db) => {
    assert.deepEqual(
      authRows(db),
      { store: undefined, state: undefined },
      "Doctor did not remove legacy auth rows",
    );
    const row = db
      .prepare("SELECT entry_json FROM session_nodes WHERE session_key = ?")
      .get(before.sessionKey);
    const entry = JSON.parse(row.entry_json);
    assert.equal(entry.displayName, "Reply with exactly OPENCLAW_E2E_LEGACY_OPERATOR_BASELINE.");
    delete entry.displayName;
    assert.deepEqual(entry, before.entry, "title repair changed other session metadata");
  });
  readDatabase(path.join(stateDir(), "state/openclaw.sqlite"), (db) => {
    for (const [kind, key] of [
      ["store", "authProfiles.store"],
      ["state", "authProfiles.state"],
    ]) {
      const row = db
        .prepare("SELECT value_json FROM config_machine_state WHERE state_key = ?")
        .get(key);
      assert.deepEqual(
        JSON.parse(row.value_json),
        JSON.parse(before.auth[kind].value),
        `relocated ${kind} changed`,
      );
    }
  });
  console.log(
    "Legacy shared-auth relocation and session-title repair verified before candidate CLI reads.",
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === "seed") {
    seedLegacyOperatorDoctorRepairs();
  }
  if (process.argv[2] === "assert") {
    assertLegacyOperatorDoctorRepairs();
  }
}
