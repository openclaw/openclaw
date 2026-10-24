import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { SkillSnapshot } from "../skills/types.js";
import {
  createAdmittedRunOperatorAuthority,
  type AdmittedRunOperatorAuthority,
} from "./admitted-run-context.js";
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
const roots = useAutoCleanupTempDirTracker(afterEach);
beforeEach(() => run.mockReset());

function sandboxFixture(source = "openclaw-managed") {
  const root = roots.make("openclaw-plugin-sandbox-");
  const skillDir = path.join(root, "skills", "autoreview");
  fs.mkdirSync(skillDir, { recursive: true });
  const sourceFile = "/managed/autoreview/SKILL.md";
  const sandbox = createAgentToolsSandboxContext({
    workspaceDir: root,
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
  const selectedSource = { filePath: sourceFile, fileHost: "gateway" as const };
  const snapshot: SkillSnapshot = {
    prompt: "",
    skills: [{ name: "autoreview", source: selectedSource }],
    resolvedSkills: [
      {
        name: "autoreview",
        description: "Review",
        baseDir: "/managed/autoreview",
        filePath: sourceFile,
        source,
        fileHost: "gateway",
        sourceInfo: { path: sourceFile, source, scope: "user", origin: "top-level" },
        disableModelInvocation: false,
      },
    ],
  };
  const capabilities = (skillsSnapshot = snapshot) =>
    preparePluginToolExecutionCapabilities({ sandbox, skillsSnapshot })(() => {});
  const installedRoots = (skillsSnapshot = snapshot) =>
    capabilities(skillsSnapshot).sandbox?.installedSkillRoots;
  return { sandbox, snapshot, build, terminate, finalize, capabilities, installedRoots };
}

function modelExecution(
  models: string[],
  options: Pick<AdmittedRunOperatorAuthority, "onModelPolicyChanged"> & {
    allows?: () => boolean;
    allow?: string[];
  } = {},
) {
  const caller = {
    model: "fixture/default",
    ...(options.allow ? { modelPolicy: { allow: options.allow } } : {}),
  };
  return preparePluginToolExecutionCapabilities({
    agentId: "caller",
    config: { agents: { entries: { caller } } },
    authority: createAdmittedRunOperatorAuthority({
      profileId: "caller",
      scopes: [],
      assertCurrent() {},
      onModelPolicyChanged: options.onModelPolicyChanged,
      modelPolicy: {
        models: models.map((model) => ({ provider: "fixture", model })),
        allows: (ref) =>
          ref.provider === "fixture" && models.includes(ref.model) && (options.allows?.() ?? true),
      },
    }),
  })(() => {}).modelExecution!;
}

it.each(["openclaw-managed", "openclaw-library", "openclaw-bundled", "agents-skills-personal"])(
  "exposes the selected %s skill only inside the actual protected sandbox mount",
  (source) => {
    const fixture = sandboxFixture(source);
    const capability = fixture.capabilities();
    expect(capability.sandbox?.workspaceDir).toBe("/guest/repo");
    expect(capability.sandbox?.installedSkillRoots).toEqual({
      autoreview: "/guest/repo/skills/autoreview",
    });
    fixture.snapshot.resolvedSkills![0]!.source = "openclaw-workspace";
    expect(fixture.installedRoots()).toEqual({});
    fixture.snapshot.resolvedSkills![0]!.source = source;
    fixture.sandbox.docker.binds = ["/untrusted:/guest/repo/skills/autoreview/scripts:rw"];
    expect(fixture.installedRoots()).toEqual({});
  },
);

it("retains selected installation identity after sandbox prompt remapping and budgeting", () => {
  const { sandbox, snapshot, installedRoots } = sandboxFixture();
  snapshot.discoverySkills = snapshot.resolvedSkills;
  snapshot.resolvedSkills = [];
  const prepared = resolveSandboxSkillRuntimeInputs({
    sandbox,
    skillsAnchorWorkspace: sandbox.workspaceDir,
    skillsSnapshot: snapshot,
  });
  expect(prepared.skillsSnapshot?.discoverySkills?.[0]?.filePath).toBe(
    "/guest/repo/skills/autoreview/SKILL.md",
  );
  expect(installedRoots(prepared.skillsSnapshot)).toEqual({
    autoreview: "/guest/repo/skills/autoreview",
  });
  snapshot.skills[0]!.source!.fileHost = "workspace";
  expect(installedRoots(prepared.skillsSnapshot)).toEqual({});
});

it("withholds protected installations on the SSH backend's mutable upload view", async () => {
  const fixture = sandboxFixture();
  const cfg = resolveSandboxConfigForAgent();
  cfg.backend = "ssh";
  cfg.ssh.target = "unused";
  cfg.ssh.workspaceRoot = "/remote";
  fixture.sandbox.backend = await createRemoteShellSandboxBackend(
    {
      sessionKey: "review-fixture",
      scopeKey: "review-fixture",
      workspaceDir: fixture.sandbox.workspaceDir,
      agentWorkspaceDir: fixture.sandbox.agentWorkspaceDir,
      cfg,
    },
    {
      createSession: async () => {
        throw new Error("No transport should run");
      },
      preprovisionedWorkdir: { runtimeId: "review-fixture", remoteWorkspaceDir: "/guest/repo" },
    },
  );
  expect(fixture.installedRoots()).toEqual({});
});

it.each(["/guest/repo/skills", "/guest/repo/skills/autoreview/scripts"])(
  "withholds a protected installation hidden by tmpfs at %s",
  (overlay) => {
    const fixture = sandboxFixture();
    fixture.sandbox.docker.tmpfs = [`${overlay}:rw`];
    expect(fixture.installedRoots()).toEqual({});
  },
);

it("rejects a writable workspace alias while preserving a read-only alias", () => {
  const fixture = sandboxFixture();
  const source = fixture.sandbox.workspaceDir;
  fixture.sandbox.docker.binds = [`${source}:/alias:rw`];
  expect(fixture.installedRoots()).toEqual({});
  fixture.sandbox.docker.binds = [`${source}:/alias:ro`];
  expect(fixture.installedRoots()).toEqual({ autoreview: "/guest/repo/skills/autoreview" });
});

it.each([
  { kind: "retired", error: "retired" },
  { kind: "cancelled", error: "signal" },
  { kind: "stdin", error: "does not support piped" },
])("finalizes owned command resources after $kind rejection", async ({ kind, error }) => {
  const fixture = sandboxFixture();
  const prepared = createDeferred();
  let active = true;
  if (kind === "retired") {
    const build = fixture.build.getMockImplementation()!;
    fixture.build.mockImplementation(async () => {
      await prepared.promise;
      return build();
    });
  }
  if (kind === "cancelled") {
    run.mockResolvedValue({ termination: "signal", code: null, stdout: "", stderr: "" });
  }
  const capability = preparePluginToolExecutionCapabilities({ sandbox: fixture.sandbox })(() => {
    if (!active) {
      throw new Error("retired");
    }
  });
  const pending = capability.sandbox!.run({
    argv: ["trusted-helper", "literal; argument"],
    ...(kind === "stdin" ? { input: "complete response" } : {}),
  });
  if (kind === "retired") {
    active = false;
    prepared.resolve();
  }
  await expect(pending).rejects.toThrow(error);
  if (kind !== "cancelled") {
    expect(run).not.toHaveBeenCalled();
  }
  if (kind !== "stdin") {
    expect(fixture.terminate).toHaveBeenCalledOnce();
  }
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
    sandbox: { ...fixture.sandbox, backend: fixture.sandbox.backend! },
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
    async terminate(action) {
      await action();
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
  const execution = modelExecution(["default"], {
    allows: () => allowed,
    onModelPolicyChanged: (callback) => {
      changed = callback;
      return () => {
        changed = undefined;
      };
    },
  });
  expect(execution.cliEntryPath).toBe(path.resolve(import.meta.dirname, "../../openclaw.mjs"));
  const action = vi.fn(async ({ model, agentId }: { model: string; agentId: string }) => ({
    model,
    agentId,
  }));
  await expect(
    execution.run({ model: "fixture/preferred", explicit: true }, action),
  ).rejects.toThrow("cannot use this model");
  expect(action).not.toHaveBeenCalled();
  await expect(
    execution.run({ model: "fixture/preferred", explicit: false }, action),
  ).resolves.toEqual({ model: "fixture/default", agentId: "caller" });
  await expect(
    execution.run({ model: null, explicit: false }, async ({ signal, model }) => {
      expect(model).toBe("fixture/default");
      allowed = false;
      changed?.();
      expect(signal.aborted).toBe(true);
      return "discarded";
    }),
  ).rejects.toThrow("cannot use this model");
  expect(changed).toBeUndefined();
  await expect(
    execution.run({ model: "fixture/preferred", explicit: false }, action),
  ).rejects.toThrow("cannot use this model");
});

it("keeps an allowed canonical model and refuses an empty permitted selection", async () => {
  await expect(
    modelExecution(["preferred"]).run(
      { model: "fixture/preferred", explicit: false },
      async ({ model }) => model,
    ),
  ).resolves.toBe("fixture/preferred");
  await expect(
    modelExecution(["preferred", "default"], { allow: ["fixture/default"] }).run(
      { model: "fixture/preferred", explicit: false },
      async ({ model }) => model,
    ),
  ).resolves.toBe("fixture/default");
  const action = vi.fn(async () => "must not execute");
  await expect(
    modelExecution([]).run({ model: "fixture/preferred", explicit: false }, action),
  ).rejects.toThrow("No permitted reviewer model");
  expect(action).not.toHaveBeenCalled();
});
