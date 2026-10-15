import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { SkillSnapshot } from "../skills/types.js";
import { createAdmittedRunOperatorAuthority } from "./admitted-run-context.js";
import { preparePluginToolExecutionCapabilities } from "./plugin-tool-execution.js";
import { createAgentToolsSandboxContext } from "./test-helpers/agent-tools-sandbox-context.js";

const run = vi.hoisted(() => vi.fn());
const resolveModel = vi.hoisted(() => vi.fn());
vi.mock("../process/exec.js", () => ({ runCommandWithTimeout: run }));
vi.mock("./embedded-agent-runner/model.js", () => ({ resolveModelAsync: resolveModel }));
const roots: string[] = [];
beforeEach(() => {
  run.mockReset();
  resolveModel.mockReset();
});
afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function sandboxFixture(source = "openclaw-managed") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-plugin-sandbox-"));
  roots.push(root);
  const skillDir = path.join(root, "skills", "autoreview");
  fs.mkdirSync(skillDir, { recursive: true });
  const sourceFile = "/managed/autoreview/SKILL.md";
  const sandbox = createAgentToolsSandboxContext({
    workspaceDir: root,
    agentWorkspaceDir: root,
    containerWorkdir: "/guest/repo",
    workspaceAccess: "none",
  });
  sandbox.skillUsagePaths = [
    {
      readPath: path.join(skillDir, "SKILL.md"),
      skillFile: sourceFile,
      skillName: "autoreview",
      skillSource: "workspace",
    },
  ];
  const finalize = vi.fn();
  const terminate = vi.fn();
  const build = vi.fn(async () => ({
    argv: ["fixed-sandbox-transport"],
    env: {},
    stdinMode: "pipe-closed" as const,
  }));
  sandbox.backend = {
    id: "fixture",
    runtimeId: "caller-sandbox",
    runtimeLabel: "Caller sandbox",
    workdir: "/guest/repo",
    buildExecSpec: build,
    runShellCommand: vi.fn(),
    finalizeExec: finalize,
    prepareProcessCleanup: (env) => ({ env, terminate, interrupt: async () => false }),
  };
  const snapshot: SkillSnapshot = {
    prompt: "",
    skills: [],
    resolvedSkills: [
      {
        name: "autoreview",
        description: "Review",
        baseDir: "/managed/autoreview",
        filePath: sourceFile,
        source,
        fileHost: source === "openclaw-managed" ? "gateway" : "workspace",
        sourceInfo: { path: sourceFile, source, scope: "user", origin: "top-level" },
        disableModelInvocation: false,
      },
    ],
  };
  return { sandbox, snapshot, build, terminate, finalize };
}

it("exposes only the selected installed skill inside the actual protected sandbox mount", () => {
  const fixture = sandboxFixture();
  const capability = preparePluginToolExecutionCapabilities({
    sandbox: fixture.sandbox,
    skillsSnapshot: fixture.snapshot,
  })(() => {});
  expect(capability.sandbox?.workspaceDir).toBe("/guest/repo");
  expect(capability.sandbox?.installedSkillRoots).toEqual({
    autoreview: "/guest/repo/skills/autoreview",
  });
  fixture.snapshot.resolvedSkills![0]!.source = "openclaw-workspace";
  const shadow = preparePluginToolExecutionCapabilities({
    sandbox: fixture.sandbox,
    skillsSnapshot: fixture.snapshot,
  })(() => {});
  expect(shadow.sandbox?.installedSkillRoots).toEqual({});
  fixture.snapshot.resolvedSkills![0]!.source = "openclaw-managed";
  fixture.sandbox.docker.binds = ["/untrusted:/guest/repo/skills/autoreview/scripts:rw"];
  const overlaid = preparePluginToolExecutionCapabilities({
    sandbox: fixture.sandbox,
    skillsSnapshot: fixture.snapshot,
  })(() => {});
  expect(overlaid.sandbox?.installedSkillRoots).toEqual({});
});

it("refuses a retained command if invocation closes during backend preparation", async () => {
  const fixture = sandboxFixture();
  const prepared = createDeferred();
  let active = true;
  fixture.build.mockImplementation(async () => {
    await prepared.promise;
    return { argv: ["fixed-sandbox-transport"], env: {}, stdinMode: "pipe-closed" };
  });
  const capability = preparePluginToolExecutionCapabilities({ sandbox: fixture.sandbox })(() => {
    if (!active) {
      throw new Error("retired");
    }
  });
  const pending = capability.sandbox!.run({ argv: ["trusted-helper", "literal; argument"] });
  active = false;
  prepared.resolve();
  await expect(pending).rejects.toThrow("retired");
  expect(run).not.toHaveBeenCalled();
  expect(fixture.terminate).toHaveBeenCalledOnce();
  expect(fixture.finalize).toHaveBeenCalledOnce();
});

it("joins only its owned sandbox cleanup when a command is cancelled", async () => {
  const fixture = sandboxFixture();
  run.mockResolvedValue({ termination: "signal", code: null, stdout: "", stderr: "" });
  const capability = preparePluginToolExecutionCapabilities({ sandbox: fixture.sandbox })(() => {});
  await expect(capability.sandbox!.run({ argv: ["trusted-helper"] })).rejects.toThrow("signal");
  expect(fixture.terminate).toHaveBeenCalledOnce();
  expect(fixture.finalize).toHaveBeenCalledOnce();
});

it("does not send input to a backend that explicitly closes stdin", async () => {
  const fixture = sandboxFixture();
  const capability = preparePluginToolExecutionCapabilities({ sandbox: fixture.sandbox })(() => {});
  await expect(
    capability.sandbox!.run({ argv: ["trusted-helper"], input: "complete response" }),
  ).rejects.toThrow("does not support piped");
  expect(run).not.toHaveBeenCalled();
  expect(fixture.finalize).toHaveBeenCalledOnce();
});

it("checks model authority before resolution and aborts the selected operation on revocation", async () => {
  let allowed = true;
  let changed: (() => void) | undefined;
  const authority = createAdmittedRunOperatorAuthority({
    profileId: "caller",
    scopes: [],
    assertCurrent: () => {},
    modelPolicy: {
      models: [{ provider: "fixture", model: "review" }],
      allows: (model) => allowed && model.model === "review",
    },
    onModelPolicyChanged: (callback) => {
      changed = callback;
      return () => {
        changed = undefined;
      };
    },
  });
  const capability = preparePluginToolExecutionCapabilities({ authority })(() => {});
  expect(capability.modelExecution?.cliEntryPath).toBe(
    path.resolve(import.meta.dirname, "../../openclaw.mjs"),
  );
  await expect(capability.modelExecution!.run("fixture/denied", async () => "bad")).rejects.toThrow(
    "cannot use this model",
  );
  expect(resolveModel).not.toHaveBeenCalled();
  resolveModel.mockResolvedValue({ model: { provider: "fixture", id: "review" } });
  await expect(
    capability.modelExecution!.run("fixture/review", async ({ signal }) => {
      allowed = false;
      changed?.();
      expect(signal.aborted).toBe(true);
      return "discarded";
    }),
  ).rejects.toThrow("cannot use this model");
  expect(changed).toBeUndefined();
});
