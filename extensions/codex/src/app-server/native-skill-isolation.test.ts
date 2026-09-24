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

it("refreshes isolated skill rules on native changes and coalesces each client snapshot", async () => {
  const tempHome = await createTempHomeEnv("openclaw-codex-native-skills-client-cache-");
  try {
    const home = await fs.realpath(tempHome.home);
    const codexHome = path.join(home, "scratch-state", "codex");
    const personalSkill = path.join(home, ".claude", "skills", "personal", "SKILL.md");
    const pluginSkill = path.join(home, "plugin-cache", "skills", "plugin", "SKILL.md");
    const instanceSkill = path.join(codexHome, "skills", "instance", "SKILL.md");
    const skills: CodexSkillsListResponse["data"][number]["skills"] = [];
    const fixture = createFakeCodexAppServerClient(async () => ({
      data: [{ cwd: home, errors: [], skills }],
    }));
    const { client, request } = fixture;

    await withEnvAsync(
      { HOME: home, OPENCLAW_STATE_DIR: path.join(home, "scratch-state") },
      async () => {
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
          await fs.mkdir(path.dirname(skillPath), { recursive: true });
          await fs.writeFile(skillPath, name);
          skills.push({ name, description: name, path: skillPath, scope: "user", enabled: true });
        }
        await fixture.notify({ method: "skills/changed", params: {} });
        const [refreshed, shared] = await Promise.all([
          resolveCodexNativeSkillIsolation(params),
          resolveCodexNativeSkillIsolation(params),
        ]);
        expect(shared).toBe(refreshed);
        expect(request).toHaveBeenCalledTimes(2);
        expect(
          applyCodexNativeSkillIsolation(
            {
              "skills.config": [
                { path: pluginSkill, enabled: true },
                { path: instanceSkill, enabled: true },
              ],
            },
            refreshed,
          ),
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
      },
    );
  } finally {
    await tempHome.restore();
  }
});

it("retries a failed native skill reload instead of caching its rejection", async () => {
  const tempHome = await createTempHomeEnv("openclaw-codex-native-skills-cache-retry-");
  try {
    const home = await fs.realpath(tempHome.home);
    const request = vi
      .fn()
      .mockRejectedValueOnce(new Error("skill reload failed"))
      .mockResolvedValue({ data: [{ cwd: home, errors: [], skills: [] }] });
    const { client } = createFakeCodexAppServerClient(request);

    await withEnvAsync(
      { HOME: home, OPENCLAW_STATE_DIR: path.join(home, "scratch-state") },
      async () => {
        const params = { client, cwd: home };
        await expect(resolveCodexNativeSkillIsolation(params)).rejects.toThrow(
          "skill reload failed",
        );
        await expect(resolveCodexNativeSkillIsolation(params)).resolves.toEqual({
          disabledUserSkillPaths: [],
        });
        expect(request).toHaveBeenCalledTimes(2);
      },
    );
  } finally {
    await tempHome.restore();
  }
});

it("does not share native skill reloads across independently cancellable turns", async () => {
  const tempHome = await createTempHomeEnv("openclaw-codex-native-skills-cache-signals-");
  try {
    const home = await fs.realpath(tempHome.home);
    const request = vi.fn(async () => ({
      data: [{ cwd: home, errors: [], skills: [] }],
    }));
    const { client } = createFakeCodexAppServerClient(request);
    const firstSignal = new AbortController();
    const secondSignal = new AbortController();

    await withEnvAsync(
      { HOME: home, OPENCLAW_STATE_DIR: path.join(home, "scratch-state") },
      async () => {
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
      },
    );
  } finally {
    await tempHome.restore();
  }
});

