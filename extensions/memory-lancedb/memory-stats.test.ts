import fs from "node:fs/promises";
import { registerHooks } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { isPidAlive, runUtf8CommandWithTimeout } from "openclaw/plugin-sdk/process-runtime";
import { afterAll, afterEach, assert, expect, it, vi } from "vitest";
import { createMemoryCliHarness } from "./memory-cli.test-support.js";
import { readMemoryStats } from "./memory-stats.js";
import { installTmpDirHarness } from "./test-helpers.js";

const { getDbPath, getTmpDir } = installTmpDirHarness({ prefix: "openclaw-memory-stats-" });

// Source children do not inherit the host's plugin SDK resolver.
const fileLockUrl = new URL("../../src/plugin-sdk/file-lock.ts", import.meta.url).href;
const sdkHook = registerHooks({
  resolve(specifier, context, nextResolve) {
    return specifier === "openclaw/plugin-sdk/file-lock"
      ? { shortCircuit: true, url: fileLockUrl }
      : nextResolve(specifier, context);
  },
});
afterAll(() => sdkHook.deregister());

const readStats = (dbPath: string) => readMemoryStats({ dbPath }, "main");
const transport = vi.hoisted(() => ({
  tsconfigPath: undefined as string | undefined,
  onOutput: undefined as ((chunk: Buffer) => void) | undefined,
  controller: new AbortController(),
  pending: new Set<Promise<unknown>>(),
}));

vi.mock("openclaw/plugin-sdk/process-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/process-runtime")>();
  return {
    ...actual,
    runUtf8CommandWithTimeout: vi.fn<typeof actual.runUtf8CommandWithTimeout>((argv, options) => {
      assert(typeof options !== "number", "Expected the stats reader's process options");
      const script = `
        import { runMemoryStatsReader } from ${JSON.stringify(new URL("./memory-stats-reader.ts", import.meta.url).href)};
        const { loadLanceDbModule } = await import(${JSON.stringify(fixtureModuleUrl)});
        await runMemoryStatsReader(loadLanceDbModule);
      `;
      const entryIndex = argv.findIndex((argument) => argument.endsWith("memory-stats.worker.ts"));
      assert(entryIndex > 0, "Expected the declared memory stats worker entry");
      const pending = actual.runUtf8CommandWithTimeout(
        [...argv.slice(0, entryIndex), "--input-type=module", "--eval", script],
        {
          ...options,
          env: { ...process.env, ...options.env, TSX_TSCONFIG_PATH: transport.tsconfigPath },
          onOutputChunk: (chunk) => transport.onOutput?.(chunk),
          signal: transport.controller.signal,
        },
      );
      transport.pending.add(pending);
      void pending.finally(() => transport.pending.delete(pending)).catch(() => {});
      return pending;
    }),
  };
});

// Only the native dependency is fake; the stats command and child lifecycle remain real.
const fixtureModuleUrl = `data:text/javascript,${encodeURIComponent(`
import { readdirSync, readFileSync, writeSync } from "node:fs";
import { join } from "node:path";
function hold() {
  writeSync(2, "ready:" + process.pid + "\\n");
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
}
export async function connect(dbPath, options) {
  const local = !dbPath.startsWith("fixture:");
  const mode = local ? "populated" : new URL(dbPath).hostname;
  function assertChildLease() {
    if (!local) return;
    const directory = join(dbPath, ".openclaw-custody");
    const leases = readdirSync(directory).filter((name) => name.startsWith("use-"));
    if (leases.length !== 1) throw new Error("missing child lease");
    const lease = JSON.parse(readFileSync(join(directory, leases[0]), "utf8"));
    if (lease.pid !== process.pid) throw new Error("lease is not child-owned");
  }
  if (mode === "connect") hold();
  return {
    tableNames: async () => mode === "empty" ? [] : ["memories"],
    openTable: async () => ({
      schema: async () => ({ fields: mode === "legacy" ? [] : [{ name: "agentId" }] }),
      countRows: async (predicate) => {
        assertChildLease();
        if (mode === "count") hold();
        if (mode === "failed") throw new Error("fixture database unavailable");
        if (mode === "legacy") throw new Error("unknown column agentId");
        if (predicate !== "agentId = 'main''s'") throw new Error("incorrect agent scope");
        if (options.storageOptions?.fixture !== "stdin-only") throw new Error("missing storage options");
        return 7;
      },
      close: assertChildLease,
    }),
    close: assertChildLease,
  };
}
export async function loadLanceDbModule() { return { connect }; }
`)}`;

