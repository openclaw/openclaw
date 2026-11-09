import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
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

// The fake holds its initialize reply until this socket answers; it never does.
// `waiting` settles once the fake has received initialize, so the startup timer exists.
async function holdInitialize() {
  const gate = join(await mkdtemp(join(workspace, "muse-gate-")), "init.sock");
  const server = createServer(() => {});
  await new Promise<void>((resolve) => {
    server.listen(gate, resolve);
  });
  const waiting = new Promise<void>((resolve) => {
    server.once("connection", () => resolve());
  });
  vi.stubEnv("MUSE_FIXTURE_INITIALIZE_GATE", gate);
  return { server, waiting };
}

describe("Muse process pool", () => {
  it("reports a caller's cancelled start as that cancellation, not a missing install", async () => {
    const { server, waiting } = await holdInitialize();
    const pool = new MusePool(fixture);
    const controller = new AbortController();
    try {
      const start = expect(
        pool.acquire(workspace, undefined, false, controller.signal),
      ).rejects.toThrow("catalog deadline passed");
      await waiting;
      controller.abort(new Error("catalog deadline passed"));
      await start;
    } finally {
      await pool.dispose();
      server.close();
    }
  });
  it("reports a slow Muse start as a startup timeout, not a missing install", async () => {
    const { server, waiting } = await holdInitialize();
    const pool = new MusePool(fixture);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      const start = expect(pool.acquire(workspace, undefined, false)).rejects.toThrow(
        /did not finish starting within 120s/,
      );
      await waiting;
      // Past the startup limit and the 1s shutdown grace that closing the host waits on.
      await vi.advanceTimersByTimeAsync(125_000);
      await start;
    } finally {
      vi.useRealTimers();
      await pool.dispose();
      server.close();
    }
  });
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
        const lines = (await readFile(log, "utf8")).trim().split("\n");
        const requests = lines.map((line) => JSON.parse(line));
        const initialize = requests.find((request) => request.method === "initialize");
        expect(initialize.params.capabilities).toEqual({ userInputDialogs: false });
        const spawns = requests.filter((request) => request.event === "spawn");
        expect(spawns).toHaveLength(3);
        expect(spawns[0].credentialBackend).toBeUndefined();
        expect(spawns[2]).toMatchObject({
          credentialBackend: "file",
          configHome: join(stateDir, "muse"),
        });
      } finally {
        await pool.dispose();
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
