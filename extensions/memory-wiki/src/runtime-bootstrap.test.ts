import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  listActiveMemoryPublicArtifactsMock,
  resolveDefaultAgentIdMock,
  getActiveMemorySearchManagerMock,
} = vi.hoisted(() => ({
  listActiveMemoryPublicArtifactsMock:
    vi.fn<typeof import("openclaw/plugin-sdk/memory-host-core").listActiveMemoryPublicArtifacts>(),
  resolveDefaultAgentIdMock:
    vi.fn<typeof import("openclaw/plugin-sdk/memory-host-core").resolveDefaultAgentId>(),
  getActiveMemorySearchManagerMock:
    vi.fn<typeof import("openclaw/plugin-sdk/memory-host-search").getActiveMemorySearchManager>(),
}));

vi.mock("openclaw/plugin-sdk/memory-host-core", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/memory-host-core")>(
    "openclaw/plugin-sdk/memory-host-core",
  );
  return {
    ...actual,
    listActiveMemoryPublicArtifacts: listActiveMemoryPublicArtifactsMock,
    resolveDefaultAgentId: resolveDefaultAgentIdMock,
  };
});

vi.mock("openclaw/plugin-sdk/memory-host-search", () => ({
  getActiveMemorySearchManager: getActiveMemorySearchManagerMock,
}));

import type { OpenClawConfig } from "../api.js";
import { ensureMemoryWikiPublicArtifactsRuntime } from "./runtime-bootstrap.js";

describe("ensureMemoryWikiPublicArtifactsRuntime", () => {
  beforeEach(() => {
    listActiveMemoryPublicArtifactsMock.mockReset();
    resolveDefaultAgentIdMock.mockReset();
    getActiveMemorySearchManagerMock.mockReset();
    listActiveMemoryPublicArtifactsMock.mockResolvedValue([]);
    resolveDefaultAgentIdMock.mockReturnValue("main");
    getActiveMemorySearchManagerMock.mockResolvedValue({ manager: null });
  });

  it("uses the default agent to bootstrap the active memory runtime", async () => {
    const appConfig = {
      agents: {
        list: [{ id: "main", default: true, workspace: "/tmp/workspace" }],
      },
    } as OpenClawConfig;

    await ensureMemoryWikiPublicArtifactsRuntime(appConfig);

    expect(listActiveMemoryPublicArtifactsMock).toHaveBeenCalledWith({ cfg: appConfig });
    expect(resolveDefaultAgentIdMock).toHaveBeenCalledWith(appConfig);
    expect(getActiveMemorySearchManagerMock).toHaveBeenCalledWith({
      cfg: appConfig,
      agentId: "main",
      purpose: "status",
    });
  });

  it("skips bootstrap when public artifacts are already registered", async () => {
    listActiveMemoryPublicArtifactsMock.mockResolvedValue([
      {
        kind: "memory-root",
        workspaceDir: "/tmp/workspace",
        relativePath: "MEMORY.md",
        absolutePath: "/tmp/workspace/MEMORY.md",
        agentIds: ["main"],
        contentType: "markdown",
      },
    ]);

    await ensureMemoryWikiPublicArtifactsRuntime({
      agents: {
        list: [{ id: "main", default: true, workspace: "/tmp/workspace" }],
      },
    } as OpenClawConfig);

    expect(resolveDefaultAgentIdMock).not.toHaveBeenCalled();
    expect(getActiveMemorySearchManagerMock).not.toHaveBeenCalled();
  });

  it("swallows bootstrap failures and leaves artifact lookup to report the outcome", async () => {
    getActiveMemorySearchManagerMock.mockRejectedValue(new Error("boom"));

    await expect(
      ensureMemoryWikiPublicArtifactsRuntime({
        agents: {
          list: [{ id: "main", default: true, workspace: "/tmp/workspace" }],
        },
      } as OpenClawConfig),
    ).resolves.toBeUndefined();
  });

  it("does nothing when app config is unavailable", async () => {
    await ensureMemoryWikiPublicArtifactsRuntime();

    expect(listActiveMemoryPublicArtifactsMock).not.toHaveBeenCalled();
    expect(resolveDefaultAgentIdMock).not.toHaveBeenCalled();
    expect(getActiveMemorySearchManagerMock).not.toHaveBeenCalled();
  });
});
