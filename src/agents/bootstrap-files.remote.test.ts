import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearInternalHooks, registerInternalHook } from "../hooks/internal-hooks.js";
import type { classifyActiveMemoryWorkspacePaths } from "../plugins/memory-runtime.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { resolveBootstrapFilesForRun } from "./bootstrap-files.js";
import { createRemoteShellSandboxFsBridge } from "./sandbox/remote-fs-bridge.js";
import { createLocalRemoteShellScriptRunner } from "./sandbox/remote-fs-bridge.test-helpers.js";
import { createSandboxTestContext } from "./sandbox/test-fixtures.js";
import { registerAgentWorkspaceAccess } from "./workspace-access.js";
import { resetLegacyWorkspaceStateCheckForTest } from "./workspace-legacy-state.test-support.js";
import { loadExtraBootstrapFilesWithDiagnostics } from "./workspace.js";

const { classify } = vi.hoisted(() => ({ classify: vi.fn() }));

// mock-isolation: Workspace classification is fixed without loading unrelated memory plugins.
vi.mock("../plugins/memory-runtime.js", () => ({
  classifyActiveMemoryWorkspacePaths: classify,
}));

let testState: Awaited<ReturnType<typeof createOpenClawTestState>> | undefined;
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

const resolveFiles = (params: Partial<Parameters<typeof resolveBootstrapFilesForRun>[0]> = {}) =>
  resolveBootstrapFilesForRun({ workspaceDir, ...params });
const profileDir = (root: string, id: string) => path.join(root, "users", id);
async function write(root: string, name: string, content: string) {
  const file = path.join(root, name);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
}
const agentClassification = {
  status: "classified",
  classifications: [{ relativePath: "USER.md", originClass: "agent" }],
};

describe.runIf(process.platform !== "win32")("remote bootstrap read provenance", () => {
  beforeEach(async () => {
    clearInternalHooks();
    release = undefined;
    resetLegacyWorkspaceStateCheckForTest();
    classify.mockReset().mockResolvedValue(agentClassification);
    testState = await createOpenClawTestState({ layout: "state-only" });
    workspaceDir = testState.workspaceDir;
    remoteDir = testState.path("remote");
    await fs.mkdir(remoteDir);
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
    await write(profileDir(workspaceDir, alice.id), "USER.md", "Local decoy");
    await write(profileDir(remoteDir, alice.id), "USER.md", "Remote Alice");
    await fs.symlink(profileDir(remoteDir, alice.id), profileDir(remoteDir, bob.id), "junction");
    bindRemote();
    const files = await resolveFiles({ bootstrapUserProfileId: alice.id });
    expect(files.filter((file) => file.name === "USER.md").map((file) => file.content)).toEqual([
      "Remote Alice",
    ]);
    const aliased = await resolveFiles({ bootstrapUserProfileId: bob.id });
    expect(aliased.some((file) => file.content === "Remote Alice")).toBe(false);
  });

  it("finds bootstrap files in large remote directories just as it does locally", async () => {
    await write(remoteDir, "AGENTS.md", "Instructions");
    for (let start = 0; start < 4100; start += 100) {
      await Promise.all(
        Array.from({ length: 100 }, (_, offset) =>
          fs.writeFile(path.join(remoteDir, `${start + offset}.txt`), ""),
        ),
      );
    }
    const local = await loadExtraBootstrapFilesWithDiagnostics(remoteDir, ["*.md"]);
    expect(local.files).toMatchObject([{ name: "AGENTS.md", content: "Instructions" }]);
    bindRemote();
    const remote = await loadExtraBootstrapFilesWithDiagnostics(workspaceDir, ["*.md"]);
    expect(remote).toMatchObject({
      diagnostics: [],
      files: [{ name: "AGENTS.md", content: "Instructions" }],
    });
  });

  it("refreshes remote read provenance even when the cached path and bytes are unchanged", async () => {
    await write(workspaceDir, "USER.md", "Gateway decoy");
    await write(remoteDir, "USER.md", "Harness profile");
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
    classify.mockImplementation(
      async ({ readSources }: Parameters<typeof classifyActiveMemoryWorkspacePaths>[0]) => ({
        status: "classified",
        classifications: (readSources ?? []).map((source) => ({
          relativePath: source.relativePath,
          originClass: source.canonicalRelativePath === "USER.md" ? "agent" : "untrusted",
        })),
      }),
    );
    const params = { sessionKey: "agent:main:cache", config: {}, agentId: "main" };
    const first = await resolveFiles(params);
    expect(first.find((file) => file.name === "USER.md")?.content).toBe("Harness profile");
    workspaceSource = false;
    const second = await resolveFiles(params);
    expect(second.some((file) => file.name === "USER.md")).toBe(false);
    expect(await fs.readFile(path.join(workspaceDir, "USER.md"), "utf8")).toBe("Gateway decoy");
  });

  it.each(["classification", "hook"])("rejects remote context revoked during %s", async (stage) => {
    await write(remoteDir, "USER.md", "Harness profile");
    const revoke = bindRemote();
    if (stage === "classification") {
      classify.mockImplementationOnce(async () => {
        revoke();
        return agentClassification;
      });
    } else {
      registerInternalHook("agent:bootstrap", async () => {
        await Promise.resolve();
        revoke();
      });
    }
    await expect(resolveFiles({ config: {}, agentId: "main" })).rejects.toThrow(/changed|stopped/);
  });
});