afterEach(async () => {
  transport.tsconfigPath = undefined;
  transport.controller.abort();
  await Promise.allSettled(transport.pending);
  transport.controller = new AbortController();
  transport.onOutput = undefined;
  vi.restoreAllMocks();
});

it("stats preserves agent scope and child-owned custody", async () => {
  transport.tsconfigPath = path.join(getTmpDir(), "tsconfig.json");
  const configUrl = new URL("../../tsconfig.json", import.meta.url);
  const { compilerOptions }: { compilerOptions: { paths: Record<string, string[]> } } = JSON.parse(
    await fs.readFile(configUrl, "utf8"),
  );
  delete compilerOptions.paths["openclaw/plugin-sdk/*"];
  for (const [specifier, targets] of Object.entries(compilerOptions.paths)) {
    compilerOptions.paths[specifier] = targets.map((target) =>
      fileURLToPath(new URL(target, configUrl)),
    );
  }
  await fs.writeFile(transport.tsconfigPath, JSON.stringify({ compilerOptions }));
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const { run, embed } = createMemoryCliHarness({
    statsSource: { dbPath: getDbPath(), storageOptions: { fixture: "stdin-only" } },
  });
  await run("stats", "--agent", "main's");

  expect(log).toHaveBeenCalledWith("Total memories: 7");
  expect(embed).not.toHaveBeenCalled();
  await expect(fs.readdir(path.join(getDbPath(), ".openclaw-custody"))).resolves.toEqual([]);
});

it("reports an empty database without creating a table", async () => {
  await expect(readStats("fixture://empty")).resolves.toBe(0);
});

it.each([
  ["fixture://legacy", "openclaw doctor --fix"],
  ["fixture://failed", "fixture database unavailable"],
])("preserves the %s database diagnostic", async (dbPath, message) => {
  await expect(readStats(dbPath)).rejects.toThrow(message);
});

it.each(["fixture://connect", "fixture://count"])("kills %s on timeout", async (dbPath) => {
  const timers = vi.spyOn(globalThis, "setTimeout");
  const ready = createDeferred<number>();
  let output = "";
  transport.onOutput = (chunk) => {
    output += chunk.toString();
    const match = /ready:(\d+)\n/.exec(output);
    if (match) {
      ready.resolve(Number(match[1]));
    }
  };
  const rejected = expect(readStats(dbPath)).rejects.toThrow(
    "statistics timed out after 60 seconds",
  );
  const pid = await ready.promise;
  expect(isPidAlive(pid)).toBe(true);

  const deadline = timers.mock.calls.find(([, delay]) => delay === 60_000);
  // Advance only the command deadline. OS teardown still uses its real exit events.
  const [fire, , ...args] = deadline!;
  fire(...args);
  await rejected;
  expect(isPidAlive(pid)).toBe(false);
});

it("does not claim cancellation succeeded when process cleanup is uncertain", async () => {
  vi.mocked(runUtf8CommandWithTimeout).mockResolvedValueOnce({
    stdout: "",
    stderr: "",
    code: null,
    signal: null,
    killed: true,
    termination: "timeout",
    cleanup: "uncertain",
  });
  await expect(readStats("fixture://unavailable")).rejects.toThrow(
    "process cleanup could not be confirmed",
  );
});
