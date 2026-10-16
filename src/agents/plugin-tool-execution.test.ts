import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../test/helpers/promise.js";
import type { SkillSnapshot } from "../skills/types.js";
import { createAdmittedRunOperatorAuthority } from "./admitted-run-context.js";
import { resolveSandboxSkillRuntimeInputs } from "./embedded-agent-runner/sandbox-skills.js";
import { preparePluginToolExecutionCapabilities } from "./plugin-tool-execution.js";
import { resolveSandboxConfigForAgent } from "./sandbox/config.js";
import { createSandboxFsBridge } from "./sandbox/fs-bridge.js";
import { bindLocalSandboxWorkspace } from "./sandbox/local-workspace.js";
import { createRemoteShellSandboxBackend } from "./sandbox/remote-shell-backend.js";
import { createAgentToolsSandboxContext } from "./test-helpers/agent-tools-sandbox-context.js";

const run = vi.hoisted(() => vi.fn());
// mock-isolation: Keep host processes outside this command-lifecycle fixture.
vi.mock("../process/exec.js", () => ({ runCommandWithTimeout: run }));
const roots: string[] = [];
beforeEach(() => {
  run.mockReset();
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
    capabilities: { readOnlyResourceMounts: true },
    workdir: "/guest/repo",
    buildExecSpec: build,
    runShellCommand: vi.fn(),
    finalizeExec: finalize,
    prepareProcessCleanup: (env) => ({ env, terminate, interrupt: async () => false }),
  };
  const snapshot: SkillSnapshot = {
    prompt: "",
    skills: [
      {
        name: "autoreview",
        source: {
          filePath: sourceFile,
          fileHost: source === "openclaw-managed" ? "gateway" : "workspace",
        },
      },
    ],
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
  return { sandbox, backend: sandbox.backend, snapshot, build, terminate, finalize };
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

it("retains selected installation identity after sandbox prompt remapping and budgeting", () => {
  const fixture = sandboxFixture();
  fixture.snapshot.discoverySkills = fixture.snapshot.resolvedSkills;
  fixture.snapshot.resolvedSkills = [];
  const prepared = resolveSandboxSkillRuntimeInputs({
    sandbox: fixture.sandbox,
    skillsAnchorWorkspace: fixture.sandbox.workspaceDir,
    skillsSnapshot: fixture.snapshot,
  });
  expect(prepared.skillsSnapshot?.discoverySkills?.[0]?.filePath).toBe(
    "/guest/repo/skills/autoreview/SKILL.md",
  );
  const capability = preparePluginToolExecutionCapabilities({
    sandbox: fixture.sandbox,
    skillsSnapshot: prepared.skillsSnapshot,
  })(() => {});
  expect(capability.sandbox?.installedSkillRoots).toEqual({
    autoreview: "/guest/repo/skills/autoreview",
  });
  fixture.snapshot.skills[0]!.source!.fileHost = "workspace";
  const shadow = preparePluginToolExecutionCapabilities({
    sandbox: fixture.sandbox,
    skillsSnapshot: prepared.skillsSnapshot,
  })(() => {});
  expect(shadow.sandbox?.installedSkillRoots).toEqual({});
});

it("withholds protected installations on the SSH backend's mutable upload view", async () => {
  const fixture = sandboxFixture();
  fixture.sandbox.backend = await createRemoteShellSandboxBackend(
    {
      sessionKey: "review-fixture",
      scopeKey: "review-fixture",
      workspaceDir: fixture.sandbox.workspaceDir,
      agentWorkspaceDir: fixture.sandbox.agentWorkspaceDir,
      cfg: resolveSandboxConfigForAgent({
        agents: {
          defaults: {
            sandbox: {
              backend: "ssh",
              workspaceAccess: "none",
              ssh: { target: "unused", workspaceRoot: "/remote" },
            },
          },
        },
      }),
    },
    {
      createSession: async () => {
        throw new Error("No transport should run");
      },
      preprovisionedWorkdir: { runtimeId: "review-fixture", remoteWorkspaceDir: "/guest/repo" },
    },
  );
  const capability = preparePluginToolExecutionCapabilities({
    sandbox: fixture.sandbox,
    skillsSnapshot: fixture.snapshot,
  })(() => {});
  expect(capability.sandbox?.installedSkillRoots).toEqual({});
});

it.each(["/guest/repo/skills", "/guest/repo/skills/autoreview/scripts"])(
  "withholds a protected installation hidden by tmpfs at %s",
  (overlay) => {
    const fixture = sandboxFixture();
    fixture.sandbox.docker.tmpfs = [`${overlay}:rw`];
    const capability = preparePluginToolExecutionCapabilities({
      sandbox: fixture.sandbox,
      skillsSnapshot: fixture.snapshot,
    })(() => {});
    expect(capability.sandbox?.installedSkillRoots).toEqual({});
  },
);

it("rejects a writable workspace alias while preserving a read-only alias", () => {
  const fixture = sandboxFixture();
  const source = fixture.sandbox.workspaceDir;
  const installedRoots = () =>
    preparePluginToolExecutionCapabilities({
      sandbox: fixture.sandbox,
      skillsSnapshot: fixture.snapshot,
    })(() => {}).sandbox?.installedSkillRoots;
  fixture.sandbox.docker.binds = [`${source}:/alias:rw`];
  expect(installedRoots()).toEqual({});
  fixture.sandbox.docker.binds = [`${source}:/alias:ro`];
  expect(installedRoots()).toEqual({ autoreview: "/guest/repo/skills/autoreview" });
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

it("releases managed workspace admission while the helper waits for exchange commands", async () => {
  const fixture = sandboxFixture();
  const output = { termination: "exit", code: 0, stdout: "complete", stderr: "" } as const;
  const helper = createDeferred<typeof output>();
  const entered = createDeferred();
  run
    .mockImplementationOnce(async () => {
      entered.resolve();
      return await helper.promise;
    })
    .mockResolvedValue(output);
  let admitted = false;
  let retained = 0;
  fixture.sandbox.fsBridge = createSandboxFsBridge({
    sandbox: { ...fixture.sandbox, backend: fixture.backend },
  });
  bindLocalSandboxWorkspace(fixture.sandbox, {
    workspaceDir: fixture.sandbox.workspaceDir,
    workspaceCwd: fixture.sandbox.workspaceDir,
    assertCurrent() {},
    retain() {
      retained++;
      return () => {
        retained--;
      };
    },
    async provision(action) {
      if (admitted) {
        throw new Error("workspace reconciliation is already held");
      }
      admitted = true;
      try {
        return await action();
      } finally {
        admitted = false;
      }
    },
    async checkpoint() {},
    [Symbol.dispose]() {},
  });
  const capability = preparePluginToolExecutionCapabilities({ sandbox: fixture.sandbox })(() => {});
  const pending = capability.sandbox!.run({ argv: ["helper"] });
  try {
    await awaitGateBeforeSettlement(entered.promise, pending, "helper did not launch");
    expect(admitted).toBe(false);
    expect(retained).toBe(1);
    await expect(capability.sandbox!.run({ argv: ["exchange-command"] })).resolves.toMatchObject({
      code: 0,
    });
  } finally {
    helper.resolve(output);
    await pending;
  }
  expect(retained).toBe(0);
});

it("selects the permitted default before execution and holds its current authority", async () => {
  let allowed = true;
  let changed: (() => void) | undefined;
  const authority = createAdmittedRunOperatorAuthority({
    profileId: "caller",
    scopes: [],
    assertCurrent() {},
    modelPolicy: {
      models: [{ provider: "fixture", model: "default" }],
      allows: (model) => allowed && model.model === "default",
    },
    onModelPolicyChanged: (callback) => {
      changed = callback;
      return () => {
        changed = undefined;
      };
    },
  });
  const capability = preparePluginToolExecutionCapabilities({
    authority,
    agentId: "caller",
    config: { agents: { entries: { caller: { model: "fixture/default" } } } },
  })(() => {});
  expect(capability.modelExecution?.cliEntryPath).toBe(
    path.resolve(import.meta.dirname, "../../openclaw.mjs"),
  );
  const action = vi.fn(async ({ model, agentId }: { model: string; agentId: string }) => ({
    model,
    agentId,
  }));
  await expect(
    capability.modelExecution!.run({ model: "fixture/preferred", explicit: true }, action),
  ).rejects.toThrow("cannot use this model");
  expect(action).not.toHaveBeenCalled();
  await expect(
    capability.modelExecution!.run({ model: "fixture/preferred", explicit: false }, action),
  ).resolves.toEqual({ model: "fixture/default", agentId: "caller" });
  await expect(
    capability.modelExecution!.run({ model: null, explicit: false }, async ({ signal, model }) => {
      expect(model).toBe("fixture/default");
      allowed = false;
      changed?.();
      expect(signal.aborted).toBe(true);
      return "discarded";
    }),
  ).rejects.toThrow("cannot use this model");
  expect(changed).toBeUndefined();
  await expect(
    capability.modelExecution!.run({ model: "fixture/preferred", explicit: false }, action),
  ).rejects.toThrow("cannot use this model");
});

it("keeps an allowed canonical model and refuses an empty permitted selection", async () => {
  const make = (models: { provider: string; model: string }[], allow?: string[]) =>
    preparePluginToolExecutionCapabilities({
      agentId: "caller",
      config: {
        agents: {
          entries: {
            caller: { model: "fixture/default", ...(allow ? { modelPolicy: { allow } } : {}) },
          },
        },
      },
      authority: createAdmittedRunOperatorAuthority({
        profileId: "caller",
        scopes: [],
        assertCurrent() {},
        modelPolicy: {
          models,
          allows: (ref) =>
            models.some((model) => model.provider === ref.provider && model.model === ref.model),
        },
      }),
    })(() => {}).modelExecution!;
  await expect(
    make([{ provider: "fixture", model: "preferred" }]).run(
      { model: "fixture/preferred", explicit: false },
      async ({ model }) => model,
    ),
  ).resolves.toBe("fixture/preferred");
  await expect(
    make(
      [
        { provider: "fixture", model: "preferred" },
        { provider: "fixture", model: "default" },
      ],
      ["fixture/default"],
    ).run({ model: "fixture/preferred", explicit: false }, async ({ model }) => model),
  ).resolves.toBe("fixture/default");
  const action = vi.fn(async () => "must not execute");
  await expect(
    make([]).run({ model: "fixture/preferred", explicit: false }, action),
  ).rejects.toThrow("No permitted reviewer model");
  expect(action).not.toHaveBeenCalled();
});
