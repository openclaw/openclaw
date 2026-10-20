import { Command } from "commander";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { isPidAlive, runUtf8CommandWithTimeout } from "openclaw/plugin-sdk/process-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MemoryDB } from "./lancedb-store.js";
import { registerMemoryCli } from "./memory-cli.js";
import { readMemoryStats } from "./memory-stats.js";

const transport = vi.hoisted(() => ({
  moduleUrl: "",
  onOutput: undefined as ((chunk: Buffer) => void) | undefined,
  controller: new AbortController(),
  pending: new Set<Promise<unknown>>(),
}));

vi.mock("openclaw/plugin-sdk/process-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/process-runtime")>();
  return {
    ...actual,
    runUtf8CommandWithTimeout: vi.fn(
      (argv: string[], options: Parameters<typeof actual.runUtf8CommandWithTimeout>[1]) => {
        if (typeof options === "number") {
          throw new Error("Expected the stats reader's process options");
        }
        const pending = actual.runUtf8CommandWithTimeout(argv, {
          ...options,
          input: JSON.stringify({
            ...JSON.parse(String(options.input)),
            moduleUrl: transport.moduleUrl,
          }),
          onOutputChunk: (chunk) => transport.onOutput?.(chunk),
          signal: transport.controller.signal,
        });
        transport.pending.add(pending);
        void pending.finally(() => transport.pending.delete(pending)).catch(() => {});
        return pending;
      },
    ),
  };
});

// Substitute only the native dependency; the registered command, child program,
// deadline, process termination, output decoding, and schema checks remain real.
transport.moduleUrl = `data:text/javascript,${encodeURIComponent(`
import { writeSync } from "node:fs";
function hold() {
  writeSync(2, "ready:" + process.pid + "\\n");
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
}
export async function connect(mode, options) {
  if (mode === "connect-stall") hold();
  return {
    tableNames: async () => mode === "empty" ? [] : ["memories"],
    openTable: async () => ({
      schema: async () => ({ fields: mode === "legacy" ? [] : [{ name: "agentId" }] }),
      countRows: async (predicate) => {
        if (mode === "count-stall") hold();
        if (mode === "failed") throw new Error("fixture database unavailable");
        if (mode === "legacy") throw new Error("unknown column agentId");
        if (predicate !== "agentId = 'main''s'") throw new Error("incorrect agent scope");
        if (options.storageOptions?.fixture !== "stdin-only") throw new Error("missing storage options");
        return 7;
      },
      close() {},
    }),
    createEmptyTable() { throw new Error("stats must never create a table"); },
    close() {},
  };
}
export async function loadLanceDbModule() { return { connect }; }
`)}`;

afterEach(async () => {
  transport.controller.abort();
  await Promise.allSettled(transport.pending);
  transport.controller = new AbortController();
  transport.onOutput = undefined;
  vi.restoreAllMocks();
});

describe("memory-lancedb statistics", () => {
  it("runs the registered stats command outside the shared database and keeps agent scope", async () => {
    const program = new Command();
    const embed = vi.fn();
    const registerCli = vi.fn();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    registerMemoryCli(
      { registerCli } as unknown as OpenClawPluginApi,
      {
        count: () => {
          throw new Error("in-process native count must not run");
        },
      } as unknown as MemoryDB,
      { embed, close: async () => {} },
      (agent) => String(agent),
      () => ({
        embedding: { provider: "openai", model: "text-embedding-3-small" },
        captureMaxChars: 500,
        recallMaxChars: 1000,
      }),
      { dbPath: "populated", storageOptions: { fixture: "stdin-only" } },
    );
    const registrar = registerCli.mock.calls[0]?.[0] as
      | ((context: { program: Command }) => void)
      | undefined;
    if (!registrar) {
      throw new Error("Expected the memory CLI registrar");
    }
    registrar({ program });

    await program.parseAsync(["node", "openclaw", "ltm", "stats", "--agent", "main's"]);

    expect(log).toHaveBeenCalledWith("Total memories: 7");
    expect(embed).not.toHaveBeenCalled();
  });

  it("reports an empty database without creating a table", async () => {
    await expect(readMemoryStats({ dbPath: "empty" }, "main")).resolves.toBe(0);
  });

  it.each([
    ["legacy", "openclaw doctor --fix"],
    ["failed", "fixture database unavailable"],
  ])("preserves the %s database diagnostic", async (dbPath, message) => {
    await expect(readMemoryStats({ dbPath }, "main")).rejects.toThrow(message);
  });

  it.each(["connect-stall", "count-stall"])(
    "stops a reader blocked in %s before reporting the deadline",
    async (dbPath) => {
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
      const running = readMemoryStats({ dbPath }, "main");
      const rejected = expect(running).rejects.toThrow("statistics timed out after 60 seconds");
      const pid = await ready.promise;
      expect(isPidAlive(pid)).toBe(true);

      const deadline = timers.mock.calls.find(([, delay]) => delay === 60_000);
      expect(deadline).toBeDefined();
      // Advance only the command deadline. OS teardown still uses its real exit events.
      const [fire, , ...args] = deadline!;
      fire(...args);
      await rejected;
      expect(isPidAlive(pid)).toBe(false);
    },
  );

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
    await expect(readMemoryStats({ dbPath: "unavailable" }, "main")).rejects.toThrow(
      "process cleanup could not be confirmed",
    );
  });
});