it("restarts an in-flight scan after native skills change in an already-read root", async () => {
  const tempHome = await createTempHomeEnv("openclaw-codex-native-skills-change-race-");
  const scanPaused = createDeferred<void>();
  const releaseScan = createDeferred<void>();
  const openDirectory = fs.opendir;
  let restoreOpenDirectory: (() => void) | undefined;
  try {
    const home = await fs.realpath(tempHome.home);
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
    restoreOpenDirectory = () => openDirectorySpy.mockRestore();
    const fixture = createFakeCodexAppServerClient(async () => ({
      data: [{ cwd: home, errors: [], skills: [] }],
    }));
    const { client, request } = fixture;

    await withEnvAsync(
      { HOME: home, OPENCLAW_STATE_DIR: path.join(home, "scratch-state") },
      async () => {
        const resolving = resolveCodexNativeSkillIsolation({ client, cwd: home });
        try {
          await scanPaused.promise;
          await fs.mkdir(path.dirname(lateSkill), { recursive: true });
          await fs.writeFile(lateSkill, "late");
          await fixture.notify({ method: "skills/changed", params: {} });
          releaseScan.resolve();
          await expect(resolving).resolves.toEqual({ disabledUserSkillPaths: [lateSkill] });
          expect(request).toHaveBeenCalledTimes(2);
        } finally {
          releaseScan.resolve();
          await resolving.catch(() => undefined);
        }
      },
    );
  } finally {
    restoreOpenDirectory?.();
    await tempHome.restore();
  }
});

it("keeps a refreshed snapshot when an invalidated reload is later canceled", async () => {
  const tempHome = await createTempHomeEnv("openclaw-codex-native-skills-change-cancel-");
  const firstRequestStarted = createDeferred<void>();
  const releaseFirstRequest = createDeferred<void>();
  try {
    const home = await fs.realpath(tempHome.home);
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
      return { data: [{ cwd: home, errors: [], skills: [] }] };
    });
    const { client, request } = fixture;

    await withEnvAsync(
      { HOME: home, OPENCLAW_STATE_DIR: path.join(home, "scratch-state") },
      async () => {
        const first = resolveCodexNativeSkillIsolation({
          client,
          cwd: home,
          signal: firstController.signal,
        });
        try {
          await firstRequestStarted.promise;
          await fs.mkdir(path.dirname(lateSkill), { recursive: true });
          await fs.writeFile(lateSkill, "late");
          await fixture.notify({ method: "skills/changed", params: {} });
          const refreshed = await resolveCodexNativeSkillIsolation({ client, cwd: home });
          expect(refreshed?.disabledUserSkillPaths).toEqual([lateSkill]);
          firstController.abort(new Error("turn canceled"));
          releaseFirstRequest.resolve();
          await expect(first).rejects.toThrow("turn canceled");
          await expect(resolveCodexNativeSkillIsolation({ client, cwd: home })).resolves.toBe(
            refreshed,
          );
          expect(request).toHaveBeenCalledTimes(2);
        } finally {
          releaseFirstRequest.resolve();
          await first.catch(() => undefined);
        }
      },
    );
  } finally {
    await tempHome.restore();
  }
});

