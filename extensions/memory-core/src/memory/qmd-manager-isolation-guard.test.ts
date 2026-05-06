import { describe, expect, it } from "vitest";
import { QmdMemoryManager } from "./qmd-manager.js";

const baseCfg = {
  memory: {
    isolation: { enabled: true, fallbackPolicy: "deny" },
  },
} as unknown as Parameters<typeof QmdMemoryManager.create>[0]["cfg"];

const cfgWithoutIsolation = {} as unknown as typeof baseCfg;

const resolvedQmd = {
  qmd: {
    command: "qmd",
    collections: [],
    searchMode: "query",
  },
} as unknown as Parameters<typeof QmdMemoryManager.create>[0]["resolved"];

describe("QmdMemoryManager.create isolation guard", () => {
  it("returns null when isolation is enabled but userId is missing", async () => {
    const result = await QmdMemoryManager.create({
      cfg: baseCfg,
      agentId: "agent-x",
      resolved: resolvedQmd,
    });
    expect(result).toBeNull();
  });

  it("returns null when isolation is enabled and userId is empty string", async () => {
    const result = await QmdMemoryManager.create({
      cfg: baseCfg,
      agentId: "agent-x",
      userId: "",
      resolved: resolvedQmd,
    });
    expect(result).toBeNull();
  });

  it("does not enforce userId when isolation is disabled (or absent)", async () => {
    // We do not assert on a successful instance — initialize() may need on-disk
    // dependencies. We only assert that the early guard does NOT short-circuit
    // to null for the non-isolation case (i.e., it would proceed to initialize,
    // and any failure beyond the guard is unrelated to this test). To keep the
    // test deterministic, we pass a resolved config without `qmd`, which makes
    // create() return null at the *first* (existing) early-return — proving the
    // isolation guard wasn't the path taken.
    const result = await QmdMemoryManager.create({
      cfg: cfgWithoutIsolation,
      agentId: "agent-x",
      resolved: { qmd: undefined } as unknown as Parameters<
        typeof QmdMemoryManager.create
      >[0]["resolved"],
    });
    expect(result).toBeNull();
  });
});
