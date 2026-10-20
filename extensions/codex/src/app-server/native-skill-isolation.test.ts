import fs from "node:fs/promises";
import path from "node:path";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { createTempHomeEnv, withEnvAsync } from "openclaw/plugin-sdk/test-env";
import { expect, it, vi } from "vitest";
import { createFakeCodexAppServerClient } from "./codex-app-server.test-fixtures.js";
import {
  applyCodexNativeSkillIsolation,
  resolveCodexNativeSkillIsolation,
} from "./native-skill-isolation.js";
import type { CodexSkillsListResponse } from "./protocol-control-plane.js";

async function withNativeSkillHome(run: (home: string) => Promise<void>): Promise<void> {
  const tempHome = await createTempHomeEnv("openclaw-codex-native-skills-");
  try {
    // macOS exposes os.tmpdir() through /var while real paths use /private/var.
    const home = await fs.realpath(tempHome.home);
    await withEnvAsync({ HOME: home, OPENCLAW_STATE_DIR: path.join(home, "scratch-state") }, () =>
      run(home),
    );
  } finally {
    await tempHome.restore();
  }
}

function skill(name: string, skillPath: string, scope: "user" | "repo", description = name) {
  return { name, path: skillPath, scope, description, enabled: true };
}

function skillResponse(
  cwd: string,
  skills: CodexSkillsListResponse["data"][number]["skills"] = [],
  errors: CodexSkillsListResponse["data"][number]["errors"] = [],
): CodexSkillsListResponse {
  return { data: [{ cwd, errors, skills }] };
}

async function writeSkill(skillPath: string, contents = "skill") {
  await fs.mkdir(path.dirname(skillPath), { recursive: true });
  await fs.writeFile(skillPath, contents);
  return fs.realpath(skillPath);
}

function visualizeSkillPath(home: string) {
  return path.join(home, ".codex/plugins/cache/openai-bundled/visualize/skills/visualize/SKILL.md");
}

it("refreshes isolated skill rules on native changes and coalesces each client snapshot", async () => {
  return withNativeSkillHome(async (home) => {
    const codexHome = path.join(home, "scratch-state", "codex");
    const personalSkill = path.join(home, ".claude", "skills", "personal", "SKILL.md");
    const pluginSkill = path.join(home, "plugin-cache", "skills", "plugin", "SKILL.md");
    const instanceSkill = path.join(codexHome, "skills", "instance", "SKILL.md");
    const skills: CodexSkillsListResponse["data"][number]["skills"] = [];
    const fixture = createFakeCodexAppServerClient(async () => skillResponse(home, skills));
    const { client, request } = fixture;

    const params = { client, codexHome, cwd: home };
    const [first, second] = await Promise.all([
      resolveCodexNativeSkillIsolation(params),
      resolveCodexNativeSkillIsolation(params),
    ]);
    expect(second).toBe(first);
    expect(first?.disabledUserSkillPaths).toEqual([]);
    expect(request).toHaveBeenCalledTimes(1);

    for (const [name, skillPath] of [
      ["personal", personalSkill],
      ["plugin", pluginSkill],
      ["instance", instanceSkill],
    ] as const) {
      await writeSkill(skillPath, name);
      skills.push(skill(name, skillPath, "user"));
    }
    await fixture.notify({ method: "skills/changed", params: {} });
    const [refreshed, shared] = await Promise.all([
      resolveCodexNativeSkillIsolation(params),
      resolveCodexNativeSkillIsolation(params),
    ]);
    expect(shared).toBe(refreshed);
    expect(request).toHaveBeenCalledTimes(2);
    const enabledRules = [pluginSkill, instanceSkill].map((skillPath) => ({
      path: skillPath,
      enabled: true,
    }));
    expect(
      applyCodexNativeSkillIsolation({ "skills.config": enabledRules }, refreshed),
    ).toMatchObject({
      "skills.config": [
        { path: pluginSkill, enabled: true },
        { path: instanceSkill, enabled: true },
        { path: personalSkill, enabled: false },
      ],
    });

    await resolveCodexNativeSkillIsolation({
      client,
      cwd: path.join(home, "another-workspace"),
    });
    expect(request).toHaveBeenCalledTimes(3);
  });
});

