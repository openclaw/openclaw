import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { createTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { readSqliteReaderDiagnosticsForPath } from "../../infra/sqlite-reader-lifecycle.js";
import {
  registerOpenClawAgentDatabase,
  unregisterOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db-registry.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../../state/openclaw-state-db.js";
import {
  listCandidateAuthProfileStores as discover,
  loadCandidateAuthProfileStoreAsync as load,
  updateCandidateAuthProfileStore as update,
  type CandidateAuthProfileStore as Candidate,
} from "./candidate-stores.js";
import {
  createApiKeyCredential,
  createOAuthRefreshCredential,
} from "./credential-fixtures.test-support.js";
import { closeAuthProfileReadPool } from "./sqlite.js";
import type { AuthProfileCredential as Credential } from "./types.js";

const tempDirs = createTempDirTracker();
const registrations: Parameters<typeof registerOpenClawAgentDatabase>[0][] = [];
const profileId = "fixture:manual";
afterEach(async () => {
  for (const root of tempDirs.dirs) {
    closeAuthProfileReadPool({ kind: "root", rootPath: root });
  }
  registrations.splice(0).forEach(unregisterOpenClawAgentDatabase);
  await closeOpenClawAgentDatabasesAsync();
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  tempDirs.cleanup();
});

async function freshCandidate(root = fs.realpathSync(tempDirs.make("openclaw-auth-candidates-"))) {
  const agentDir = path.join(root, "agents", "probe", "agent");
  const candidates = await discover({
    cfg: { agents: { entries: { probe: { agentDir } } } },
    env: { OPENCLAW_STATE_DIR: root },
  });
  const candidate = candidates.find((entry) => entry.agentId === "probe");
  if (!candidate) {
    throw new Error("Missing configured probe candidate");
  }
  return { root, candidate };
}
const open = ({ agentId, databasePath, env }: Candidate) =>
  openOpenClawAgentDatabase({ agentId, path: databasePath, env });
const write = (candidate: Candidate, id: string, credential: Credential) =>
  update({
    candidate,
    profileId: id,
    updater(store) {
      store.profiles[id] = credential;
      return true;
    },
  });

it.each(["async", "async-pending", "update"] as const)(
  "adopts a database created after discovery by an unrelated creator (%s)",
  async (firstCheck) => {
    const { candidate } = await freshCandidate();
    const credential = createApiKeyCredential("fixture", "synthetic-key");
    expect(fs.existsSync(candidate.databasePath)).toBe(false);
    const pending = firstCheck === "async-pending" ? load(candidate) : undefined;
    open(candidate);
    if (pending) {
      expect(await pending).toBeNull();
    }
    await closeOpenClawAgentDatabasesAsync();
    if (firstCheck === "async") {
      expect(await load(candidate)).toBeNull();
    }
    await write(candidate, profileId, credential);
    expect((await load(candidate))?.profiles[profileId]).toEqual(credential);
  },
);

// Windows cannot replace a database while its native owner has it open.
it.skipIf(process.platform === "win32").each(["adopted", "existing"] as const)(
  "rejects replacement of a known file (%s)",
  async (state) => {
    const { root, candidate: missing } = await freshCandidate();
    let candidate = missing;
    const retained = `${candidate.databasePath}.retained`;
    try {
      open(candidate);
      await closeOpenClawAgentDatabasesAsync();
      if (state === "existing") {
        candidate = (await freshCandidate(root)).candidate;
      } else {
        expect(await load(candidate)).toBeNull();
      }
      closeAuthProfileReadPool({ kind: "root", rootPath: root });
      fs.renameSync(candidate.databasePath, retained);
      const replacement = `${candidate.databasePath}.replacement`;
      fs.writeFileSync(replacement, "foreign");
      fs.renameSync(replacement, candidate.databasePath);
      await expect(load(candidate)).rejects.toThrow(/identity changed/);
      const updater = vi.fn(() => true);
      await expect(update({ candidate, profileId, updater })).rejects.toThrow(/identity changed/);
      expect(updater).not.toHaveBeenCalled();
    } finally {
      if (fs.existsSync(retained)) {
        fs.renameSync(retained, candidate.databasePath);
      }
    }
  },
);

it("fails closed when the state-root agent inventory cannot be read", async () => {
  const error = Object.assign(new Error("permission denied"), { code: "EACCES" });
  vi.spyOn(fsPromises, "readdir").mockRejectedValueOnce(error);
  await expect(
    discover({ cfg: {}, env: { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-auth-denied-") } }),
  ).rejects.toBe(error);
});

it("dedupes configured, state-root, and registered custom database paths", async () => {
  const root = tempDirs.make("openclaw-auth-candidates-");
  const stateDir = path.join(root, "state");
  const configured = path.join(root, "configured-agent");
  const customPath = path.join(root, "custom", "credentials.sqlite");
  const env = { OPENCLAW_STATE_DIR: stateDir };
  for (const dir of [
    configured,
    path.join(stateDir, "agents", "state-agent", "agent"),
    path.dirname(customPath),
  ]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  registrations.push(
    { agentId: "configured", path: path.join(configured, "openclaw-agent.sqlite"), env },
    { agentId: "custom", path: customPath, env },
  );
  for (const registration of registrations) {
    registerOpenClawAgentDatabase(registration);
  }
  openOpenClawAgentDatabase({ agentId: "custom", path: customPath, env });
  const entries = {
    configured: { agentDir: configured },
    custom: { agentDir: path.join(root, "active-custom-agent") },
  };
  const candidates = await discover({ cfg: { agents: { entries } }, env });
  const ids = candidates.map(({ agentId }) => agentId);
  expect(ids).toEqual(["custom", "configured", "custom", "state-agent"]);
  const custom = candidates.find(({ databasePath }) => databasePath === customPath);
  expect(custom).toBeDefined();
  const credential = createOAuthRefreshCredential({
    access: "custom-access",
    refresh: "custom-refresh",
    expires: 1,
  });
  const sql = observeHostDataSql();
  try {
    await write(custom!, "openai:default", credential);
    expect(sql.queries.filter((query) => /auth_profile_(?:store|state)/i.test(query))).toEqual([]);
  } finally {
    sql.restore();
  }
  await closeOpenClawAgentDatabaseByPathAsync(customPath, "custom");
  expect((await load(custom!))?.profiles["openai:default"]).toMatchObject({
    access: "custom-access",
    refresh: "custom-refresh",
  });
  expect(readSqliteReaderDiagnosticsForPath(customPath).connections).toEqual([]);
});
