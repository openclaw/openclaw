import { describe, expect, it } from "vitest";
import { resolveTenkiRuntimePaths } from "./backend.js";

describe("resolveTenkiRuntimePaths", () => {
  it("builds stable per-scope remote paths", () => {
    const paths = resolveTenkiRuntimePaths("/tmp/openclaw-sandboxes", "agent:main");
    expect(paths.runtimeId).toMatch(/^openclaw-tenki-agent-main-[0-9a-f]{1,8}$/);
    expect(paths.runtimeRootDir).toBe(`/tmp/openclaw-sandboxes/${paths.runtimeId}`);
    expect(paths.remoteWorkspaceDir).toBe(`${paths.runtimeRootDir}/workspace`);
    expect(paths.remoteAgentWorkspaceDir).toBe(`${paths.runtimeRootDir}/agent`);
  });

  it("differs for different scope keys", () => {
    const a = resolveTenkiRuntimePaths("/tmp/openclaw-sandboxes", "agent:a");
    const b = resolveTenkiRuntimePaths("/tmp/openclaw-sandboxes", "agent:b");
    expect(a.runtimeId).not.toBe(b.runtimeId);
  });

  it("falls back to a session id for empty scope keys", () => {
    const paths = resolveTenkiRuntimePaths("/tmp/openclaw-sandboxes", "  ");
    expect(paths.runtimeId).toMatch(/^openclaw-tenki-session-[0-9a-f]{1,8}$/);
  });
});
