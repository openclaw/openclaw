import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  upsertSessionEntryCore,
  loadSessionEntry,
} from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  listSkillCommandsForWorkspace,
  resolveSkillCommandInvocation,
} from "../../skills/discovery/chat-commands.js";
import { skillLibraryRevisionDir } from "../../skills/library/bundle.js";
import { changeSkillLibrarySelection } from "../../skills/library/selection.js";
import { mutateSkillLibrary, saveSkillLibrary } from "../../skills/library/service.js";
import type { SkillLibraryAuthority } from "../../skills/library/store.js";
import {
  materializeSkillResources,
  prepareSkillResourceDelivery,
} from "../../skills/runtime/resources.js";
import { resolveReusableWorkspaceSkillSnapshot } from "../../skills/runtime/session-snapshot.js";
import {
  manualLibraryInstructions as instructions,
  manualLibraryFiles as supporting,
} from "../../skills/test-support/manual-library.test-support.js";
import type { SkillSnapshot } from "../../skills/types.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { createOpenClawCodingTools, createOpenClawCodingToolsInternal } from "../agent-tools.js";
import { createAdmittedHostCapabilityTestFixture } from "../harness/host-capability.test-support.js";
import { createInitialSubagentSession } from "../subagents/spawn/subagent-spawn-session-patch.js";
import { getTextContent } from "../test-helpers/agent-tools-fs-helpers.js";
import { createAgentToolsSandboxContext } from "../test-helpers/agent-tools-sandbox-context.js";
import { createHostSandboxFsBridge } from "../test-helpers/host-sandbox-fs-bridge.js";
import { prepareEmbeddedSkills } from "./skill-runtime.js";

const hosts: Array<Awaited<ReturnType<typeof createAdmittedHostCapabilityTestFixture>>> = [];

const temps = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(() => {
    for (const host of hosts.splice(0)) {
      host.closeHost();
      host.closeAdmission();
    }
    closeOpenClawStateDatabaseForTest();
    closeOpenClawAgentDatabasesForTest();
    vi.unstubAllEnvs();
    cleanup();
  }),
);

