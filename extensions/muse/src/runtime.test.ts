import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { awaitGateBeforeSettlement, withinTest } from "openclaw/plugin-sdk/test-fixtures";
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
  it.runIf(process.platform !== "win32")(
    "keeps shared initialization alive for another caller",
    async ({ signal }) => {
      const pool = new MusePool(fixture);
      await using server = createServer();
      const gatePath = join(workspace, "shared.sock");
      await once(server.listen(gatePath), "listening");
      const connected = once(server, "connection");
      vi.stubEnv("MUSE_FIXTURE_INITIALIZE_GATE", gatePath);
      const firstController = new AbortController();
      const secondController = new AbortController();
      const joined = Promise.withResolvers<void>();
      const listen = secondController.signal.addEventListener.bind(secondController.signal);
      const registration = vi
        .spyOn(secondController.signal, "addEventListener")
        .mockImplementation((...args) => {
          listen(...args);
          // Observe cancellation registration, without replacing the real signal or pool.
          if (args[0] === "abort") {
            joined.resolve();
          }
        });
      const first = pool.acquire(workspace, undefined, false, firstController.signal);
      const firstOutcome = first.then(
        (lease) => ({ lease }),
        (error: unknown) => ({ error }),
      );
      let second: ReturnType<MusePool["acquire"]> | undefined;
      let socket: Socket | undefined;
      try {
        socket = (
          await withinTest(
            awaitGateBeforeSettlement(connected, first, "Muse did not reach initialize"),
            signal,
          )
        )[0];
        const [pid] = await withinTest(once(socket!, "data"), signal);
        second = pool.acquire(workspace, undefined, false, secondController.signal);
        // Handle an early rejection while retaining the original result for assertions.
        void second.catch(() => {});
        await withinTest(
          awaitGateBeforeSettlement(joined.promise, second, "Second caller did not join startup"),
          signal,
        );
        firstController.abort(new Error("first caller cancelled"));
        expect(await withinTest(firstOutcome, signal)).toHaveProperty("error");
        expect(() => process.kill(Number(pid), 0)).not.toThrow();
        socket!.write("resume");
        const surviving = await withinTest(second, signal);
        expect(await surviving.runtime.host.connection.request("model/list", {})).toMatchObject({
          providerId: "meta",
        });
        surviving.release();
      } finally {
        registration.mockRestore();
        socket?.write("resume");
        await Promise.allSettled([first, ...(second ? [second] : [])]);
        socket?.destroy();
        await pool.dispose();
      }
    },
  );

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
