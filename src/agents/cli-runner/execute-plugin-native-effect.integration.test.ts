import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { CliBackendToolPermissionResult } from "../../plugins/cli-backend.types.js";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../../plugins/hook-runner-global.js";
import type { PluginHookHandlerMap } from "../../plugins/hook-types.js";
import { createMockPluginRegistry } from "../../plugins/hooks.test-fixtures.js";
import {
  closePluginTestAdmissions,
  createExecution,
  runPlugin,
  SUCCESS_RESULT,
} from "./execute-plugin.test-support.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  resetGlobalHookRunner();
  closePluginTestAdmissions();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function runNativeWrite(params: {
  config: OpenClawConfig;
  modelProvider?: string;
  runtimePolicySessionKey?: string;
  rewritePath?: string;
  relativePath?: boolean;
  useOutsideCwd?: boolean;
  nativeCwdSuffix?: string;
  distinctPolicyWorkspace?: boolean;
  targetPolicyWorkspace?: boolean;
  rewriteToPolicyWorkspace?: boolean;
}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "openclaw-native-policy-proof-"));
  roots.push(root);
  const workspace = path.join(root, "workspace");
  await mkdir(workspace);
  const policyWorkspace = path.join(root, "policy-workspace");
  await mkdir(policyWorkspace);
  const config = params.distinctPolicyWorkspace
    ? {
        ...params.config,
        agents: {
          entries: {
            main: { workspace, tools: { profile: "full" as const } },
            worker: {
              workspace: policyWorkspace,
              tools: { allow: ["write"], fs: { workspaceOnly: true } },
            },
          },
        },
      }
    : params.config;
  const nativeCwd = params.useOutsideCwd
    ? path.join(root, "outside")
    : `${workspace}${params.nativeCwdSuffix ?? ""}`;
  await mkdir(nativeCwd, { recursive: true });
  const target = path.join(
    params.targetPolicyWorkspace ? policyWorkspace : nativeCwd,
    "native-effect.txt",
  );
  const rewrittenTarget = params.rewriteToPolicyWorkspace
    ? path.join(policyWorkspace, "rewritten-effect.txt")
    : params.rewritePath;
  if (rewrittenTarget) {
    const rewritePath = rewrittenTarget;
    const handler: PluginHookHandlerMap["before_tool_call"] = async (event) => ({
      params: { ...event.params, path: rewritePath },
    });
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        {
          hookName: "before_tool_call",
          matcher: ["write"],
          handler: (...args) => Reflect.apply(handler, undefined, args),
        },
      ]),
    );
  }
  const { context } = await createExecution({
    config,
    nativeTools: ["Write"],
    workspaceDir: workspace,
  });
  context.params.modelProvider = params.modelProvider;
  context.params.runtimePolicySessionKey = params.distinctPolicyWorkspace
    ? "agent:worker:main"
    : params.runtimePolicySessionKey;
  let nativeLaunches = 0;
  let decision: CliBackendToolPermissionResult | undefined;
  const input = {
    file_path: params.relativePath ? path.basename(target) : target,
    content: "native effect\n",
  };

  const exit = await runPlugin(context, async function* (execution) {
    decision = await execution.requestToolPermission({
      toolName: "Write",
      toolInput: input,
      toolCallId: "process-backed-native-write",
      cwd: nativeCwd,
      abortSignal: execution.abortSignal,
    });
    if (decision.behavior === "allow") {
      const finalInput = decision.updatedInput ?? input;
      nativeLaunches++;
      await execFileAsync(
        process.execPath,
        [
          "-e",
          "const fs=require('node:fs');const i=JSON.parse(process.argv[1]);fs.writeFileSync(i.file_path,i.content)",
          JSON.stringify(finalInput),
        ],
        { cwd: nativeCwd },
      );
    }
    yield SUCCESS_RESULT;
  });
  return {
    decision,
    exit,
    root,
    target,
    workspace,
    policyWorkspace,
    rewrittenTarget,
    nativeLaunches,
  };
}

async function expectMissing(filePath: string) {
  await expect(access(filePath)).rejects.toThrow();
}