describe("manual library resources through embedded and host-bound reads", () => {
  it.each(
    (["embedded", "codex-host", "copilot-host"] as const).flatMap((toolOwner) =>
      (["warm", "hydrated"] as const).map((reuse) => ({ toolOwner, reuse })),
    ),
  )(
    "reads the pinned revision whole through $toolOwner with a $reuse snapshot without expanding model visibility",
    async ({ toolOwner, reuse }) => {
      const createTools = async (
        options: NonNullable<Parameters<typeof createOpenClawCodingToolsInternal>[0]>,
        resources: Parameters<typeof createOpenClawCodingToolsInternal>[1],
      ) => {
        if (toolOwner === "embedded") {
          return createOpenClawCodingToolsInternal(options, resources);
        }
        const hostSnapshot = structuredClone(options.skillsSnapshot);
        const host = await createAdmittedHostCapabilityTestFixture({
          agentId: "main",
          runId: `manual-${toolOwner}-${reuse}-${hosts.length}`,
          config: options.config,
          workspaceDir: options.workspaceDir,
          skillsSnapshot: hostSnapshot,
        });
        hosts.push(host);
        // Plugin-visible inputs may change after handoff; the host keeps this turn
        // on its captured selection rather than adopting a later mutation.
        if (hostSnapshot) {
          hostSnapshot.librarySelections = [];
          hostSnapshot.resolvedSkills = [];
        }
        const { skillsSnapshot, ...rest } = options;
        // Codex supplies the prompt snapshot; Copilot must also work when its
        // factory options omit it. Neither caller supplies private read resources.
        return host.hostCapabilities.createToolSurface!({
          ...rest,
          ...(toolOwner === "codex-host" ? { skillsSnapshot } : {}),
        });
      };
      const root = temps.make("manual-library-read-");
      const workspaceDir = path.join(root, "workspace");
      const stateDir = path.join(root, "state");
      const emptyPlugins = path.join(root, "empty-plugins");
      await Promise.all(
        [workspaceDir, stateDir, emptyPlugins].map((dir) => fs.mkdir(dir, { recursive: true })),
      );
      for (const [key, value] of Object.entries({
        HOME: root,
        OPENCLAW_HOME: root,
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_CONFIG_PATH: path.join(root, "openclaw.json"),
        OPENCLAW_BUNDLED_PLUGINS_DIR: emptyPlugins,
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      })) {
        vi.stubEnv(key, value);
      }
      const visibleRoot = path.join(root, "visible-skills");
      const visiblePath = path.join(visibleRoot, "visible", "SKILL.md");
      const visibleContent =
        "---\nname: visible\ndescription: Ordinary visible procedure\n---\n# Visible instructions\n";
      await fs.mkdir(path.dirname(visiblePath), { recursive: true });
      await fs.writeFile(visiblePath, visibleContent);
      const config: OpenClawConfig = {
        agents: { defaults: { workspace: workspaceDir } },
        plugins: { enabled: false },
        skills: { allowBundled: [], load: { watch: false, extraDirs: [visibleRoot] } },
        tools: {
          fs: { workspaceOnly: true },
          exec: { applyPatch: { enabled: true, workspaceOnly: true } },
        },
      };
      const actor = (email: string): SkillLibraryAuthority => ({
        profileId: ensureProfileForEmail(email).id,
        scopes: ["operator.read", "operator.write"],
        getConfig: () => config,
        assertCurrent: () => {},
      });
      const alice = actor("alice@example.test");
      const bob = actor("bob@example.test");
      const saved = await saveSkillLibrary(alice, {
        slug: "manual-guide",
        content: instructions,
        files: supporting,
        expectedRevision: null,
      });
      const pins = changeSkillLibrarySelection(alice, [], {
        action: "attach",
        sessionKey: "agent:main:manual",
        skillId: saved.entry.skillId,
      });
      const newer = await saveSkillLibrary(alice, {
        skillId: saved.entry.skillId,
        slug: "manual-guide",
        expectedRevision: saved.entry.revision,
        content: instructions.replaceAll("R1", "R2"),
        files: supporting.map((file) => ({
          ...file,
          content: file.content.replaceAll("R1", "R2"),
        })),
      });
      const other = await saveSkillLibrary(bob, {
        slug: "other-guide",
        content: instructions,
        files: supporting,
        expectedRevision: null,
      });
      const snapshotInputs = {
        workspaceDir,
        config,
        agentId: "main",
        librarySelections: pins,
        watch: false,
      };
      const initial = resolveReusableWorkspaceSkillSnapshot(snapshotInputs).snapshot;
      const snapshot = resolveReusableWorkspaceSkillSnapshot({
        ...snapshotInputs,
        existingSnapshot: reuse === "warm" ? initial : { ...initial, resolvedSkills: undefined },
      }).snapshot;
      expect(snapshot.prompt).toBe(initial.prompt);
      expect(snapshot.skills.map((skill) => skill.name)).toContain(saved.entry.name);
      expect(snapshot.resolvedSkills?.map((skill) => skill.name)).not.toContain(saved.entry.name);
      const invocation = resolveSkillCommandInvocation({
        commandBodyNormalized: `/skill ${saved.entry.name} use the pinned resources`,
        skillCommands: listSkillCommandsForWorkspace({
          workspaceDir,
          cfg: config,
          agentId: "main",
          sessionEntry: { skillLibrarySelections: pins },
        }),
      });
      const instructionPath = path.join(
        skillLibraryRevisionDir(saved.entry.skillId, saved.entry.revision),
        "SKILL.md",
      );
      expect(invocation?.command.skillFile).toBe(instructionPath);
      const prepared = prepareEmbeddedSkills({
        attempt: { config, skillsSnapshot: snapshot },
        effectiveWorkspace: workspaceDir,
        sandbox: undefined,
        sessionAgentId: "main",
        includeCodeModeSkills: true,
      });
      try {
        expect(prepared.skillsPrompt).toBe(snapshot.prompt.trim());
        expect(prepared.skillsPrompt).not.toContain(saved.entry.name);
        expect(prepared.codeModeSkills.map((skill) => skill.name)).not.toContain(saved.entry.name);
        expect(prepared.codeModeSkills.map((skill) => skill.name)).toContain("visible");
        const tools = await createTools(
          {
            codeModeSkills: prepared.codeModeSkills,
            skillUsagePaths: prepared.skillUsagePaths,
            workspaceDir,
            config,
            modelProvider: "openai",
            modelId: "test-model",
            skillsSnapshot: prepared.skillsSnapshotForRun,
          },
          prepared.skillReadResources,
        );
        const read = tools.find((tool) => tool.name === "read")!;
        expect(read).toBeDefined();
        // Real publication -> exact session pin -> snapshot -> preparation -> registered read.
        // Paging must not truncate SKILL.md, even though it is absent from the model catalog.
        expect(
          getTextContent(
            await read.execute("manual-instructions", {
              path: invocation!.command.skillFile,
              offset: 3,
              limit: 1,
            }),
          ),
        ).toBe(instructions);
        for (const file of supporting) {
          expect(
            getTextContent(
              await read.execute("manual-support", {
                path: path.join(path.dirname(instructionPath), file.path),
              }),
            ),
          ).toBe(file.content);
        }
        expect(
          getTextContent(await read.execute("visible-read", { path: visiblePath, limit: 1 })),
        ).toBe(visibleContent);
        const outside = path.join(root, "unrelated.txt");
        await fs.writeFile(outside, "unrelated private file");
        for (const denied of [
          outside,
          path.join(skillLibraryRevisionDir(newer.entry.skillId, newer.entry.revision), "SKILL.md"),
          path.join(skillLibraryRevisionDir(other.entry.skillId, other.entry.revision), "SKILL.md"),
        ]) {
          await expect(read.execute("denied-read", { path: denied })).rejects.toThrow(
            /Path escapes sandbox root/i,
          );
        }
        await expect(
          read.execute("traversal", {
            path: path.join(path.dirname(instructionPath), "..", newer.entry.revision, "SKILL.md"),
          }),
        ).rejects.toThrow(/Path escapes sandbox root/i);
        const requireTool = (name: string) => {
          const tool = tools.find((candidate) => candidate.name === name);
          expect(tool, name).toBeDefined();
          return tool!;
        };
        await expect(
          requireTool("ls").execute("list-library", { path: path.dirname(instructionPath) }),
        ).rejects.toThrow(/Path escapes sandbox root/i);
        await expect(
          requireTool("write").execute("write-library", {
            path: instructionPath,
            content: "REPLACED",
          }),
        ).rejects.toThrow(/Path escapes sandbox root|outside-workspace/i);
        await expect(
          requireTool("edit").execute("edit-library", {
            path: instructionPath,
            edits: [{ oldText: "R1", newText: "REPLACED" }],
          }),
        ).rejects.toThrow(/Path escapes sandbox root|outside-workspace/i);
        await expect(
          requireTool("apply_patch").execute("patch-library", {
            input: `*** Begin Patch\n*** Update File: ${instructionPath}\n@@\n-# R1 instructions\n+# REPLACED\n*** End Patch`,
          }),
        ).rejects.toThrow(/Path escapes sandbox root|outside-workspace/i);
        expect(await fs.readFile(instructionPath, "utf8")).toBe(instructions);

        for (const overrides of [
          { skillFilter: ["visible"] },
          { skillOverrides: { [saved.entry.name]: false } },
        ]) {
          const filtered = resolveReusableWorkspaceSkillSnapshot({
            ...snapshotInputs,
            ...overrides,
          }).snapshot;
          expect(filtered.skills.map((skill) => skill.name)).not.toContain(saved.entry.name);
          const filteredPrepared = prepareEmbeddedSkills({
            attempt: { config, skillsSnapshot: filtered },
            effectiveWorkspace: workspaceDir,
            sandbox: undefined,
            sessionAgentId: "main",
            includeCodeModeSkills: true,
          });
          try {
            const filteredRead = (
              await createTools(
                {
                  codeModeSkills: filteredPrepared.codeModeSkills,
                  skillUsagePaths: filteredPrepared.skillUsagePaths,
                  workspaceDir,
                  config,
                  skillsSnapshot: filteredPrepared.skillsSnapshotForRun,
                },
                filteredPrepared.skillReadResources,
              )
            ).find((tool) => tool.name === "read")!;
            await expect(
              filteredRead.execute("filtered", { path: instructionPath }),
            ).rejects.toThrow(/Path escapes sandbox root/i);
            expect(
              (await prepareSkillResourceDelivery(filtered, () => {}))?.skills.map(
                (skill) => skill.name,
              ),
            ).not.toContain(saved.entry.name);
          } finally {
            filteredPrepared.restoreSkillEnv();
          }
        }
        const deniedPreparation = prepareEmbeddedSkills({
          attempt: { config, skillsSnapshot: snapshot, toolExecutionAllow: ["write"] },
          effectiveWorkspace: workspaceDir,
          sandbox: undefined,
          sessionAgentId: "main",
          includeCodeModeSkills: true,
        });
        expect(deniedPreparation.skillReadResources).toBeUndefined();
        expect(deniedPreparation.skillsSnapshotForRun).toBeUndefined();
        expect(deniedPreparation.codeModeSkills).toEqual([]);

        const parentKey = "agent:main:manual-parent";
        const childKey = "agent:main:subagent:manual-child";
        await upsertSessionEntryCore(
          { agentId: "main", sessionKey: parentKey },
          { sessionId: "manual-parent-id", updatedAt: Date.now(), skillLibrarySelections: pins },
        );
        const child = await createInitialSubagentSession({
          cfg: config,
          targetAgentId: "main",
          childSessionKey: childKey,
          incognito: false,
          requesterInternalKey: parentKey,
          completionOwnerSessionKey: parentKey,
          creationPolicy: { actor: { type: "agent", id: "main" } },
          modelPatch: {},
          collect: false,
        });
        expect(child.status).toBe("ok");
        const childEntry = loadSessionEntry({ agentId: "main", sessionKey: childKey });
        expect(childEntry?.skillLibrarySelections).toEqual(pins);
        const childSnapshot = resolveReusableWorkspaceSkillSnapshot({
          ...snapshotInputs,
          librarySelections: childEntry!.skillLibrarySelections,
        }).snapshot;
        const childPrepared = prepareEmbeddedSkills({
          attempt: { config, skillsSnapshot: childSnapshot },
          effectiveWorkspace: workspaceDir,
          sandbox: undefined,
          sessionAgentId: "main",
          includeCodeModeSkills: true,
        });
        try {
          const childRead = (
            await createTools(
              {
                codeModeSkills: childPrepared.codeModeSkills,
                skillUsagePaths: childPrepared.skillUsagePaths,
                workspaceDir,
                config,
                skillsSnapshot: childPrepared.skillsSnapshotForRun,
              },
              childPrepared.skillReadResources,
            )
          ).find((tool) => tool.name === "read")!;
          expect(
            getTextContent(
              await childRead.execute("child-pinned-read", { path: instructionPath, limit: 1 }),
            ),
          ).toBe(instructions);
          expect(childPrepared.skillsPrompt).not.toContain(saved.entry.name);
        } finally {
          childPrepared.restoreSkillEnv();
        }

        // Pin survival across unshare/removal is intentional; current library defaults are not revocation.
        for (const action of ["share", "unshare", "remove"] as const) {
          mutateSkillLibrary(alice, {
            skillId: saved.entry.skillId,
            expectedRevision: newer.entry.revision,
            action,
          });
        }
        const delivery = await prepareSkillResourceDelivery(snapshot, () => {});
        const delivered = delivery!.skills.find((skill) => skill.name === saved.entry.name)!;
        expect(delivered.modelVisible).toBe(false);
        expect(delivered.revision).toBe(saved.entry.revision);
        const worker = await materializeSkillResources(delivery!, () => {});
        try {
          expect(worker.snapshot.prompt).not.toContain(saved.entry.name);
          const materialized = worker.snapshot.resolvedSkills!.find(
            (skill) => skill.name === saved.entry.name,
          )!;
          expect(materialized.contentHash).toBe(saved.entry.revision);
          const workerRead = createOpenClawCodingTools({
            workspaceDir,
            config,
            skillsSnapshot: worker.snapshot,
          }).find((tool) => tool.name === "read")!;
          expect(
            getTextContent(
              await workerRead.execute("worker-read", { path: materialized.filePath, limit: 1 }),
            ),
          ).toBe(instructions);
        } finally {
          await worker.cleanup();
        }

        if (process.platform !== "win32") {
          const escapeLink = path.join(path.dirname(instructionPath), "escape.md");
          const containedLink = path.join(path.dirname(instructionPath), "contained.md");
          await fs.symlink(outside, escapeLink);
          await fs.symlink("references/guide.md", containedLink);
          await expect(read.execute("symlink-escape", { path: escapeLink })).rejects.toThrow(
            /symlink|sandbox|outside|escape/i,
          );
          // The existing regular-file reader rejects final symlinks, even within an allowed root.
          await expect(read.execute("contained-link", { path: containedLink })).rejects.toThrow(
            /regular file/i,
          );
        }
        if (toolOwner !== "embedded") {
          hosts[0]!.closeHost();
          await expect(read.execute("closed-host-read", { path: instructionPath })).rejects.toThrow(
            /no longer active/,
          );
        }
      } finally {
        prepared.restoreSkillEnv();
      }
    },
  );
});

