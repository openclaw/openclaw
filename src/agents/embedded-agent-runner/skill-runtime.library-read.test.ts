import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
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
import { hasOpenClawAgentDatabaseAsyncResources } from "../../state/openclaw-agent-db-resources.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
} from "../../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../../state/openclaw-state-db.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { createOpenClawCodingTools, createOpenClawCodingToolsInternal } from "../agent-tools.js";
import { createAdmittedHostCapabilityTestFixture } from "../harness/host-capability.test-support.js";
import { getTextContent } from "../test-helpers/agent-tools-fs-helpers.js";
import { createAgentToolsSandboxContext } from "../test-helpers/agent-tools-sandbox-context.js";
import { createHostSandboxFsBridge } from "../test-helpers/host-sandbox-fs-bridge.js";
import { prepareEmbeddedSkills } from "./skill-runtime.js";

const hosts: Array<Awaited<ReturnType<typeof createAdmittedHostCapabilityTestFixture>>> = [];
type Tools = ReturnType<typeof createOpenClawCodingTools>;

function tool(tools: Tools, name = "read") {
  const found = tools.find((candidate) => candidate.name === name);
  expect(found, name).toBeDefined();
  return found!;
}

async function readText(
  tools: Tools,
  file: string,
  paging: { offset?: number; limit?: number } = {},
) {
  return getTextContent(await tool(tools).execute(file, { path: file, ...paging }));
}

function revisionFile(entry: { skillId: string; revision: string }) {
  return path.join(skillLibraryRevisionDir(entry.skillId, entry.revision), "SKILL.md");
}

const temps = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    for (const host of hosts.splice(0)) {
      host.closeHost();
      host.closeAdmission();
    }
    await closeOpenClawAgentDatabasesAsync();
    closeOpenClawAgentDatabasesForTest();
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    clearRuntimeConfigSnapshot();
    vi.unstubAllEnvs();
    expect(
      hasOpenClawAgentDatabaseAsyncResources(),
      "fixture workers must settle before root deletion",
    ).toBe(false);
    cleanup();
  }),
);

