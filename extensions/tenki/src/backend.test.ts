import { describe, expect, it } from "vitest";
import { resolveTenkiRuntimePaths } from "./backend.js";

describe("resolveTenkiRuntimePaths", () => {
  it("builds stable per-scope remote paths", () => {
    const paths = resolveTenkiRuntimePaths("/tmp/openclaw-sandboxes", "agent:main");
    expect(paths.runtimeId).toMatch(/^oc-tenki-agent-main-[0-9a-f]{1,8}$/);
    expect(paths.runtimeId.length).toBeLessThanOrEqual(32);
    expect(paths.runtimeRootDir).toBe(`/tmp/openclaw-sandboxes/${paths.runtimeId}`);
    expect(paths.remoteWorkspaceDir).toBe(`${paths.runtimeRootDir}/workspace`);
    expect(paths.remoteAgentWorkspaceDir).toBe(`${paths.runtimeRootDir}/agent`);
  });

  it("differs for different scope keys", () => {
    const a = resolveTenkiRuntimePaths("/tmp/openclaw-sandboxes", "agent:a");
    const b = resolveTenkiRuntimePaths("/tmp/openclaw-sandboxes", "agent:b");
    expect(a.runtimeId).not.toBe(b.runtimeId);
  });

  it("keeps the runtime id within Tenki's 32-char tag limit", () => {
    const paths = resolveTenkiRuntimePaths(
      "/tmp/openclaw-sandboxes",
      "agent:very-long-agent-name:session:with-many-segments",
    );
    expect(paths.runtimeId.length).toBeLessThanOrEqual(32);
  });

  it("falls back to a session id for empty scope keys", () => {
    const paths = resolveTenkiRuntimePaths("/tmp/openclaw-sandboxes", "  ");
    expect(paths.runtimeId).toMatch(/^oc-tenki-session-[0-9a-f]{1,8}$/);
  });
});
