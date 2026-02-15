import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { getSubagentDepthFromSessionStore } from "./subagent-depth.js";

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
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-subagent-depth-"));
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

  it("falls back to session-key segment counting when metadata is missing", () => {
    const key = "agent:main:subagent:flat";
    const depth = getSubagentDepthFromSessionStore(key, {
      store: {
        [key]: {},
      },
    });
    expect(depth).toBe(1);
  });
});