describe("manual library resources through embedded and host-bound reads", () => {
  it.each([
    { toolOwner: "embedded", reuse: "warm" },
    { toolOwner: "codex-host", reuse: "hydrated" },
    { toolOwner: "copilot-host", reuse: "warm" },
  ] as const)(
    "reads the pinned revision whole through $toolOwner with a $reuse snapshot without expanding model visibility",
    async ({ toolOwner, reuse }) => {
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
      setRuntimeConfigSnapshot(config);
      const actor = (email: string): SkillLibraryAuthority => ({
        profileId: ensureProfileForEmail(email).id,
        scopes: ["operator.read", "operator.write"],
        getConfig: () => config,
        assertCurrent: () => {},
      });
      const alice = actor("alice@example.test");
      const bob = actor("bob@example.test");
      const publish = (
        owner: SkillLibraryAuthority,
        changes: Partial<Parameters<typeof saveSkillLibrary>[1]> = {},
      ) =>
        saveSkillLibrary(owner, {
          slug: "manual-guide",
          expectedRevision: null,
          content: instructions,
          files: supporting,
          ...changes,
        });
      const saved = await publish(alice);
      const pins = await changeSkillLibrarySelection(alice, [], {
        action: "attach",
        sessionKey: "agent:main:manual",
        skillId: saved.entry.skillId,
      });
      const newer = await publish(alice, {
        skillId: saved.entry.skillId,
        expectedRevision: saved.entry.revision,
        content: instructions.replaceAll("R1", "R2"),
        files: supporting.map((file) => ({
          ...file,
          content: file.content.replaceAll("R1", "R2"),
        })),
      });
      const other = await publish(bob, { slug: "other-guide" });
      const snapshotInputs = {
        workspaceDir,
        config,
        agentId: "main",
        librarySelections: pins,
        watch: false,
      };
      const loadSnapshot = async (
        overrides: Partial<Parameters<typeof resolveReusableWorkspaceSkillSnapshot>[0]> = {},
      ) =>
        (await resolveReusableWorkspaceSkillSnapshot({ ...snapshotInputs, ...overrides })).snapshot;
      const initial = await loadSnapshot();
      const snapshot = await loadSnapshot({
        existingSnapshot: reuse === "warm" ? initial : { ...initial, resolvedSkills: undefined },
      });
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
      const instructionPath = revisionFile(saved.entry);
      const instructionDir = path.dirname(instructionPath);
      expect(invocation?.command.skillFile).toBe(instructionPath);
      const prepare = (skillsSnapshot: SkillSnapshot, toolExecutionAllow?: string[]) =>
        prepareEmbeddedSkills({
          attempt: { config, skillsSnapshot, toolExecutionAllow },
          effectiveWorkspace: workspaceDir,
          sandbox: undefined,
          sessionAgentId: "main",
          includeCodeModeSkills: true,
        });
      const preparedTools = async (
        prepared: Awaited<ReturnType<typeof prepare>>,
        overrides: NonNullable<Parameters<typeof createOpenClawCodingToolsInternal>[0]> = {},
      ) => {
        const options = {
          codeModeSkills: prepared.codeModeSkills,
          skillUsagePaths: prepared.skillUsagePaths,
          workspaceDir,
          config,
          skillsSnapshot: prepared.skillsSnapshotForRun,
          ...overrides,
        };
        if (toolOwner === "embedded") {
          return createOpenClawCodingToolsInternal(options, prepared.skillReadResources);
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
        // The host must retain its capture despite later plugin-visible mutation.
        if (hostSnapshot) {
          hostSnapshot.librarySelections = [];
          hostSnapshot.resolvedSkills = [];
        }
        const { skillsSnapshot, ...rest } = options;
        // Copilot omits the prompt snapshot; neither host caller supplies read resources.
        return host.hostCapabilities.createToolSurface!({
          ...rest,
          ...(toolOwner === "codex-host" ? { skillsSnapshot } : {}),
        });
      };
      const prepared = await prepare(snapshot);
      try {
        expect(prepared.skillsPrompt).toBe(snapshot.prompt.trim());
        expect(prepared.skillsPrompt).not.toContain(saved.entry.name);
        expect(prepared.codeModeSkills.map((skill) => skill.name)).not.toContain(saved.entry.name);
        expect(prepared.codeModeSkills.map((skill) => skill.name)).toContain("visible");
        const tools = await preparedTools(prepared, {
          modelProvider: "openai",
          modelId: "test-model",
        });
        const read = tool(tools);
        // Real publication -> exact session pin -> snapshot -> preparation -> registered read.
        // Paging must not truncate SKILL.md, even though it is absent from the model catalog.
        expect(await readText(tools, invocation!.command.skillFile, { offset: 3, limit: 1 })).toBe(
          instructions,
        );
        for (const file of supporting) {
          expect(await readText(tools, path.join(instructionDir, file.path))).toBe(file.content);
        }
        expect(await readText(tools, visiblePath, { limit: 1 })).toBe(visibleContent);
        const outside = path.join(root, "unrelated.txt");
        await fs.writeFile(outside, "unrelated private file");
        for (const denied of [outside, revisionFile(newer.entry), revisionFile(other.entry)]) {
          await expect(read.execute("denied-read", { path: denied })).rejects.toThrow(
            /Path escapes sandbox root/i,
          );
        }
        await expect(
          read.execute("traversal", {
            path: path.join(instructionDir, "..", newer.entry.revision, "SKILL.md"),
          }),
        ).rejects.toThrow(/Path escapes sandbox root/i);
        await expect(
          tool(tools, "ls").execute("list-library", { path: instructionDir }),
        ).rejects.toThrow(/Path escapes sandbox root/i);
        for (const [name, args] of [
          ["write", { path: instructionPath, content: "REPLACED" }],
          ["edit", { path: instructionPath, edits: [{ oldText: "R1", newText: "REPLACED" }] }],
          [
            "apply_patch",
            {
              input: `*** Begin Patch\n*** Update File: ${instructionPath}\n@@\n-# R1 instructions\n+# REPLACED\n*** End Patch`,
            },
          ],
        ] as const) {
          await expect(tool(tools, name).execute(name, args)).rejects.toThrow(
            /Path escapes sandbox root|outside-workspace/i,
          );
        }
        expect(await fs.readFile(instructionPath, "utf8")).toBe(instructions);

        for (const overrides of [
          { skillFilter: ["visible"] },
          { skillOverrides: { [saved.entry.name]: false } },
        ]) {
          const filtered = await loadSnapshot(overrides);
          expect(filtered.skills.map((skill) => skill.name)).not.toContain(saved.entry.name);
          const filteredPrepared = await prepare(filtered);
          try {
            const filteredRead = tool(await preparedTools(filteredPrepared));
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
        const deniedPreparation = await prepare(snapshot, ["write"]);
        expect(deniedPreparation).toMatchObject({
          skillReadResources: undefined,
          skillsSnapshotForRun: undefined,
          codeModeSkills: [],
        });

        // Pin survival across unshare/removal is intentional; current library defaults are not revocation.
        for (const action of ["share", "unshare", "remove"] as const) {
          await mutateSkillLibrary(alice, {
            skillId: saved.entry.skillId,
            expectedRevision: newer.entry.revision,
            action,
          });
        }
        const delivery = await prepareSkillResourceDelivery(snapshot, () => {});
        const delivered = delivery!.skills.find((skill) => skill.name === saved.entry.name)!;
        expect(delivered).toMatchObject({ modelVisible: false, revision: saved.entry.revision });
        const worker = await materializeSkillResources(delivery!, () => {});
        try {
          expect(worker.snapshot.prompt).not.toContain(saved.entry.name);
          const materialized = worker.snapshot.resolvedSkills!.find(
            (skill) => skill.name === saved.entry.name,
          )!;
          expect(materialized.contentHash).toBe(saved.entry.revision);
          const workerTools = createOpenClawCodingTools({
            workspaceDir,
            config,
            skillsSnapshot: worker.snapshot,
          });
          expect(await readText(workerTools, materialized.filePath, { limit: 1 })).toBe(
            instructions,
          );
        } finally {
          await worker.cleanup();
        }

        if (process.platform !== "win32") {
          const escapeLink = path.join(instructionDir, "escape.md");
          const containedLink = path.join(instructionDir, "contained.md");
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
      expect(await readText(tools, "local.txt")).toBe("sandbox content");
    },
  );
});
