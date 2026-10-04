import fs from "node:fs/promises";
import path from "node:path";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it } from "vitest";
import {
  deleteCheckpointProvenance,
  readCheckpointProvenance,
  writeCheckpointProvenance,
} from "./lobster-checkpoint-provenance.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
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