it("retries a failed native skill reload instead of caching its rejection", async () => {
  return withNativeSkillHome(async (home) => {
    const request = vi
      .fn()
      .mockRejectedValueOnce(new Error("skill reload failed"))
      .mockResolvedValue(skillResponse(home));
    const { client } = createFakeCodexAppServerClient(request);

    const params = { client, cwd: home };
    await expect(resolveCodexNativeSkillIsolation(params)).rejects.toThrow("skill reload failed");
    await expect(resolveCodexNativeSkillIsolation(params)).resolves.toEqual({
      disabledUserSkillPaths: [],
      suppressNativeSkillInstructions: true,
    });
    expect(request).toHaveBeenCalledTimes(2);
  });
});

it("does not share native skill reloads across independently cancellable turns", async () => {
  return withNativeSkillHome(async (home) => {
    const { client, request } = createFakeCodexAppServerClient(async () => skillResponse(home));
    const firstSignal = new AbortController();
    const secondSignal = new AbortController();

    await Promise.all([
      resolveCodexNativeSkillIsolation({ client, cwd: home, signal: firstSignal.signal }),
      resolveCodexNativeSkillIsolation({ client, cwd: home, signal: secondSignal.signal }),
    ]);
    expect(request).toHaveBeenCalledTimes(2);
    await resolveCodexNativeSkillIsolation({
      client,
      cwd: home,
      signal: new AbortController().signal,
    });
    expect(request).toHaveBeenCalledTimes(2);
  });
});

it("restarts an in-flight scan after native skills change in an already-read root", async () => {
  return withNativeSkillHome(async (home) => {
    const scanPaused = createDeferred<void>();
    const releaseScan = createDeferred<void>();
    const openDirectory = fs.opendir;
    const agentsSkills = path.join(home, ".agents", "skills");
    const claudeSkills = path.join(home, ".claude", "skills");
    const lateSkill = path.join(agentsSkills, "late", "SKILL.md");
    await fs.mkdir(agentsSkills, { recursive: true });
    await fs.mkdir(claudeSkills, { recursive: true });
    let paused = false;
    const openDirectorySpy = vi.spyOn(fs, "opendir").mockImplementation(async (...args) => {
      if (args[0] === claudeSkills && !paused) {
        paused = true;
        scanPaused.resolve();
        await releaseScan.promise;
      }
      return await openDirectory(...args);
    });
    const fixture = createFakeCodexAppServerClient(async () => skillResponse(home));
    const { client, request } = fixture;

    const resolving = resolveCodexNativeSkillIsolation({ client, cwd: home });
    try {
      await scanPaused.promise;
      await writeSkill(lateSkill, "late");
      await fixture.notify({ method: "skills/changed", params: {} });
      releaseScan.resolve();
      await expect(resolving).resolves.toEqual({
        disabledUserSkillPaths: [lateSkill],
        suppressNativeSkillInstructions: true,
      });
      expect(request).toHaveBeenCalledTimes(2);
    } finally {
      releaseScan.resolve();
      await resolving.catch(() => undefined);
      openDirectorySpy.mockRestore();
    }
  });
});

it("keeps a refreshed snapshot when an invalidated reload is later canceled", async () => {
  return withNativeSkillHome(async (home) => {
    const firstRequestStarted = createDeferred<void>();
    const releaseFirstRequest = createDeferred<void>();
    const lateSkill = path.join(home, ".agents", "skills", "late", "SKILL.md");
    const firstController = new AbortController();
    let firstRequest = true;
    const fixture = createFakeCodexAppServerClient(async () => {
      if (firstRequest) {
        firstRequest = false;
        firstRequestStarted.resolve();
        await releaseFirstRequest.promise;
        firstController.signal.throwIfAborted();
      }
      return skillResponse(home);
    });
    const { client, request } = fixture;

    const first = resolveCodexNativeSkillIsolation({
      client,
      cwd: home,
      signal: firstController.signal,
    });
    try {
      await firstRequestStarted.promise;
      await writeSkill(lateSkill, "late");
      await fixture.notify({ method: "skills/changed", params: {} });
      const refreshed = await resolveCodexNativeSkillIsolation({ client, cwd: home });
      expect(refreshed?.disabledUserSkillPaths).toEqual([lateSkill]);
      firstController.abort(new Error("turn canceled"));
      releaseFirstRequest.resolve();
      await expect(first).rejects.toThrow("turn canceled");
      expect(await resolveCodexNativeSkillIsolation({ client, cwd: home })).toBe(refreshed);
      expect(request).toHaveBeenCalledTimes(2);
    } finally {
      releaseFirstRequest.resolve();
      await first.catch(() => undefined);
    }
  });
});

