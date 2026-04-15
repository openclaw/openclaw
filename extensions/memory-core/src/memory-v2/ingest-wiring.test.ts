import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type AgentEndHandler,
  buildAgentEndHandler,
  readIngestEnabled,
  registerMemoryV2Ingest,
} from "./ingest-wiring.js";
import { ensureSidecarSchema } from "./sidecar-schema.js";

describe("readIngestEnabled", () => {
  it("returns false for null/undefined/non-object configs", () => {
    expect(readIngestEnabled(null)).toBe(false);
    expect(readIngestEnabled(undefined)).toBe(false);
    expect(readIngestEnabled("on")).toBe(false);
    expect(readIngestEnabled(42)).toBe(false);
  });

  it("returns false when memoryV2 is missing", () => {
    expect(readIngestEnabled({})).toBe(false);
    expect(readIngestEnabled({ dreaming: { enabled: true } })).toBe(false);
  });

  it("returns false when ingest.enabled is missing or not exactly true", () => {
    expect(readIngestEnabled({ memoryV2: {} })).toBe(false);
    expect(readIngestEnabled({ memoryV2: { ingest: {} } })).toBe(false);
    expect(readIngestEnabled({ memoryV2: { ingest: { enabled: false } } })).toBe(false);
    expect(readIngestEnabled({ memoryV2: { ingest: { enabled: "true" } } })).toBe(false);
    expect(readIngestEnabled({ memoryV2: { ingest: { enabled: 1 } } })).toBe(false);
  });

  it("returns true only when ingest.enabled === true", () => {
    expect(readIngestEnabled({ memoryV2: { ingest: { enabled: true } } })).toBe(true);
  });
});

describe("registerMemoryV2Ingest", () => {
  it("does not subscribe when the flag is off (default)", () => {
    const on = vi.fn();
    const subscribed = registerMemoryV2Ingest({ pluginConfig: undefined, on });
    expect(subscribed).toBe(false);
    expect(on).not.toHaveBeenCalled();
  });

  it("does not subscribe when the flag is explicitly false", () => {
    const on = vi.fn();
    registerMemoryV2Ingest({
      pluginConfig: { memoryV2: { ingest: { enabled: false } } },
      on,
    });
    expect(on).not.toHaveBeenCalled();
  });

  it("subscribes exactly once to agent_end when the flag is on", () => {
    const on = vi.fn();
    const subscribed = registerMemoryV2Ingest({
      pluginConfig: { memoryV2: { ingest: { enabled: true } } },
      on,
    });
    expect(subscribed).toBe(true);
    expect(on).toHaveBeenCalledTimes(1);
    expect(on.mock.calls[0]?.[0]).toBe("agent_end");
    expect(typeof on.mock.calls[0]?.[1]).toBe("function");
  });
});

describe("buildAgentEndHandler", () => {
  let db: DatabaseSync;
  let handler: AgentEndHandler;
  let runIngest: ReturnType<typeof vi.fn>;
  let openDb: ReturnType<typeof vi.fn>;
  let logWarn: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    ensureSidecarSchema(db);
    runIngest = vi.fn().mockReturnValue({
      candidatesConsidered: 0,
      inserted: 0,
      deduped: 0,
      filteredAsSecret: 0,
    });
    openDb = vi.fn().mockReturnValue(db);
    logWarn = vi.fn();
    handler = buildAgentEndHandler({
      runIngest: runIngest as never,
      openDb: openDb as never,
      logWarn: logWarn as never,
      now: () => 1000,
    });
  });

  afterEach(() => {
    db.close();
  });

  it("invokes ingest with the same workspace db across turns (cached open)", () => {
    handler(
      { messages: [{ role: "user", content: "my name is Alex" }], success: true },
      { sessionId: "s", workspaceDir: "/ws" },
    );
    handler(
      { messages: [{ role: "user", content: "my name is Alex" }], success: true },
      { sessionId: "s", workspaceDir: "/ws" },
    );
    expect(runIngest).toHaveBeenCalledTimes(2);
    // openDb is a stub injected fresh per test, not the cache-aware default,
    // so we just assert it was given the right path; the real cache lives in
    // createDefaultOpener and is exercised in handler.test.ts via direct calls.
    expect(openDb).toHaveBeenCalledWith("/ws");
  });

  it("short-circuits on event.success === false and never opens the db", () => {
    handler(
      { messages: [{ role: "user", content: "x" }], success: false, error: "boom" },
      { sessionId: "s", workspaceDir: "/ws" },
    );
    expect(openDb).not.toHaveBeenCalled();
    expect(runIngest).not.toHaveBeenCalled();
  });

  it("short-circuits when workspaceDir is missing", () => {
    handler({ messages: [{ role: "user", content: "x" }], success: true }, { sessionId: "s" });
    expect(openDb).not.toHaveBeenCalled();
    expect(runIngest).not.toHaveBeenCalled();
  });

  it("short-circuits when sessionId is missing", () => {
    handler({ messages: [{ role: "user", content: "x" }], success: true }, { workspaceDir: "/ws" });
    expect(openDb).not.toHaveBeenCalled();
    expect(runIngest).not.toHaveBeenCalled();
  });

  it("swallows ingest errors and reports via logWarn", () => {
    runIngest.mockImplementation(() => {
      throw new Error("boom");
    });
    expect(() =>
      handler(
        { messages: [{ role: "user", content: "x" }], success: true },
        { sessionId: "s", workspaceDir: "/ws" },
      ),
    ).not.toThrow();
    expect(logWarn).toHaveBeenCalledTimes(1);
  });

  it("swallows openDb errors and reports via logWarn", () => {
    openDb.mockImplementation(() => {
      throw new Error("disk full");
    });
    expect(() =>
      handler(
        { messages: [{ role: "user", content: "x" }], success: true },
        { sessionId: "s", workspaceDir: "/ws" },
      ),
    ).not.toThrow();
    expect(logWarn).toHaveBeenCalledTimes(1);
  });
});
