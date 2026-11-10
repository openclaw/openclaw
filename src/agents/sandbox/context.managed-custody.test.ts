import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { create as createTar } from "tar";
import { assert, expect, it, onTestFinished, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import type { SessionCreatedActor } from "../../config/sessions/session-entry-provenance.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { nodeFilePath } from "../../test-utils/node-file-path.js";
import { resolveSandboxConfigForAgent } from "./config.js";
import { execContainer } from "./container-engine.js";
import * as custody from "./context-custody.test-support.js";
import {
  prepareSandboxDependencyTemplate,
  resolveSandboxDependencyTemplateIdentity,
} from "./dependency-template.js";
import { ensureSandboxContainer } from "./docker.js";
import { hashTextSha256 } from "./hash.js";
import type { prepareLocalSandboxWorkspace } from "./local-workspace.js";
import { useSandboxRegistryState } from "./registry.test-support.js";
import { resolveSandboxRuntimeStatusAsync } from "./runtime-status.js";
import {
  buildSandboxContainerName,
  resolveSandboxWorkspaceLayoutPaths,
  slugifySessionKey,
} from "./shared.js";

const prepare = vi.hoisted(() => vi.fn<typeof prepareLocalSandboxWorkspace>());
// mock-isolation: prevent real workspace provisioning while exercising custody revocation.
vi.mock("./local-workspace.js", () => ({
  prepareLocalSandboxWorkspace: prepare,
  bindLocalSandboxWorkspace: vi.fn(),
}));
// mock-isolation: Exercise context selection and the real installer without starting a container daemon.
vi.mock("./docker-backend.js", () => ({
  createDockerSandboxBackend: async () => ({
    id: "docker",
    runtimeId: "fixture",
    runtimeLabel: "fixture",
    workdir: "/workspace",
    buildExecSpec: vi.fn(),
    runShellCommand: vi.fn(),
  }),
  createPodmanSandboxBackend: vi.fn(),
  dockerSandboxBackendManager: {},
  podmanSandboxBackendManager: {},
}));
vi.mock("./container-engine.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./container-engine.js")>()),
  execContainer: vi.fn(),
}));
vi.mock("./docker.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./docker.js")>()),
  ensureSandboxContainer: vi.fn(),
}));

const state = useSandboxRegistryState("sandbox-managed-custody-");

