import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { upsertSessionEntry } from "../config/sessions.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { createSuiteTempRootTracker } from "../test-helpers/temp-dir.js";
import { getSubagentDepthFromSessionEntries } from "./subagent-depth.js";
import { resolveAgentTimeoutMs, resolveAgentTimeoutSeconds } from "./timeout.js";

describe("getSubagentDepthFromSessionEntries", () => {
  const suiteRootTracker = createSuiteTempRootTracker({
    prefix: "openclaw-subagent-depth-",
  });
  let previousStateDir: string | undefined;

  beforeAll(async () => {
    await suiteRootTracker.setup();
  });

  beforeEach(async () => {
    previousStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = await suiteRootTracker.make("case");
  });

  afterEach(() => {
    closeOpenClawAgentDatabasesForTest();
    if (previousStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
    }
  });

  afterAll(async () => {
    await suiteRootTracker.cleanup();
  });

  it("uses spawnDepth from the session store when available", () => {
    const key = "agent:main:subagent:flat";
    const depth = getSubagentDepthFromSessionEntries(key, {
      store: {
        [key]: { spawnDepth: 2 },
      },
    });
    expect(depth).toBe(2);
  });

  it("derives depth from spawnedBy ancestry when spawnDepth is missing", () => {
    const key1 = "agent:main:subagent:one";
    const key2 = "agent:main:subagent:two";
    const key3 = "agent:main:subagent:three";
    const depth = getSubagentDepthFromSessionEntries(key3, {
      store: {
        [key1]: { spawnedBy: "agent:main:main" },
        [key2]: { spawnedBy: key1 },
        [key3]: { spawnedBy: key2 },
      },
    });
    expect(depth).toBe(3);
  });

  it("resolves depth when caller is identified by sessionId", () => {
    const key1 = "agent:main:subagent:one";
    const key2 = "agent:main:subagent:two";
    const key3 = "agent:main:subagent:three";
    const depth = getSubagentDepthFromSessionEntries("subagent-three-session", {
      store: {
        [key1]: { sessionId: "subagent-one-session", spawnedBy: "agent:main:main" },
        [key2]: { sessionId: "subagent-two-session", spawnedBy: key1 },
        [key3]: { sessionId: "subagent-three-session", spawnedBy: key2 },
      },
    });
    expect(depth).toBe(3);
  });

  it("resolves prefixed store keys when caller key omits the agent prefix", () => {
    const prefixedKey = "agent:main:subagent:flat";
    upsertSessionEntry({
      agentId: "main",
      sessionKey: prefixedKey,
      entry: {
        sessionId: "subagent-flat",
        updatedAt: Date.now(),
        spawnDepth: 2,
      },
    });

    const depth = getSubagentDepthFromSessionEntries("subagent:flat", {
      cfg: {},
    });

    expect(depth).toBe(2);
  });

  it("reads prefixed session metadata from sqlite without a store path", () => {
    const prefixedKey = "agent:main:subagent:flat";
    upsertSessionEntry({
      agentId: "main",
      sessionKey: prefixedKey,
      entry: {
        sessionId: "subagent-flat",
        updatedAt: Date.now(),
        spawnDepth: 2,
      },
    });

    const depth = getSubagentDepthFromSessionEntries(prefixedKey);

    expect(depth).toBe(2);
  });

  it("falls back to session-key segment counting when metadata is missing", () => {
    const key = "agent:main:subagent:flat";
    const depth = getSubagentDepthFromSessionEntries(key, {
      store: {
        [key]: {},
      },
    });
    expect(depth).toBe(1);
  });
});

describe("resolveAgentTimeoutMs", () => {
  it("defaults to 48 hours when config does not override the timeout", () => {
    expect(resolveAgentTimeoutSeconds()).toBe(48 * 60 * 60);
    expect(resolveAgentTimeoutMs({})).toBe(48 * 60 * 60 * 1000);
  });

  it("uses a timer-safe sentinel for no-timeout overrides", () => {
    expect(resolveAgentTimeoutMs({ overrideSeconds: 0 })).toBe(2_147_000_000);
    expect(resolveAgentTimeoutMs({ overrideMs: 0 })).toBe(2_147_000_000);
  });

  it("clamps very large timeout overrides to timer-safe values", () => {
    expect(resolveAgentTimeoutMs({ overrideSeconds: 9_999_999 })).toBe(2_147_000_000);
    expect(resolveAgentTimeoutMs({ overrideMs: 9_999_999_999 })).toBe(2_147_000_000);
  });
});