it("disables native user-scope skills only for non-default state directories", async () => {
  return withNativeSkillHome(async (home) => {
    const workspace = path.join(home, "workspace");
    const personalSkill = path.join(home, ".claude", "skills", "personal", "SKILL.md");
    const projectSkill = path.join(workspace, ".agents", "skills", "project", "SKILL.md");
    const pluginSkill = path.join(home, "plugin-cache", "skills", "plugin", "SKILL.md");
    const hiddenSkill = path.join(home, ".claude", "skills", ".git", "hidden", "SKILL.md");
    const customCodexHomeTarget = path.join(home, ".codex-work");
    const customCodexHome = path.join(home, "scratch-state", "codex-home");
    const customCodexSkill = path.join(customCodexHomeTarget, "skills", "custom", "SKILL.md");
    const stateOwnedCodexSkill = path.join(customCodexHome, "skills", "state-owned", "SKILL.md");
    const nestedSymlinkTarget = path.join(home, "nested-skill-tree");
    const nestedSymlinkSkill = path.join(nestedSymlinkTarget, "nested", "SKILL.md");
    const skillNamedDirectoryLink = path.join(home, ".agents", "skills", "linked", "SKILL.md");
    await fs.mkdir(path.dirname(skillNamedDirectoryLink), { recursive: true });
    await Promise.all(
      [
        personalSkill,
        projectSkill,
        pluginSkill,
        hiddenSkill,
        customCodexSkill,
        stateOwnedCodexSkill,
        nestedSymlinkSkill,
      ].map((skillPath) => writeSkill(skillPath)),
    );
    await fs.symlink(
      path.dirname(customCodexSkill),
      path.join(customCodexHome, "skills/custom"),
      "dir",
    );
    await fs.symlink(nestedSymlinkTarget, skillNamedDirectoryLink, "dir");
    const { client, request } = createFakeCodexAppServerClient(async () =>
      skillResponse(workspace, [
        skill("personal", personalSkill, "user"),
        skill("project", projectSkill, "repo"),
        skill("plugin", pluginSkill, "user"),
        skill("hidden", hiddenSkill, "user"),
        skill("custom", customCodexSkill, "user"),
        skill("state-owned", stateOwnedCodexSkill, "user"),
        skill("nested", nestedSymlinkSkill, "user"),
      ]),
    );
    const params = { client, codexHome: customCodexHome, cwd: workspace };
    await expect(
      withEnvAsync({ HOME: home, OPENCLAW_STATE_DIR: path.join(home, ".openclaw") }, () =>
        resolveCodexNativeSkillIsolation(params),
      ),
    ).resolves.toBe(undefined);
    expect(request).toHaveBeenCalledTimes(1);

    const isolation = await withEnvAsync(
      {
        HOME: path.join(home, "gateway-home"),
        OPENCLAW_STATE_DIR: path.join(home, "scratch-state"),
      },
      () => resolveCodexNativeSkillIsolation({ ...params, home }),
    );
    expect(request).toHaveBeenLastCalledWith(
      "skills/list",
      { cwds: [workspace], forceReload: true },
      { signal: undefined },
    );
    expect(request).toHaveBeenCalledTimes(2);
    const projectRules = [{ path: projectSkill, enabled: true }];
    expect(
      applyCodexNativeSkillIsolation({ "skills.config": projectRules }, isolation),
    ).toMatchObject({
      "skills.include_instructions": false,
      "skills.config": [
        { path: projectSkill, enabled: true },
        { path: personalSkill, enabled: false },
        { path: customCodexSkill, enabled: false },
        { path: nestedSymlinkSkill, enabled: false },
      ],
    });
  });
});

it.runIf(process.platform !== "win32")(
  "fails closed to all native user skills when a personal root is unreadable",
  async () => {
    return withNativeSkillHome(async (home) => {
      const skillsDir = path.join(home, ".claude", "skills");
      const personalSkill = path.join(skillsDir, "personal", "SKILL.md");
      const outsideSkill = path.join(home, "plugin-cache", "outside", "SKILL.md");
      const personalSkillRealPath = await writeSkill(personalSkill, "personal");
      const outsideSkillRealPath = await writeSkill(outsideSkill, "outside");
      await fs.symlink(path.join(skillsDir, "loop"), path.join(skillsDir, "loop"));
      const { client } = createFakeCodexAppServerClient(async () =>
        skillResponse(home, [skill("outside", outsideSkillRealPath, "user", "Outside")]),
      );

      const isolation = await resolveCodexNativeSkillIsolation({ client, cwd: home });
      expect(isolation?.disabledUserSkillPaths).toEqual([
        personalSkillRealPath,
        outsideSkillRealPath,
      ]);
    });
  },
);