it.skipIf(process.platform === "win32")(
  "reuses prepared dependencies when the review installs again",
  async () => {
    const template = path.join(state.root, "template");
    const projection = path.join(state.root, "projection");
    const payload = path.join(state.root, "package");
    await fs.mkdir(template);
    await fs.mkdir(payload);
    await fs.writeFile(
      path.join(payload, "package.json"),
      JSON.stringify({ name: "fixture-payload", version: "1.0.0", main: "index.cjs" }),
    );
    await fs.writeFile(path.join(payload, "index.cjs"), "module.exports = 'prepared';\n");
    await createTar({ gzip: true, cwd: state.root, file: path.join(state.root, "payload.tgz") }, [
      "package",
    ]);
    await fs.writeFile(
      path.join(template, "package.json"),
      JSON.stringify({
        name: "review-fixture",
        private: true,
        dependencies: { "fixture-payload": "file:../payload.tgz" },
        scripts: {
          postinstall: "node -e \"require('fs').appendFileSync('lifecycle.txt','ran\\n')\"",
        },
      }),
    );
    await fs.writeFile(
      path.join(template, "pnpm-workspace.yaml"),
      "packageImportMethod: clone-or-copy\nverifyDepsBeforeRun: false\n",
    );
    // Translate the container namespace into private host paths, preserving store identity.
    const guestEnv = (env: Record<string, string>) =>
      Object.fromEntries(
        Object.entries(env).map(([key, value]) => [
          key,
          value.startsWith("/tmp/openclaw-deps") ? path.join(state.root, "guest", value) : value,
        ]),
      );
    const run = (cwd: string, command: string, env: Record<string, string> = {}) => {
      const result = spawnSync("/bin/sh", ["-c", command], {
        cwd,
        env: { PATH: process.env.PATH, HOME: state.root, CI: "1", ...guestEnv(env) },
        encoding: "utf8",
        timeout: 30_000,
      });
      expect(result.status, result.stdout + result.stderr).toBe(0);
    };
    const config = custody.createConfig(
      {
        workspaceRoot: path.join(state.root, "sandboxes"),
        docker: { user: "1000", network: "bridge" },
      },
      { skills: { load: { watch: false } } },
    );
    setRuntimeConfigSnapshot(config);
    using owner = custody.acquireOwner(state.root);
    const cfg = resolveSandboxConfigForAgent(config);
    const image = `sha256:${"a".repeat(64)}`;
    vi.mocked(execContainer).mockResolvedValue({ code: 0, stdout: image, stderr: "" });
    const identity = await resolveSandboxDependencyTemplateIdentity(cfg, {
      assertCurrent: owner.assertCurrent,
    });
    assert(identity);
    run(template, "pnpm install --lockfile-only --ignore-scripts", identity.docker.env);
    vi.mocked(ensureSandboxContainer).mockResolvedValue({
      containerId: "b".repeat(64),
      containerName: "fixture-builder",
      configHash: "fixture",
      mountPlan: {
        binds: [],
        protectedTargets: [],
        skippedBinds: [],
        readOnlyWorkspaceSkillMounts: [],
        tmpfs: [],
      },
      currentConfig: true,
    });
    vi.mocked(execContainer).mockImplementation(async (_engine, args) => {
      assert(args[0] === "exec");
      run(template, args.at(-1)!, identity.docker.env);
      return { code: 0, stdout: "", stderr: "" };
    });
    expect(
      await prepareSandboxDependencyTemplate({
        directory: template,
        cfg,
        scopeKey: "fixture",
        identity,
        assertCurrent: owner.assertCurrent,
        rollbackGuard: owner.assertCurrent,
      }),
    ).toEqual({ installed: true });
    await fs.cp(template, projection, { recursive: true, verbatimSymlinks: true });
    await fs.rm(path.join(state.root, "guest"), { recursive: true, force: true });
    prepare.mockResolvedValueOnce({
      workspaceDir: projection,
      workspaceCwd: projection,
      assertCurrent: owner.assertCurrent,
      protectRuntimeScope: async () => {},
      retain: () => {
        throw new Error("Unexpected retain");
      },
      provision: async (callback) => callback(),
      checkpoint: async () => {},
      terminate: async () => {},
      [Symbol.dispose]: () => {},
    });
    using lifetime = new DisposableStack();
    const context = await custody.prepareContext(config, "agent:main:review", projection);
    assert(context);
    lifetime.defer(() => context[Symbol.dispose]?.());
    const dependency = path.join(projection, "node_modules/fixture-payload/index.cjs");
    await using original = await fs.open(dependency, "r");
    const before = await original.stat();
    run(
      projection,
      "pnpm install --offline --frozen-lockfile --config.optimistic-repeat-install=false",
      context.docker.env,
    );
    expect((await fs.stat(dependency)).ino).toBe(before.ino);
    expect(await fs.readFile(path.join(projection, "lifecycle.txt"), "utf8")).toBe("ran\nran\n");
    await fs.writeFile(dependency, "review edit\n");
    expect(
      await fs.readFile(path.join(template, "node_modules/fixture-payload/index.cjs"), "utf8"),
    ).toBe("module.exports = 'prepared';\n");
  },
);

it("keeps managed workspace custody through awaited sandbox skill synchronization", async () => {
  vi.stubEnv("HOME", state.root);
  const workspaceDir = path.join(state.root, "projection");
  const sessionKey = "agent:main:subagent:managed-custody";
  const sandbox = {
    workspaceRoot: path.join(state.root, "sandboxes"),
    workspaceAccess: "rw",
  } as const;
  const config = custody.createConfig(sandbox, { skills: { load: { watch: false } } });
  const { skillsWorkspaceDir } = resolveSandboxWorkspaceLayoutPaths({
    cfg: { ...sandbox, scope: "session" },
    rawSessionKey: sessionKey,
    agentId: "main",
    isolationSubject: { kind: "session", sessionKey },
    workspaceDir,
  });
  const targetSkills = path.join(skillsWorkspaceDir, "skills");
  onTestFinished(() => fs.rm(skillsWorkspaceDir, { recursive: true, force: true }));
  await fs.mkdir(skillsWorkspaceDir, { recursive: true });
  await fs.writeFile(targetSkills, "preserve-managed-skills");
  using owner = custody.acquireOwner(state.root);
  const revocation = new AbortController();
  const releaseProjection = vi.fn();
  const refusal = new Error("Local sandbox workspace authority changed");
  const unexpected = () => assert.fail("Unexpected projection use after revoked skills sync");
  prepare.mockImplementationOnce(async (params) => {
    const assertCurrent = () => {
      params.assertCurrent?.();
      revocation.signal.throwIfAborted();
    };
    return {
      workspaceDir,
      workspaceCwd: workspaceDir,
      assertCurrent,
      protectRuntimeScope: async () => {},
      retain: unexpected,
      provision: unexpected,
      checkpoint: unexpected,
      terminate: unexpected,
      [Symbol.dispose]: releaseProjection,
    };
  });
  const entered = createDeferred();
  const resume = createDeferred();
  const lstat = fs.lstat.bind(fs);
  const read = vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
    const result = await lstat(...args);
    if (nodeFilePath(args[0]) === targetSkills) {
      entered.resolve();
      await resume.promise;
    }
    return result;
  });
  const preparation = custody.prepareContext(config, sessionKey, workspaceDir);
  try {
    await awaitGateBeforeSettlement(
      entered.promise,
      preparation,
      "Sandbox preparation skipped the managed skills read",
    );
    revocation.abort(refusal);
    expect(() => owner.assertCurrent()).not.toThrow();
    resume.resolve();
    const result = await preparation.catch((error: unknown) => error);
    expect(result).toMatchObject({ code: "sandbox_provisioning", cause: refusal });
    expect(await fs.readFile(targetSkills, "utf8")).toBe("preserve-managed-skills");
    expect(releaseProjection).toHaveBeenCalledOnce();
  } finally {
    resume.resolve();
    await preparation.catch(() => {});
    read.mockRestore();
  }
});

