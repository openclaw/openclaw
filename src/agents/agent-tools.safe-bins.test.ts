import os from "node:os";
import "../test-utils/prepare-compiled-subprocesses.js";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/config.js";
import { withEnvAsync } from "../test-utils/env.js";
import { resetProcessRegistryForTests } from "./bash-process-registry.test-support.js";
import { createRunExit } from "./bash-tools.exec-runtime.test-support.js";
import { createOpenClawOnlyToolConstructionPlan } from "./test-helpers/tool-construction-plan.js";

let createOpenClawCodingTools: typeof import("./agent-tools.js").createOpenClawCodingTools;

const { mockExecApprovals, supervisorSpawnMock } = await vi.hoisted(async () => {
  const { resolveExecApprovalsFromFileInternal } =
    await import("../infra/exec-approvals-resolver.js");
  const approvals = resolveExecApprovalsFromFileInternal({
    path: "/tmp/exec-approvals.json",
    file: {
      version: 1,
      socket: { path: "/tmp/exec-approvals.sock", token: "token" },
      defaults: { security: "allowlist", ask: "off", askFallback: "deny", autoAllowSkills: false },
      agents: {},
    },
  });
  return {
    mockExecApprovals: approvals,
    supervisorSpawnMock: vi.fn(
      async (input: { argv?: string[]; onStdout?: (chunk: string) => void }) => {
        input.onStdout?.(`${input.argv?.join(" ") ?? ""}\n`);
        return {
          activity: { resultSettled: true, lastOutputAtMs: Date.now() },
          runId: "safe-bins-test-run",
          pid: 1234,
          startedAtMs: Date.now(),
          stdin: undefined,
          wait: async () => createRunExit(),
          cancel: vi.fn(),
        };
      },
    ),
  };
});

beforeAll(async () => {
  await withEnvAsync(
    {
      OPENCLAW_BUNDLED_PLUGINS_DIR: path.join(os.tmpdir(), "openclaw-test-no-bundled-extensions"),
    },
    async () => {
      ({ createOpenClawCodingTools } = await import("./agent-tools.js"));
    },
  );
});

beforeEach(() => {
  supervisorSpawnMock.mockClear();
});

vi.mock("../infra/shell-env.js", async () => {
  const mod =
    await vi.importActual<typeof import("../infra/shell-env.js")>("../infra/shell-env.js");
  return {
    ...mod,
    getShellPathFromLoginShell: vi.fn(() => null),
    resolveShellEnvFallbackTimeoutMs: vi.fn(() => 50),
  };
});

vi.mock("../process/supervisor/index.js", () => ({
  getProcessSupervisor: () => ({
    spawn: supervisorSpawnMock,
    cancel: vi.fn(),
    cancelScope: vi.fn(),
  }),
}));

vi.mock("../infra/exec-approvals.js", async () => {
  const mod = await vi.importActual<typeof import("../infra/exec-approvals.js")>(
    "../infra/exec-approvals.js",
  );
  const approvals = mockExecApprovals;
  return {
    ...mod,
    loadExecApprovalsReadOnlyAsync: async () => approvals.file,
    resolveExecApprovals: () => approvals,
    resolveExecApprovalsLocked: async () => approvals,
  };
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(resetProcessRegistryForTests);

describe("createOpenClawCodingTools safeBins", () => {
  it.each([true, false])("requires a custom safe-bin profile (configured=%s)", async (profiled) => {
    if (process.platform === "win32") {
      return;
    }
    const tmpDir = tempDirs.make("openclaw-safe-bins-");
    const config: OpenClawConfig = {
      tools: {
        exec: {
          host: "gateway",
          mode: "allowlist",
          safeBins: ["echo"],
          ...(profiled ? { safeBinProfiles: { echo: { maxPositional: 1 } } } : {}),
        },
      },
    };
    const execTool = createOpenClawCodingTools({
      config,
      toolConstructionPlan: {
        ...createOpenClawOnlyToolConstructionPlan(),
        includeShellTools: true,
        includeOpenClawTools: false,
      },
      exec: { notifyOnExit: false },
      sessionKey: "agent:main:main",
      workspaceDir: tmpDir,
      agentDir: path.join(tmpDir, "agent"),
    }).find((tool) => tool.name === "exec");
    if (!execTool) {
      throw new Error("exec tool missing from coding tools");
    }
    await withEnvAsync(
      { OPENCLAW_SHELL_ENV_TIMEOUT_MS: "1", PATH: "/usr/bin:/bin", SHELL: "/bin/sh" },
      async () => {
        const result = execTool.execute("safe-bin", {
          command: "echo safe-bins-marker",
          workdir: tmpDir,
        });
        if (profiled) {
          const completed = await result;
          expect(completed).toMatchObject({ details: { status: "completed" } });
          expect(completed.content.find((block) => block.type === "text")?.text).toContain(
            "safe-bins-marker",
          );
          expect(supervisorSpawnMock).toHaveBeenCalledOnce();
        } else {
          await expect(result).rejects.toThrow("exec denied: allowlist miss");
          expect(supervisorSpawnMock).not.toHaveBeenCalled();
        }
      },
    );
  });
});