it("captures a personal skill created during the authoritative Codex reload", async () => {
  return withNativeSkillHome(async (home) => {
    const skillPath = path.join(home, ".claude", "skills", "late", "SKILL.md");
    const { client } = createFakeCodexAppServerClient(async () => {
      await writeSkill(skillPath, "late");
      return skillResponse(home);
    });

    const isolation = await resolveCodexNativeSkillIsolation({ client, cwd: home });
    expect(isolation?.disabledUserSkillPaths).toEqual([await fs.realpath(skillPath)]);
  });
});

it("disables renderer-incompatible Codex skills via legacy cache identity with implicit default state", async () => {
  await withNativeSkillHome(async (home) => {
    const visualizeSkill = visualizeSkillPath(home);
    const otherSkill = path.join(home, ".codex", "plugins", "cache", "other", "SKILL.md");
    const { client, request } = createFakeCodexAppServerClient(async () =>
      skillResponse(home, [
        skill("visualize", visualizeSkill, "user", "Render inline visualizations"),
        {
          ...skill("other", otherSkill, "user", "Other plugin skill"),
          pluginId: "other@example",
        },
      ]),
    );

    const isolation = await withEnvAsync(
      { CODEX_HOME: undefined, HOME: home, OPENCLAW_STATE_DIR: undefined },
      () => resolveCodexNativeSkillIsolation({ client, cwd: home }),
    );
    const config = {
      "skills.include_instructions": true,
      "skills.config": [{ path: otherSkill, enabled: true }],
    };
    expect(applyCodexNativeSkillIsolation(config, isolation)).toEqual({
      "skills.include_instructions": true,
      "skills.config": [
        { path: otherSkill, enabled: true },
        { path: visualizeSkill, enabled: false },
      ],
    });
    expect(request).toHaveBeenCalledTimes(1);
  });
});

it("retries error-bearing default-state skill discovery responses", async () => {
  await withNativeSkillHome(async (home) => {
    const visualizeSkill = visualizeSkillPath(home);
    const request = vi
      .fn()
      .mockResolvedValueOnce(
        skillResponse(home, [], [{ path: home, message: "skill reload failed" }]),
      )
      .mockResolvedValue(
        skillResponse(home, [
          {
            ...skill("visualize", visualizeSkill, "user", "Render inline visualizations"),
            pluginId: "visualize@openai-bundled",
          },
        ]),
      );
    const { client } = createFakeCodexAppServerClient(request);

    await withEnvAsync(
      { CODEX_HOME: undefined, HOME: home, OPENCLAW_STATE_DIR: path.join(home, ".openclaw") },
      async () => {
        const params = { client, cwd: home };
        await expect(resolveCodexNativeSkillIsolation(params)).resolves.toBe(undefined);
        const recovered = await resolveCodexNativeSkillIsolation(params);
        expect(recovered?.disabledUserSkillPaths).toEqual([visualizeSkill]);
        await expect(resolveCodexNativeSkillIsolation(params)).resolves.toBe(recovered);
      },
    );
    expect(request).toHaveBeenCalledTimes(2);
  });
});

it("preserves direct skills under a state-owned default Codex home", async () => {
  return withNativeSkillHome(async (stateHome) => {
    const skillPath = path.join(stateHome, ".codex", "skills", "state-owned", "SKILL.md");
    const skillRealPath = await writeSkill(skillPath, "state-owned");
    const { client } = createFakeCodexAppServerClient(async () =>
      skillResponse(stateHome, [skill("state-owned", skillRealPath, "user", "State owned")]),
    );

    const isolation = await withEnvAsync({ HOME: stateHome, OPENCLAW_STATE_DIR: stateHome }, () =>
      resolveCodexNativeSkillIsolation({ client, cwd: stateHome }),
    );
    expect(isolation?.disabledUserSkillPaths).toEqual([]);
  });
});