describe("process-backed native CLI final-effect policy", () => {
  it.each([
    {
      name: "admitted execution root",
      targetPolicyWorkspace: false,
      rewriteToPolicyWorkspace: false,
      useOutsideCwd: false,
      allowed: true,
    },
    {
      name: "distinct policy root",
      targetPolicyWorkspace: true,
      rewriteToPolicyWorkspace: false,
      useOutsideCwd: false,
      allowed: false,
    },
    {
      name: "outside sibling root",
      targetPolicyWorkspace: false,
      rewriteToPolicyWorkspace: false,
      useOutsideCwd: true,
      allowed: false,
    },
    {
      name: "hook rewrite to policy root",
      targetPolicyWorkspace: false,
      rewriteToPolicyWorkspace: true,
      useOutsideCwd: false,
      allowed: false,
    },
  ])("observes mixed-agent Write final effects for $name", async (testCase) => {
    // Characterize the current execution-root contract, not owner acceptance.
    const proof = await runNativeWrite({
      ...testCase,
      distinctPolicyWorkspace: true,
      config: { tools: { exec: { security: "full", ask: "off" } } },
    });
    expect(proof.workspace).not.toBe(proof.policyWorkspace);
    expect(proof.nativeLaunches).toBe(testCase.allowed ? 1 : 0);
    if (testCase.allowed) {
      expect(proof.decision).toMatchObject({ behavior: "allow" });
      expect(await readFile(proof.target, "utf8")).toBe("native effect\n");
    } else {
      expect(proof.decision).toEqual({
        behavior: "deny",
        message: expect.stringMatching(/^Path escapes sandbox root/),
      });
      await expectMissing(proof.target);
    }
    if (proof.rewrittenTarget) {
      await expectMissing(proof.rewrittenTarget);
    }
  });
  it("allows a full-profile write and denies the same real effect after a restrictive upgrade", async () => {
    const allowed = await runNativeWrite({
      config: {
        tools: {
          profile: "full",
          fs: { workspaceOnly: true },
          exec: { security: "full", ask: "off" },
        },
      },
      relativePath: true,
    });
    expect(await readFile(allowed.target, "utf8")).toBe("native effect\n");
    expect(allowed.decision).toMatchObject({ behavior: "allow" });

    const denied = await runNativeWrite({
      config: { tools: { profile: "minimal", exec: { security: "full", ask: "off" } } },
    });
    await expectMissing(denied.target);
    expect(denied.decision).toMatchObject({ behavior: "deny" });
  });

  it.each([
    {
      name: "selected provider",
      config: {
        tools: {
          profile: "full",
          byProvider: { anthropic: { deny: ["write"] } },
          exec: { security: "full", ask: "off" },
        },
      } satisfies OpenClawConfig,
      modelProvider: "anthropic",
    },
    {
      name: "runtime policy session",
      config: {
        agents: {
          entries: {
            main: { tools: { profile: "full" } },
            worker: { tools: { profile: "minimal" } },
          },
        },
        tools: { exec: { security: "full", ask: "off" } },
      } satisfies OpenClawConfig,
      runtimePolicySessionKey: "agent:worker:main",
    },
  ])("denies the final effect for $name policy", async (testCase) => {
    const proof = await runNativeWrite(testCase);
    await expectMissing(proof.target);
    expect(proof.decision).toMatchObject({ behavior: "deny" });
  });

  it("denies a relative native path resolved from the client's outside cwd", async () => {
    const proof = await runNativeWrite({
      config: {
        tools: {
          profile: "full",
          fs: { workspaceOnly: true },
          exec: { security: "full", ask: "off" },
        },
      },
      relativePath: true,
      useOutsideCwd: true,
    });
    await expectMissing(proof.target);
    expect(proof.decision).toEqual({
      behavior: "deny",
      message: expect.stringMatching(/^Path escapes sandbox root/),
    });
  });

  it("denies a relative native path from a whitespace-suffixed sibling cwd", async () => {
    const proof = await runNativeWrite({
      config: {
        tools: {
          profile: "full",
          fs: { workspaceOnly: true },
          exec: { security: "full", ask: "off" },
        },
      },
      relativePath: true,
      nativeCwdSuffix: " ",
    });
    await expectMissing(proof.target);
    expect(proof.decision).toEqual({
      behavior: "deny",
      message: expect.stringMatching(/^Path escapes sandbox root/),
    });
  });

  it("denies a hook-rewritten outside-workspace path before native I/O", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "openclaw-native-outside-proof-"));
    roots.push(root);
    const outside = path.join(root, "outside.txt");
    const proof = await runNativeWrite({
      config: {
        tools: {
          profile: "full",
          fs: { workspaceOnly: true },
          exec: { security: "full", ask: "off" },
        },
      },
      rewritePath: outside,
    });
    await expectMissing(proof.target);
    await expectMissing(outside);
    expect(proof.decision).toEqual({
      behavior: "deny",
      message: expect.stringMatching(/^Path escapes sandbox root/),
    });
  });
});
