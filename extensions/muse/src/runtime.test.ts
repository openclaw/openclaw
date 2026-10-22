import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MusePool } from "./runtime.js";

let workspace: string;
const fixture = fileURLToPath(new URL("./test-support/fake-muse.mjs", import.meta.url));
beforeAll(async () => {
  workspace = await mkdtemp(join(tmpdir(), "muse-pool-test-"));
});
beforeEach(() => {
  vi.stubEnv("OPENCLAW_STATE_DIR", join(workspace, "state"));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});
afterAll(async () => {
  await rm(workspace, { recursive: true, force: true });
});

describe("Muse process pool", () => {
  it.each([undefined, "key-a"])(
    "retires a warm process when managed auth changes with API key %s",
    async (apiKey) => {
      const stateDir = await mkdtemp(join(workspace, "pool-auth-"));
      const authDir = join(stateDir, "muse", "muse");
      const log = join(stateDir, "requests.jsonl");
      vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
      vi.stubEnv("META_API_KEY", undefined);
      vi.stubEnv("TBH_CREDENTIAL_BACKEND", undefined);
      vi.stubEnv("XDG_CONFIG_HOME", undefined);
      vi.stubEnv("MUSE_REQUEST_LOG", log);
      const pool = new MusePool(fixture);
      try {
        const native = await pool.acquire(workspace, apiKey, false);
        native.release();
        const unrelated = await pool.acquire(workspace, "key-b", false);
        unrelated.release();
        await mkdir(authDir, { recursive: true });
        await writeFile(join(authDir, "auth.json"), '{"account":"managed"}');
        const managed = await pool.acquire(workspace, apiKey, false);
        managed.release();
        expect(managed.runtime).not.toBe(native.runtime);
        await native.runtime.host.exited;
        expect(native.runtime.closing).toBe(true);
        expect(unrelated.runtime.closing).toBe(false);
        const same = await pool.acquire(workspace, apiKey, false);
        same.release();
        expect(same.runtime).toBe(managed.runtime);
        const spawns = (await readFile(log, "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line))
          .filter((request) => request.event === "spawn");
        expect(spawns).toHaveLength(3);
        expect(spawns[0].credentialBackend).toBeUndefined();
        expect(spawns[2]).toMatchObject({
          credentialBackend: "file",
          configHome: join(stateDir, "muse"),
        });
      } finally {
        await pool.dispose();
        vi.unstubAllEnvs();
      }
    },
  );
  it("isolates pooled credentials, reuses matching hosts, and closes idle hosts", async () => {
    const pool = new MusePool(fixture);
    try {
      const first = await pool.acquire(workspace, "key-a", false);
      const same = await pool.acquire(workspace, "key-a", false);
      const other = await pool.acquire(workspace, "key-b", false);
      expect(same.runtime).toBe(first.runtime);
      expect(other.runtime).not.toBe(first.runtime);
      vi.useFakeTimers();
      first.release();
      same.release();
      other.release();
      await vi.advanceTimersByTimeAsync(300_000);
      vi.useRealTimers();
      await first.runtime.host.exited;
      expect(first.runtime.closing).toBe(true);
      await other.runtime.host.exited;
    } finally {
      vi.useRealTimers();
      await pool.dispose();
    }
  });
});
