import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { saveExecApprovals } from "../infra/exec-approvals.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { resetProcessRegistryForTests } from "./bash-process-registry.test-support.js";
import { createCoreCodingTools } from "./core-coding-tools.js";

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

  it.each([
    { workdir: undefined, directory: "workspace", pty: false },
    { workdir: ".", directory: "workspace", pty: false },
    { workdir: ".", directory: "workspace", pty: true },
    { workdir: "nested", directory: "workspace/nested", pty: false },
    { workdir: "~", directory: "workspace/~", pty: false },
    { workdir: "../sibling", directory: "sibling", pty: false },
    { workdir: "absolute", directory: "sibling", pty: false },
  ])("executes in $directory for workdir=$workdir (PTY=$pty)", async (testCase) => {
    expect(fs.realpathSync(process.cwd())).not.toBe(codingRoot);
    const tools = createCoreCodingTools({
      codingRoot,
      containmentRoot: codingRoot,
      includeBaseCodingTools: false,
      shellTools: "full",
      workspaceOnly: false,
      readOnly: false,
      applyPatchEnabled: false,
      applyPatchWorkspaceOnly: true,
      execDefaults: {
        host: "gateway",
        mode: "full",
        allowBackground: false,
        notifyOnExit: false,
        config: { plugins: { enabled: false } },
      },
      processDefaults: {},
    });
    const exec = tools.find((tool) => tool.name === "exec");
    if (!exec) {
      throw new Error("Expected the coding exec tool");
    }
    const workdir = testCase.workdir === "absolute" ? path.join(root, "sibling") : testCase.workdir;
    const result = await exec.execute("coding-workdir", {
      command: process.platform === "win32" ? "(Get-Location).Path" : "pwd -P",
      workdir,
      pty: testCase.pty,
    });
    const expectedCwd = fs.realpathSync(path.join(root, testCase.directory));
    expect(result.details).toMatchObject({ status: "completed", exitCode: 0, cwd: expectedCwd });
    const output = result.content.find((content) => content.type === "text")?.text;
    expect(output?.trim()).toBe(expectedCwd);
  });
});
