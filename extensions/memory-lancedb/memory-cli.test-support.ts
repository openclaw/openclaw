import { Command } from "commander";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { vi } from "vitest";
import type { MemoryDB } from "./lancedb-store.js";
import { registerMemoryCli } from "./memory-cli.js";
import type { MemoryStatsSource } from "./memory-stats.js";

export function createMemoryCliHarness(
  params: {
    embedError?: unknown;
    closeError?: Error;
    queryRows?: Record<string, unknown>[];
    statsSource?: MemoryStatsSource;
  } = {},
) {
  const program = new Command();
  const registerCli = (register: (context: { program: Command }) => void) => register({ program });
  const embed = vi.fn(async () => [0.1, 0.2]);
  const close = vi.fn(async () => {});
  if (Object.hasOwn(params, "embedError")) {
    embed.mockRejectedValue(params.embedError);
  }
  if (params.closeError) {
    close.mockRejectedValue(params.closeError);
  }
  const search = vi.fn(async () => []);
  const query = vi.fn(async () => params.queryRows ?? []);
  const count = () => {
    throw new Error("in-process native count must not run");
  };
  registerMemoryCli(
    { registerCli } as unknown as OpenClawPluginApi,
    (params.statsSource ? { count } : { search, query }) as unknown as MemoryDB,
    { embed, close },
    (agent) => (typeof agent === "string" ? agent : "main"),
    () => ({
      embedding: { provider: "openai", model: "text-embedding-3-small" },
      captureMaxChars: 500,
      recallMaxChars: 1000,
    }),
    params.statsSource ?? { dbPath: "/fixture/memory" },
  );
  const run = (...args: string[]) => program.parseAsync(["node", "openclaw", "ltm", ...args]);
  return { close, embed, run, query, search };
}
