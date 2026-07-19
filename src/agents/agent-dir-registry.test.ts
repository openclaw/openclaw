import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  registerResolvedAgentDir,
  resolveRegisteredAgentIdForDir,
  unregisterResolvedAgentDir,
} from "./agent-dir-registry.js";

describe("agent directory registry", () => {
  it("does not let stale cleanup remove a directory's current owner", () => {
    const agentDir = path.join("/tmp", `openclaw-agent-dir-registry-${process.pid}`);
    registerResolvedAgentDir({ agentId: "first", agentDir });
    registerResolvedAgentDir({ agentId: "second", agentDir });

    expect(unregisterResolvedAgentDir({ agentId: "first", agentDir })).toBe(false);
    expect(resolveRegisteredAgentIdForDir(agentDir)).toBe("second");
    expect(unregisterResolvedAgentDir({ agentId: "second", agentDir })).toBe(true);
    expect(resolveRegisteredAgentIdForDir(agentDir)).toBeUndefined();
  });
});