const unavailableSnapshot: SkillSnapshot = {
  prompt: "",
  skills: [{ name: "unavailable-host-pin" }],
  resolvedSkills: [],
  librarySelections: [
    {
      skillId: "11111111-1111-4111-8111-111111111111",
      revision: "f".repeat(64),
      name: "unavailable-host-pin",
      ownerProfileId: null,
    },
  ],
};

async function setup(runId: string) {
  const root = temps.make("host-skill-resources-");
  const workspaceDir = path.join(root, "workspace");
  await fs.mkdir(workspaceDir);
  vi.stubEnv("OPENCLAW_STATE_DIR", path.join(root, "state"));
  const config: OpenClawConfig = {
    agents: { defaults: { workspace: workspaceDir } },
    plugins: { enabled: false },
    tools: { fs: { workspaceOnly: true } },
  };
  return { runId, workspaceDir, config, skillsSnapshot: unavailableSnapshot };
}

describe("host skill resource construction boundaries", () => {
  it("does not resolve host pins for a surface without filesystem tools", async () => {
    const attempt = await setup("host-no-fs");
    const host = await createAdmittedHostCapabilityTestFixture(attempt);
    hosts.push(host);
    const tools = host.hostCapabilities.createToolSurface!({
      config: attempt.config,
      workspaceDir: attempt.workspaceDir,
      includeCoreTools: false,
      toolConstructionPlan: {
        includeBaseCodingTools: false,
        includeShellTools: false,
        includeChannelTools: false,
        includeOpenClawTools: false,
        includePluginTools: false,
      },
    });
    expect(tools).toEqual([]);
  });

  it.each([false, true])(
    "keeps sandbox reads independent of host pins (pre-resolved: %s)",
    async (preResolved) => {
      const attempt = await setup("host-sandbox");
      await fs.writeFile(path.join(attempt.workspaceDir, "local.txt"), "sandbox content");
      const sandbox = createAgentToolsSandboxContext({
        workspaceDir: attempt.workspaceDir,
        agentWorkspaceDir: attempt.workspaceDir,
        workspaceAccess: "rw",
        fsBridge: createHostSandboxFsBridge(attempt.workspaceDir),
        tools: { allow: [], deny: [] },
      });
      const host = await createAdmittedHostCapabilityTestFixture({
        ...attempt,
        ...(preResolved ? { sandbox } : {}),
      });
      hosts.push(host);
      const tools = host.hostCapabilities.createToolSurface!({
        workspaceDir: attempt.workspaceDir,
        config: attempt.config,
        sandbox,
      });
      const read = tools.find((tool) => tool.name === "read");
      expect(read).toBeDefined();
      expect(getTextContent(await read!.execute("sandbox-read", { path: "local.txt" }))).toBe(
        "sandbox content",
      );
    },
  );
});
