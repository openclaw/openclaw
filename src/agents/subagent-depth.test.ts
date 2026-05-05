import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getSubagentDepthFromSessionStore } from "./subagent-depth.js";
import { resolveAgentTimeoutMs, resolveAgentTimeoutSeconds } from "./timeout.js";

const tempDirs: string[] = [];

function createTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  vi.unstubAllEnvs();
});

describe("getSubagentDepthFromSessionStore", () => {
  it("uses spawnDepth from the session store when available", () => {
    const key = "agent:main:subagent:flat";
    const depth = getSubagentDepthFromSessionStore(key, {
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
    const depth = getSubagentDepthFromSessionStore(key3, {
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
    const depth = getSubagentDepthFromSessionStore("subagent-three-session", {
      store: {
        [key1]: { sessionId: "subagent-one-session", spawnedBy: "agent:main:main" },
        [key2]: { sessionId: "subagent-two-session", spawnedBy: key1 },
        [key3]: { sessionId: "subagent-three-session", spawnedBy: key2 },
      },
    });
    expect(depth).toBe(3);
  });

  it("resolves prefixed store keys when caller key omits the agent prefix", () => {
    const tmpDir = createTempDir("openclaw-subagent-depth-");
    const storeTemplate = path.join(tmpDir, "sessions-{agentId}.json");
    const prefixedKey = "agent:main:subagent:flat";
    const storePath = storeTemplate.replaceAll("{agentId}", "main");
    fs.writeFileSync(
      storePath,
      JSON.stringify(
        {
          [prefixedKey]: {
            sessionId: "subagent-flat",
            updatedAt: Date.now(),
            spawnDepth: 2,
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    const depth = getSubagentDepthFromSessionStore("subagent:flat", {
      cfg: {
        session: {
          store: storeTemplate,
        },
      },
    });

    expect(depth).toBe(2);
  });

  it("accepts JSON5 syntax in the on-disk depth store for backward compatibility", () => {
    const tmpDir = createTempDir("openclaw-subagent-depth-json5-");
    const storeTemplate = path.join(tmpDir, "sessions-{agentId}.json");
    const storePath = storeTemplate.replaceAll("{agentId}", "main");
    fs.writeFileSync(
      storePath,
      `{
        // hand-edited legacy store
        "agent:main:subagent:flat": {
          sessionId: "subagent-flat",
          spawnDepth: 2,
        },
      }`,
      "utf-8",
    );

    const depth = getSubagentDepthFromSessionStore("subagent:flat", {
      cfg: {
        session: {
          store: storeTemplate,
        },
      },
    });

    expect(depth).toBe(2);
  });

  it("falls back to session-key segment counting when metadata is missing", () => {
    const key = "agent:main:subagent:flat";
    const depth = getSubagentDepthFromSessionStore(key, {
      store: {
        [key]: {},
      },
    });
    expect(depth).toBe(1);
  });

  it("falls back to session-key segment counting when the default store file is absent", () => {
    const stateDir = createTempDir("openclaw-subagent-depth-missing-default-store-");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);

    const depth = getSubagentDepthFromSessionStore("agent:main:subagent:orphan");

    expect(depth).toBe(1);
  });

  it("uses the default on-disk session store for explicit agent keys when cfg is omitted", () => {
    const stateDir = createTempDir("openclaw-subagent-depth-default-state-");
    const storePath = path.join(stateDir, "agents", "main", "sessions", "sessions.json");
    const key = "agent:main:explicit:new-skills-zoom-panel-20260423a:acct:default";
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    fs.writeFileSync(
      storePath,
      JSON.stringify(
        {
          [key]: {
            sessionId: "new-skills-zoom-panel-20260423a",
            spawnDepth: 1,
          },
        },
        null,
        2,
      ),
      "utf-8",
    );
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);

    const depth = getSubagentDepthFromSessionStore(key);

    expect(depth).toBe(1);
  });

  it("derives spawnedBy ancestry from the default on-disk session store when cfg is omitted", () => {
    const stateDir = createTempDir("openclaw-subagent-depth-default-ancestry-");
    const storePath = path.join(stateDir, "agents", "main", "sessions", "sessions.json");
    const parentKey = "agent:main:subagent:panel-parent";
    const key = "agent:main:explicit:new-skills-zoom-panel-20260423a:acct:default";
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    fs.writeFileSync(
      storePath,
      JSON.stringify(
        {
          [parentKey]: {
            sessionId: "panel-parent",
            spawnedBy: "agent:main:main",
          },
          [key]: {
            sessionId: "new-skills-zoom-panel-20260423a",
            spawnedBy: parentKey,
          },
        },
        null,
        2,
      ),
      "utf-8",
    );
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);

    const depth = getSubagentDepthFromSessionStore(key);

    expect(depth).toBe(2);
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