it("disables native user-scope skills only for non-default state directories", async () => {
  const tempHome = await createTempHomeEnv("openclaw-codex-native-skills-");
  try {
    // macOS exposes os.tmpdir() through /var while real paths use /private/var.
    const home = await fs.realpath(tempHome.home);
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
    await fs.mkdir(path.dirname(personalSkill), { recursive: true });
    await fs.mkdir(path.dirname(projectSkill), { recursive: true });
    await fs.mkdir(path.dirname(pluginSkill), { recursive: true });
    await fs.mkdir(path.dirname(hiddenSkill), { recursive: true });
    await fs.mkdir(path.dirname(customCodexSkill), { recursive: true });
    await fs.mkdir(path.join(customCodexHome, "skills"), { recursive: true });
    await fs.mkdir(path.dirname(stateOwnedCodexSkill), { recursive: true });
    await fs.mkdir(path.dirname(nestedSymlinkSkill), { recursive: true });
    await fs.mkdir(path.dirname(skillNamedDirectoryLink), { recursive: true });
    await fs.writeFile(personalSkill, "personal");
    await fs.writeFile(projectSkill, "project");
    await fs.writeFile(pluginSkill, "plugin");
    await fs.writeFile(hiddenSkill, "hidden");
    await fs.writeFile(customCodexSkill, "custom");
    await fs.writeFile(stateOwnedCodexSkill, "state-owned");
    await fs.writeFile(nestedSymlinkSkill, "nested");
    await fs.symlink(
      path.join(customCodexHomeTarget, "skills", "custom"),
      path.join(customCodexHome, "skills", "custom"),
      "dir",
    );
    await fs.symlink(nestedSymlinkTarget, skillNamedDirectoryLink, "dir");
    const personalSkillRealPath = await fs.realpath(personalSkill);
    const projectSkillRealPath = await fs.realpath(projectSkill);
    const pluginSkillRealPath = await fs.realpath(pluginSkill);
    const hiddenSkillRealPath = await fs.realpath(hiddenSkill);
    const customCodexSkillRealPath = await fs.realpath(customCodexSkill);
    const stateOwnedCodexSkillRealPath = await fs.realpath(stateOwnedCodexSkill);
    const nestedSymlinkSkillRealPath = await fs.realpath(nestedSymlinkSkill);
    const request = vi.fn(async () => ({
      data: [
        {
          cwd: workspace,
          errors: [],
          skills: [
            {
              name: "personal",
              description: "Personal",
              path: personalSkillRealPath,
              scope: "user" as const,
              enabled: true,
            },
            {
              name: "project",
              description: "Project",
              path: projectSkillRealPath,
              scope: "repo" as const,
              enabled: true,
            },
            {
              name: "plugin",
              description: "Plugin",
              path: pluginSkillRealPath,
              scope: "user" as const,
              enabled: true,
            },
            {
              name: "hidden",
              description: "Hidden",
              path: hiddenSkillRealPath,
              scope: "user" as const,
              enabled: true,
            },
            {
              name: "custom",
              description: "Custom Codex home",
              path: customCodexSkillRealPath,
              scope: "user" as const,
              enabled: true,
            },
            {
              name: "state-owned",
              description: "State-owned Codex home",
              path: stateOwnedCodexSkillRealPath,
              scope: "user" as const,
              enabled: true,
            },
            {
              name: "nested",
              description: "Nested through a SKILL.md directory symlink",
              path: nestedSymlinkSkillRealPath,
              scope: "user" as const,
              enabled: true,
            },
          ],
        },
      ],
    }));
    const { client } = createFakeCodexAppServerClient(request);

    await withEnvAsync(
      { HOME: home, OPENCLAW_STATE_DIR: path.join(home, ".openclaw") },
      async () => {
        await expect(
          resolveCodexNativeSkillIsolation({ client, codexHome: customCodexHome, cwd: workspace }),
        ).resolves.toBe(undefined);
      },
    );
    expect(request).not.toHaveBeenCalled();

    const isolation = await withEnvAsync(
      {
        HOME: path.join(home, "gateway-home"),
        OPENCLAW_STATE_DIR: path.join(home, "scratch-state"),
      },
      async () =>
        await resolveCodexNativeSkillIsolation({
          client,
          codexHome: customCodexHome,
          cwd: workspace,
          home,
        }),
    );
    expect(request).toHaveBeenCalledWith(
      "skills/list",
      { cwds: [workspace], forceReload: true },
      { signal: undefined },
    );
    expect(
      applyCodexNativeSkillIsolation(
        { "skills.config": [{ path: projectSkillRealPath, enabled: true }] },
        isolation,
      ),
    ).toMatchObject({
      "skills.include_instructions": false,
      "skills.config": [
        { path: projectSkillRealPath, enabled: true },
        { path: personalSkillRealPath, enabled: false },
        { path: customCodexSkillRealPath, enabled: false },
        { path: nestedSymlinkSkillRealPath, enabled: false },
      ],
    });
  } finally {
    await tempHome.restore();
  }
});

