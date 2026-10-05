import fs from "node:fs/promises";
import path from "node:path";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it } from "vitest";
import {
  configureCheckpointProvenanceStore,
  deleteCheckpointProvenance,
  readCheckpointProvenance,
  writeCheckpointProvenance,
  type LobsterCheckpointProvenance,
} from "./lobster-checkpoint-provenance.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => configureCheckpointProvenanceStore(undefined));
const record = {
  version: 1 as const,
  stages: [{ provider: "embedded", command: "llm.invoke" }],
  caller: { agentId: "main", authority: ["operator.write"] },
};

// A real Lobster resume token: base64url JSON that decodes to a checkpoint
// stateKey. `spacing` changes only the JSON whitespace, so a nonzero value is a
// byte-different encoding of the same checkpoint.
function resumeToken(stateKey: string, spacing = 0): string {
  return Buffer.from(
    JSON.stringify({ protocolVersion: 1, v: 1, kind: "pipeline-resume", stateKey }, null, spacing),
    "utf8",
  ).toString("base64url");
}

describe("lobster checkpoint provenance", () => {
  it("finds a record by the decoded token identity and by the approval id", async () => {
    const env = { LOBSTER_STATE_DIR: tempDirs.make("openclaw-lobster-provenance-") };
    const token = resumeToken("pipeline_resume_a");
    await writeCheckpointProvenance(env, { token, approvalId: "abc" }, record);
    await expect(readCheckpointProvenance(env, { token: ` ${token} ` })).resolves.toEqual(record);
    await expect(readCheckpointProvenance(env, { approvalId: "abc" })).resolves.toEqual(record);
    await expect(
      readCheckpointProvenance(env, { token: resumeToken("pipeline_resume_b") }),
    ).resolves.toBeUndefined();
    await deleteCheckpointProvenance(env, { token, approvalId: "abc" });
    await expect(readCheckpointProvenance(env, { approvalId: "abc" })).resolves.toBeUndefined();
  });

  it("resolves an equivalent token encoding to the same record", async () => {
    const env = { LOBSTER_STATE_DIR: tempDirs.make("openclaw-lobster-provenance-") };
    await writeCheckpointProvenance(env, { token: resumeToken("pipeline_resume_a") }, record);
    // Different JSON whitespace: a different token string for the same decoded checkpoint.
    await expect(
      readCheckpointProvenance(env, { token: resumeToken("pipeline_resume_a", 1) }),
    ).resolves.toEqual(record);
  });

  it("resolves storage-equivalent state keys to one record", async () => {
    const env = { LOBSTER_STATE_DIR: tempDirs.make("openclaw-lobster-provenance-") };
    const canonical = "workflow_resume_8b3e4658-fec5-47ff-ba14-008d690d7f65";
    await writeCheckpointProvenance(env, { token: resumeToken(canonical) }, record);
    // A case-mutated key selects the same Lobster state file (keyToPath lowercases).
    const caseMutated = "Workflow_Resume_8B3E4658-FEC5-47FF-BA14-008D690D7F65";
    await expect(
      readCheckpointProvenance(env, { token: resumeToken(caseMutated) }),
    ).resolves.toEqual(record);
    // Lobster's alternate workflow-resume spelling reaches the same checkpoint.
    const alternate = "workflow-resume_8b3e4658-fec5-47ff-ba14-008d690d7f65";
    await expect(readCheckpointProvenance(env, { token: resumeToken(alternate) })).resolves.toEqual(
      record,
    );
    // A different identity still selects a different, missing record.
    await expect(
      readCheckpointProvenance(env, {
        token: resumeToken("workflow_resume_00000000-0000-0000-0000-000000000000"),
      }),
    ).resolves.toBeUndefined();
  });

  it("stores records through the configured keyed store and falls back to a legacy sidecar", async () => {
    const env = { LOBSTER_STATE_DIR: tempDirs.make("openclaw-lobster-provenance-") };
    const token = resumeToken("pipeline_resume_store");
    // A pre-upgrade sidecar stays readable once the store is bound.
    await writeCheckpointProvenance(env, { token }, record);
    const entries = new Map<string, LobsterCheckpointProvenance>();
    configureCheckpointProvenanceStore({
      register: async (key, value) => {
        entries.set(key, value);
      },
      lookup: async (key) => entries.get(key),
      delete: async (key) => entries.delete(key),
    });
    await expect(readCheckpointProvenance(env, { token })).resolves.toEqual(record);
    const stored = { ...record, stages: [] };
    await writeCheckpointProvenance(env, { token }, stored);
    expect(entries.size).toBe(1);
    await expect(readCheckpointProvenance(env, { token })).resolves.toEqual(stored);
    await deleteCheckpointProvenance(env, { token });
    expect(entries.size).toBe(0);
    // The legacy sidecar is cleared with the store record, so nothing lingers.
    await expect(readCheckpointProvenance(env, { token })).resolves.toBeUndefined();
  });

  it("keeps the record beside Lobster's checkpoint state, private to the owner", async () => {
    const stateDir = tempDirs.make("openclaw-lobster-provenance-");
    await writeCheckpointProvenance(
      { LOBSTER_STATE_DIR: stateDir },
      { token: resumeToken("pipeline_resume_a") },
      record,
    );
    const dir = path.join(stateDir, "openclaw-llm-checkpoints");
    const [file] = await fs.readdir(dir);
    expect(file).toMatch(/^[0-9a-f]{64}\.json$/);
    expect((await fs.stat(path.join(dir, file ?? ""))).mode & 0o777).toBe(0o600);
  });

  it("fails closed on a record it cannot trust", async () => {
    const stateDir = tempDirs.make("openclaw-lobster-provenance-");
    const env = { LOBSTER_STATE_DIR: stateDir };
    await writeCheckpointProvenance(env, { token: resumeToken("pipeline_resume_a") }, record);
    const dir = path.join(stateDir, "openclaw-llm-checkpoints");
    const [file] = await fs.readdir(dir);
    await fs.writeFile(path.join(dir, file ?? ""), JSON.stringify({ version: 1, stages: "x" }));
    await expect(
      readCheckpointProvenance(env, { token: resumeToken("pipeline_resume_a") }),
    ).rejects.toThrow("malformed");
    await fs.writeFile(path.join(dir, file ?? ""), "{");
    await expect(
      readCheckpointProvenance(env, { token: resumeToken("pipeline_resume_a") }),
    ).rejects.toThrow("unreadable");
  });
});
