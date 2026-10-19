import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { clearInternalHooks, registerInternalHook } from "../hooks/internal-hooks.js";
import type { classifyActiveMemoryWorkspacePaths } from "../plugins/memory-runtime.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { resolveBootstrapFilesForRun } from "./bootstrap-files.js";
import { createRemoteShellSandboxFsBridge } from "./sandbox/remote-fs-bridge.js";
import { createLocalRemoteShellScriptRunner } from "./sandbox/remote-fs-bridge.test-helpers.js";
import { createSandboxTestContext } from "./sandbox/test-fixtures.js";
import { registerAgentWorkspaceAccess } from "./workspace-access.js";
import { resetLegacyWorkspaceStateCheckForTest } from "./workspace-legacy-state.test-support.js";
import { loadExtraBootstrapFilesWithDiagnostics } from "./workspace.js";

const memoryRuntimeMocks = vi.hoisted(() => ({ classifyWorkspacePaths: vi.fn() }));

vi.mock("../plugins/memory-runtime.js", () => ({
  classifyActiveMemoryWorkspacePaths: (...args: unknown[]) =>
    memoryRuntimeMocks.classifyWorkspacePaths(...args),
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let testState: OpenClawTestState | undefined;
let workspaceDir: string;
let remoteDir: string;
let release: (() => void) | undefined;

function bindRemote(bridge = createRemoteBridge()) {
  release = registerAgentWorkspaceAccess(workspaceDir, { bridge });
  return release;
}

function createRemoteBridge() {
  return createRemoteShellSandboxFsBridge({
    sandbox: createSandboxTestContext({
      overrides: { workspaceDir, agentWorkspaceDir: workspaceDir },
    }),
    runtime: {
      remoteWorkspaceDir: remoteDir,
      remoteAgentWorkspaceDir: remoteDir,
      runRemoteShellScript: createLocalRemoteShellScriptRunner(),
    },
  });
}

describe.runIf(process.platform !== "win32")("remote bootstrap read provenance", () => {
  beforeEach(async () => {
    clearInternalHooks();
    release = undefined;
    workspaceDir = tempDirs.make("bootstrap-gateway-");
    remoteDir = tempDirs.make("bootstrap-remote-");
    resetLegacyWorkspaceStateCheckForTest();
    memoryRuntimeMocks.classifyWorkspacePaths.mockReset();
    testState = await createOpenClawTestState({
      layout: "state-only",
      prefix: "openclaw-remote-bootstrap-state-",
    });
  });

  afterEach(async () => {
    release?.();
    clearInternalHooks();
    closeOpenClawStateDatabaseForTest();
    resetLegacyWorkspaceStateCheckForTest();
    await testState?.cleanup();
    testState = undefined;
  });

  it("selects personal files from the bound workspace and rejects remote profile aliases", async () => {
    const alice = ensureProfileForEmail("alice@example.test");
    const bob = ensureProfileForEmail("bob@example.test");
    for (const root of [workspaceDir, remoteDir]) {
      await fs.mkdir(path.join(root, "users", alice.id), { recursive: true });
      await fs.writeFile(
        path.join(root, "users", alice.id, "USER.md"),
        root === remoteDir ? "Remote Alice" : "Local decoy",
      );
    }
    await fs.symlink(
      path.join(remoteDir, "users", alice.id),
      path.join(remoteDir, "users", bob.id),
      "junction",
    );
    bindRemote();
    const files = await resolveBootstrapFilesForRun({
      workspaceDir,
      bootstrapUserProfileId: alice.id,
    });
    expect(files.filter((file) => file.name === "USER.md").map((file) => file.content)).toEqual([
      "Remote Alice",
    ]);
    const aliased = await resolveBootstrapFilesForRun({
      workspaceDir,
      bootstrapUserProfileId: bob.id,
    });
    expect(aliased.some((file) => file.content === "Remote Alice")).toBe(false);
  });

  it("finds bootstrap files in large remote directories just as it does locally", async () => {
    await fs.writeFile(path.join(remoteDir, "AGENTS.md"), "Harness instructions");
    for (let start = 0; start < 4100; start += 100) {
      await Promise.all(
        Array.from({ length: 100 }, (_, offset) =>
          fs.writeFile(path.join(remoteDir, `${String(start + offset).padStart(4, "0")}.txt`), ""),
        ),
      );
    }
    const local = await loadExtraBootstrapFilesWithDiagnostics(remoteDir, ["*.md"]);
    expect(local.files).toMatchObject([{ name: "AGENTS.md", content: "Harness instructions" }]);
    bindRemote();
    const remote = await loadExtraBootstrapFilesWithDiagnostics(workspaceDir, ["*.md"]);
    expect(remote.diagnostics).toEqual([]);
    expect(remote.files).toMatchObject([{ name: "AGENTS.md", content: "Harness instructions" }]);
  });

  it("refreshes remote read provenance even when the cached path and bytes are unchanged", async () => {
    await fs.writeFile(path.join(workspaceDir, "USER.md"), "Gateway decoy");
    await fs.writeFile(path.join(remoteDir, "USER.md"), "Harness profile");
    const bridge = createRemoteBridge();
    let workspaceSource = true;
    const read = bridge.readFileWithSource!.bind(bridge);
    bridge.readFileWithSource = async (params) => {
      const result = await read(params);
      return {
        ...result,
        workspaceRelativePath: workspaceSource ? result.workspaceRelativePath : undefined,
      };
    };
    bindRemote(bridge);
    memoryRuntimeMocks.classifyWorkspacePaths.mockImplementation(
      async ({ readSources }: Parameters<typeof classifyActiveMemoryWorkspacePaths>[0]) => ({
        status: "classified",
        classifications: (readSources ?? []).map((source) => ({
          relativePath: source.relativePath,
          originClass: source.canonicalRelativePath === "USER.md" ? "agent" : "untrusted",
        })),
      }),
    );
    const params = {
      workspaceDir,
      sessionKey: "agent:main:remote-source-cache",
      config: {},
      agentId: "main",
    };
    const first = await resolveBootstrapFilesForRun(params);
    expect(first.find((file) => file.name === "USER.md")?.content).toBe("Harness profile");
    workspaceSource = false;
    const second = await resolveBootstrapFilesForRun(params);
    expect(second.some((file) => file.name === "USER.md")).toBe(false);
    expect(await fs.readFile(path.join(workspaceDir, "USER.md"), "utf8")).toBe("Gateway decoy");
  });

  it.each(["classification", "hook"])("rejects remote context revoked during %s", async (stage) => {
    await fs.writeFile(path.join(remoteDir, "USER.md"), "Harness profile");
    const revoke = bindRemote();
    memoryRuntimeMocks.classifyWorkspacePaths.mockImplementation(async () => {
      if (stage === "classification") {
        revoke();
      }
      return {
        status: "classified",
        classifications: [{ relativePath: "USER.md", originClass: "agent" }],
      };
    });
    if (stage === "hook") {
      registerInternalHook("agent:bootstrap", async () => {
        await Promise.resolve();
        revoke();
      });
    }
    await expect(
      resolveBootstrapFilesForRun({ workspaceDir, config: {}, agentId: "main" }),
    ).rejects.toThrow(/changed|stopped/);
  });
});