it.runIf(process.platform !== "win32")(
  "fails closed to all native user skills when a personal root is unreadable",
  async () => {
    const tempHome = await createTempHomeEnv("openclaw-codex-native-skills-fail-closed-");
    try {
      const home = await fs.realpath(tempHome.home);
      const skillsDir = path.join(home, ".claude", "skills");
      const personalSkill = path.join(skillsDir, "personal", "SKILL.md");
      const outsideSkill = path.join(home, "plugin-cache", "outside", "SKILL.md");
      await fs.mkdir(skillsDir, { recursive: true });
      await fs.mkdir(path.dirname(personalSkill), { recursive: true });
      await fs.mkdir(path.dirname(outsideSkill), { recursive: true });
      await fs.writeFile(personalSkill, "personal");
      await fs.writeFile(outsideSkill, "outside");
      await fs.symlink(path.join(skillsDir, "loop"), path.join(skillsDir, "loop"));
      const personalSkillRealPath = await fs.realpath(personalSkill);
      const outsideSkillRealPath = await fs.realpath(outsideSkill);
      const { client } = createFakeCodexAppServerClient(async () => ({
        data: [
          {
            cwd: home,
            errors: [],
            skills: [
              {
                name: "outside",
                description: "Outside",
                path: outsideSkillRealPath,
                scope: "user" as const,
                enabled: true,
              },
            ],
          },
        ],
      }));

      const isolation = await withEnvAsync(
        { HOME: home, OPENCLAW_STATE_DIR: path.join(home, "scratch-state") },
        async () => await resolveCodexNativeSkillIsolation({ client, cwd: home }),
      );
      expect(isolation?.disabledUserSkillPaths).toEqual([
        personalSkillRealPath,
        outsideSkillRealPath,
      ]);
    } finally {
      await tempHome.restore();
    }
  },
);

it("captures a personal skill created during the authoritative Codex reload", async () => {
  const tempHome = await createTempHomeEnv("openclaw-codex-native-skills-reload-race-");
  try {
    const home = await fs.realpath(tempHome.home);
    const skillPath = path.join(home, ".claude", "skills", "late", "SKILL.md");
    const { client } = createFakeCodexAppServerClient(async () => {
      await fs.mkdir(path.dirname(skillPath), { recursive: true });
      await fs.writeFile(skillPath, "late");
      return { data: [{ cwd: home, errors: [], skills: [] }] };
    });

    const isolation = await withEnvAsync(
      { HOME: home, OPENCLAW_STATE_DIR: path.join(home, "scratch-state") },
      async () => await resolveCodexNativeSkillIsolation({ client, cwd: home }),
    );
    expect(isolation?.disabledUserSkillPaths).toEqual([await fs.realpath(skillPath)]);
  } finally {
    await tempHome.restore();
  }
});

it("preserves direct skills under a state-owned default Codex home", async () => {
  const tempHome = await createTempHomeEnv("openclaw-codex-native-state-home-");
  try {
    const stateHome = await fs.realpath(tempHome.home);
    const skillPath = path.join(stateHome, ".codex", "skills", "state-owned", "SKILL.md");
    await fs.mkdir(path.dirname(skillPath), { recursive: true });
    await fs.writeFile(skillPath, "state-owned");
    const skillRealPath = await fs.realpath(skillPath);
    const { client } = createFakeCodexAppServerClient(async () => ({
      data: [
        {
          cwd: stateHome,
          errors: [],
          skills: [
            {
              name: "state-owned",
              description: "State owned",
              path: skillRealPath,
              scope: "user" as const,
              enabled: true,
            },
          ],
        },
      ],
    }));

    const isolation = await withEnvAsync(
      { HOME: stateHome, OPENCLAW_STATE_DIR: stateHome },
      async () => await resolveCodexNativeSkillIsolation({ client, cwd: stateHome }),
    );
    expect(isolation?.disabledUserSkillPaths).toEqual([]);
  } finally {
    await tempHome.restore();
  }
});