it.each(["agent", "session", "shared"] as const)(
  "separates non-profile resources with configured %s scope",
  async (scope) => {
    const workspaceDir = path.join(state.root, "workspace");
    const id = "equal-creator-id";
    const sandbox = {
      mode: "off",
      scope,
      workspaceAccess: "rw",
      workspaceRoot: path.join(state.root, "sandboxes"),
    } as const;
    const cfg: OpenClawConfig = { agents: { defaults: { sandbox } } };
    setRuntimeConfigSnapshot(cfg);
    const actors: Array<SessionCreatedActor | undefined> = [
      { type: "human", source: "profile", id },
      { type: "human", source: "channel", id },
      { type: "human", source: "unknown", id },
      { type: "agent", id },
      { type: "system", id },
      { type: "human", source: "unknown" },
      undefined,
    ];
    const layoutFor = async (sessionKey: string, classificationSessionKey?: string) => {
      const runtime = await resolveSandboxRuntimeStatusAsync({
        cfg,
        sessionKey,
        classificationSessionKey,
      });
      assert(runtime.sandboxRequired && runtime.sandboxed, "required sandbox lost its restriction");
      expect(runtime.workspaceAccess).toBe("ro");
      return resolveSandboxWorkspaceLayoutPaths({
        ...runtime,
        cfg: { ...sandbox, workspaceAccess: runtime.workspaceAccess },
        rawSessionKey: sessionKey,
        workspaceDir,
      });
    };
    const allLayouts: Awaited<ReturnType<typeof layoutFor>>[] = [];
    for (const [index, createdActor] of actors.entries()) {
      for (const suffix of ["one", "two"]) {
        const sessionKey = `agent:main:required-${index}-${suffix}`;
        const entry = {
          sessionId: sessionKey,
          updatedAt: 1,
          createdActor,
          sandbox: "required",
        } as const;
        await upsertSessionEntryCore({ agentId: "main", sessionKey }, entry);
        const layout = await layoutFor(sessionKey);
        for (const alias of [sessionKey.slice("agent:main:".length), sessionKey.toUpperCase()]) {
          expect.soft(await layoutFor(alias), alias).toEqual(layout);
          const borrowed = await layoutFor("agent:main:borrowed-runtime", alias);
          expect.soft(borrowed, alias).toEqual(layout);
        }
        allLayouts.push(layout);
      }
    }
    const [first, second] = allLayouts;
    assert(first && second, "expected two persisted profile sessions");
    expect(first.scopeKey).toBe(
      `agent:main:principal:${hashTextSha256(id).slice(0, 32)}:workspace:${hashTextSha256(workspaceDir).slice(0, 32)}`,
    );
    expect(second).toEqual(first);
    // Of 14 sessions, only the two profile sessions may share resources.
    for (const key of ["scopeKey", "workspaceDir"] as const) {
      expect.soft(new Set(allLayouts.map((layout) => layout[key])).size, key).toBe(13);
    }
    const containers = allLayouts.map(({ scopeKey }) =>
      buildSandboxContainerName("openclaw-sbx-", slugifySessionKey(scopeKey)),
    );
    expect.soft(new Set(containers).size).toBe(13);
  },
);
