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

describe("lobster checkpoint provenance", () => {
  it("finds a record by either the resume token or the approval id", async () => {
    const env = { LOBSTER_STATE_DIR: tempDirs.make("openclaw-lobster-provenance-") };
    await writeCheckpointProvenance(env, { token: "tok", approvalId: "abc" }, record);
    await expect(readCheckpointProvenance(env, { token: " tok " })).resolves.toEqual(record);
    await expect(readCheckpointProvenance(env, { approvalId: "abc" })).resolves.toEqual(record);
    await expect(readCheckpointProvenance(env, { token: "other" })).resolves.toBeUndefined();
    await deleteCheckpointProvenance(env, { token: "tok", approvalId: "abc" });
    await expect(readCheckpointProvenance(env, { approvalId: "abc" })).resolves.toBeUndefined();
  });

  it("keeps the record beside Lobster's checkpoint state, private to the owner", async () => {
    const stateDir = tempDirs.make("openclaw-lobster-provenance-");
    await writeCheckpointProvenance({ LOBSTER_STATE_DIR: stateDir }, { token: "tok" }, record);
    const dir = path.join(stateDir, "openclaw-llm-checkpoints");
    const [file] = await fs.readdir(dir);
    expect(file).toMatch(/^[0-9a-f]{64}\.json$/);
    expect((await fs.stat(path.join(dir, file ?? ""))).mode & 0o777).toBe(0o600);
  });

  it("fails closed on a record it cannot trust", async () => {
    const stateDir = tempDirs.make("openclaw-lobster-provenance-");
    const env = { LOBSTER_STATE_DIR: stateDir };
    await writeCheckpointProvenance(env, { token: "tok" }, record);
    const dir = path.join(stateDir, "openclaw-llm-checkpoints");
    const [file] = await fs.readdir(dir);
    await fs.writeFile(path.join(dir, file ?? ""), JSON.stringify({ version: 1, stages: "x" }));
    await expect(readCheckpointProvenance(env, { token: "tok" })).rejects.toThrow("malformed");
    await fs.writeFile(path.join(dir, file ?? ""), "{");
    await expect(readCheckpointProvenance(env, { token: "tok" })).rejects.toThrow("unreadable");
  });
});
