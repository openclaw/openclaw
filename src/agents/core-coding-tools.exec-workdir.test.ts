import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { saveExecApprovals } from "../infra/exec-approvals-store.test-support.js";
import { intersectExecPolicyCeilings } from "../infra/exec-policy.js";
import { prepareSandboxFsContext } from "../skills/runtime/refresh.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { resetProcessRegistryForTests } from "./bash-process-registry.test-support.js";
import type { ExecToolDefaults } from "./bash-tools.exec-types.js";
import { nodeCommand } from "./bash-tools.lifecycle.test-support.js";
import { createCoreCodingTools } from "./core-coding-tools.js";
import type { SandboxBackendHandle } from "./sandbox/backend-handle.types.js";
import { createSandboxTestContext } from "./sandbox/test-fixtures.js";
import { projectEffectiveExecPolicy } from "./session-permission-exec-mode.js";
import { createHostSandboxFsBridge } from "./test-helpers/host-sandbox-fs-bridge.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("coding-tool exec working directory", () => {
  let root: string;
  let codingRoot: string;

  beforeEach(() => {
    root = tempDirs.make("openclaw-coding-exec-workdir-");
    codingRoot = path.join(root, "workspace");
    fs.mkdirSync(path.join(codingRoot, "nested"), { recursive: true });
    fs.mkdirSync(path.join(codingRoot, "~"));
    fs.mkdirSync(path.join(root, "sibling"));
    vi.stubEnv("OPENCLAW_STATE_DIR", path.join(root, "state"));
    vi.stubEnv("OPENCLAW_EXEC_SHELL_SNAPSHOT", "0");
    if (process.platform !== "win32") {
      vi.stubEnv("SHELL", "/bin/sh");
    }
    saveExecApprovals({
      version: 1,
      defaults: { security: "full", ask: "off", askFallback: "full" },
      agents: {},
    });
  });

  afterEach(() => {
    resetProcessRegistryForTests();
    closeOpenClawStateDatabaseForTest();
    vi.unstubAllEnvs();
  });

  function createExecTool(
    sandbox?: Parameters<typeof createCoreCodingTools>[0]["sandbox"],
    participation = false,
    defaults: Partial<ExecToolDefaults> = {},
  ) {
    return createCoreCodingTools({
      codingRoot,
      containmentRoot: codingRoot,
      includeBaseCodingTools: false,
      shellTools: "full",
      workspaceOnly: false,
      readOnly: false,
      sandbox,
      applyPatchEnabled: false,
      applyPatchWorkspaceOnly: true,
      execDefaults: {
        host: sandbox ? "sandbox" : "gateway",
        participation,
        mode: "full",
        allowBackground: false,
        notifyOnExit: false,
        config: { plugins: { enabled: false } },
        ...defaults,
      },
      processDefaults: {},
    }).find((tool) => tool.name === "exec")!;
  }

  it.each([
    [undefined, "workspace", false],
    [".", "workspace", true],
    ["nested", "workspace/nested", false],
    ["~", "workspace/~", false],
    ["../sibling", "sibling", false],
    ["absolute", "sibling", false],
  ] as const)("executes for workdir=%s in %s (PTY=%s)", async (input, directory, pty) => {
    expect(fs.realpathSync(process.cwd())).not.toBe(codingRoot);
    const workdir = input === "absolute" ? path.join(root, "sibling") : input;
    const result = await createExecTool().execute("coding-workdir", {
      command: process.platform === "win32" ? "(Get-Location).Path" : "pwd -P",
      workdir,
      pty,
    });
    const expectedCwd = fs.realpathSync(path.join(root, directory));
    expect(result.details).toMatchObject({ status: "completed", exitCode: 0, cwd: expectedCwd });
    const output = result.content.find((content) => content.type === "text")?.text;
    expect(output?.trim()).toBe(expectedCwd);
  });

  it("confines participant process starts before auto-review, including symlink escapes", async () => {
    const reviewer = vi.fn(
      () => ({ decision: "allow-once", risk: "low", rationale: "fixture" }) as const,
    );
    const tool = createExecTool(undefined, true, { mode: "auto", autoReviewer: reviewer });
    fs.symlinkSync(path.join(root, "sibling"), path.join(codingRoot, "escape"), "dir");
    for (const workdir of [path.join(root, "sibling"), "../sibling", "escape"]) {
      await expect(tool.execute("outside", { command: "pwd -P", workdir })).rejects.toThrow(
        /participation root/,
      );
    }
    expect(reviewer).not.toHaveBeenCalled();
    await expect(
      tool.prepareBeforeToolCallParams?.({ command: "pwd -P", workdir: "escape" }, {}),
    ).rejects.toThrow(/participation root/);
    for (const workdir of [undefined, "nested", path.join(codingRoot, "nested")]) {
      const result = await tool.execute("inside", { command: "pwd -P", workdir });
      expect(result.details).toMatchObject({
        status: "completed",
        exitCode: 0,
        cwd: fs.realpathSync(workdir ? path.join(codingRoot, "nested") : codingRoot),
      });
    }
  });

  it.each(["on-miss", "always"] as const)(
    "does not reopen retained allowlist misses through host %s",
    async (ask) => {
      saveExecApprovals({
        version: 1,
        defaults: { security: "full", ask, askFallback: "full" },
        agents: {},
      });
      const reviewer = vi.fn(
        () => ({ decision: "allow-once", risk: "low", rationale: "fixture" }) as const,
      );
      const tool = createExecTool(undefined, true, {
        ...projectEffectiveExecPolicy({
          base: {},
          participationCeiling: {
            kind: "send",
            sessionKey: "agent:main:original",
            profileId: "guest",
            permission: "workspace",
            execPolicy: intersectExecPolicyCeilings(
              { security: "allowlist", ask: "off" },
              { security: "full", ask },
            ),
          },
        }),
        autoReviewer: reviewer,
      });
      const result = await tool.execute("denied-miss", {
        command: nodeCommand('console.log("forbidden")'),
      });
      expect(result.details).toMatchObject({ status: "failed", exitCode: null, durationMs: 0 });
      expect(result.content).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ text: expect.stringContaining("participant-allowlist-miss") }),
        ]),
      );
      expect(reviewer).not.toHaveBeenCalled();
    },
  );

  it("keeps temporary files in the checkout scratch root when exec changes directory", async () => {
    const result = await createExecTool().execute("coding-scratch", {
      command: nodeCommand(
        'const fs=require("node:fs"),os=require("node:os"),path=require("node:path");const file=path.join(fs.mkdtempSync(path.join(os.tmpdir(),"validation-")),"proof");fs.writeFileSync(file,"scratch");console.log(JSON.stringify({file,tmp:process.env.TMP,temp:process.env.TEMP}));',
      ),
      workdir: "nested",
    });
    expect(result.details).toMatchObject({ status: "completed", exitCode: 0 });
    const output = result.content.find((entry) => entry.type === "text")?.text;
    const created = JSON.parse(output!);
    const scratch = path.join(fs.realpathSync(codingRoot), ".openclaw", "tmp");
    expect(path.dirname(path.dirname(created.file))).toBe(scratch);
    expect(created).toMatchObject({ tmp: scratch, temp: scratch });
    expect(fs.readFileSync(created.file, "utf8")).toBe("scratch");
  });

  it("forwards sandbox cleanup custody through the builtin exec tool", async () => {
    const terminate = vi.fn(async () => {});
    const finalizeExec = vi.fn(async () => {});
    const backend: SandboxBackendHandle = {
      id: "docker",
      runtimeId: "coding-cleanup",
      runtimeLabel: "coding-cleanup",
      workdir: "/workspace",
      prepareProcessCleanup(env) {
        return {
          env: { ...env, CODEX_SANDBOX_EXEC_ID: this.runtimeId },
          terminate,
          interrupt: async () => false,
        };
      },
      buildExecSpec: async ({ env }) => ({
        argv: [process.execPath, "-p", "process.env.CODEX_SANDBOX_EXEC_ID ?? 'missing'"],
        env,
        cwd: codingRoot,
        stdinMode: "pipe-closed",
      }),
      finalizeExec,
      runShellCommand: async () => ({ code: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }),
    };
    const sandbox = createSandboxTestContext({
      overrides: {
        workspaceDir: codingRoot,
        agentWorkspaceDir: codingRoot,
        backend,
        fsBridge: createHostSandboxFsBridge(codingRoot),
      },
    });
    sandbox.fsPreparation = await prepareSandboxFsContext(sandbox);
    let tool: ReturnType<typeof createExecTool>;
    {
      using lstat = vi.spyOn(fs, "lstatSync");
      using exists = vi.spyOn(fs, "existsSync");
      using realpath = vi.spyOn(fs.realpathSync, "native");
      tool = createExecTool(sandbox);
      expect(lstat).not.toHaveBeenCalled();
      expect(exists).not.toHaveBeenCalled();
      expect(realpath).not.toHaveBeenCalled();
    }
    const result = await tool.execute("coding-cleanup", { command: "fixture" });
    expect(result.details).toMatchObject({ status: "completed", exitCode: 0 });
    expect(result.content.find((entry) => entry.type === "text")?.text.trim()).toBe(
      "coding-cleanup",
    );
    expect(finalizeExec).toHaveBeenCalledOnce();
    expect(terminate).not.toHaveBeenCalled();
  });
});
