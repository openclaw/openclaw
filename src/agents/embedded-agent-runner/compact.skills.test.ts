import fs from "node:fs/promises";
import path from "node:path";
import { beforeAll, beforeEach, expect, it } from "vitest";
import { useCompactHooksSessionFixture } from "./compact.hooks.fixture.test-support.js";
import {
  buildConfiguredAgentSystemPromptMock,
  loadCompactHooksHarness,
  resolveSandboxContextMock,
  sessionManualCompactionMock,
} from "./compact.hooks.harness.js";

const sessionKey = "agent:main:compact-skills";
const fixture = useCompactHooksSessionFixture(sessionKey);
let compact: Awaited<
  ReturnType<typeof loadCompactHooksHarness>
>["compactEmbeddedAgentSessionDirect"];
let storePath: string;
let prepared: Awaited<ReturnType<typeof fixture.prepareSession>>;
beforeAll(async () => {
  compact = (await loadCompactHooksHarness({ realSkills: true })).compactEmbeddedAgentSessionDirect;
  storePath = await fixture.prepare();
});
beforeEach(async () => {
  prepared = await fixture.prepareSession();
});

it("compacts a persisted selected-skill session and delivers its pinned revision to the sandbox", async () => {
  const { saveSkillLibrary } = await import("../../skills/library/service.js");
  const { changeSkillLibrarySelection } = await import("../../skills/library/selection.js");
  const { ensureProfileForEmail } = await import("../../state/user-profiles.js");
  const { resolveReusableWorkspaceSkillSnapshot } =
    await import("../../skills/runtime/session-snapshot.js");
  const { syncWorkspaceSkills } =
    await import("../../skills/loading/workspace-skill-sync.runtime.js");
  const { stripRuntimeOnlySessionSkillsFields } =
    await import("../../config/sessions/store-entry-shape.js");
  const { createSandboxTestContext } = await import("../sandbox/test-fixtures.js");
  const { loadSessionEntry, upsertSessionEntryCore } =
    await import("../../config/sessions/session-accessor.js");
  const config = {
    agents: { defaults: { workspace: prepared.workspaceDir } },
    plugins: { enabled: false },
    skills: { allowBundled: [], load: { watch: false } },
  };
  const authority = {
    profileId: ensureProfileForEmail("compaction@example.test").id,
    scopes: ["operator.read", "operator.write"],
    getConfig: () => config,
    assertCurrent: () => {},
  };
  const content =
    "---\nname: selected\ndescription: Pinned compaction instructions\n---\nKEEP R1\n";
  const saved = await saveSkillLibrary(authority, {
    slug: "selected",
    content,
    expectedRevision: null,
  });
  const librarySelections = await changeSkillLibrarySelection(authority, [], {
    action: "attach",
    sessionKey,
    skillId: saved.entry.skillId,
  });
  const { snapshot } = await resolveReusableWorkspaceSkillSnapshot({
    workspaceDir: prepared.workspaceDir,
    config,
    agentId: "main",
    librarySelections,
    skillFilter: [saved.entry.name],
    watch: false,
  });
  expect(snapshot.skills.map((skill) => skill.name)).toEqual([saved.entry.name]);
  await saveSkillLibrary(authority, {
    skillId: saved.entry.skillId,
    slug: "selected",
    content: content.replace("R1", "R2"),
    expectedRevision: saved.entry.revision,
  });
  const sessionTarget = { agentId: "main", sessionId: prepared.sessionId, sessionKey, storePath };
  await upsertSessionEntryCore(
    sessionTarget,
    stripRuntimeOnlySessionSkillsFields({
      sessionId: prepared.sessionId,
      updatedAt: 1,
      skillsSnapshot: snapshot,
      skillLibrarySelections: librarySelections,
    }),
  );
  const entry = loadSessionEntry(sessionTarget)!;
  expect(entry.skillsSnapshot?.resolvedSkills).toBeUndefined();
  const sandboxDir = path.join(prepared.workspaceDir, "sandbox");
  // Only container provisioning is replaced. Real sync, hydration, mapping and compaction preparation run.
  resolveSandboxContextMock.mockImplementationOnce(async (params) => {
    const skillUsagePaths = await syncWorkspaceSkills({
      sourceWorkspaceDir: prepared.workspaceDir,
      targetWorkspaceDir: sandboxDir,
      config,
      agentId: "main",
      skillsSnapshot: params.skillsSnapshot,
      assertCurrent: params.assertCurrent,
    });
    expect(skillUsagePaths).toHaveLength(1);
    expect(await fs.readFile(skillUsagePaths[0]!.readPath, "utf8")).toContain("KEEP R1");
    return createSandboxTestContext({
      overrides: {
        sessionKey,
        workspaceDir: sandboxDir,
        agentWorkspaceDir: prepared.workspaceDir,
        workspaceAccess: "none",
        skillsWorkspaceDir: sandboxDir,
        skillUsagePaths,
      },
    });
  });
  const result = await compact({
    ...sessionTarget,
    sessionTarget,
    sessionFile: sessionKey,
    workspaceDir: prepared.workspaceDir,
    config,
    sessionEntry: entry,
    skillsSnapshot: entry.skillsSnapshot,
    trigger: "manual",
    force: true,
  });
  expect(result, result.reason).toMatchObject({ ok: true, compacted: true });
  expect(sessionManualCompactionMock).toHaveBeenCalledOnce();
  const prompt = buildConfiguredAgentSystemPromptMock.mock.calls.at(-1)?.[0]?.skillsPrompt;
  expect(prompt).toContain("selected");
  expect(prompt).toContain("/workspace/");
  expect(prompt).not.toContain(prepared.workspaceDir);
  expect(loadSessionEntry(sessionTarget)?.skillsSnapshot).toEqual(entry.skillsSnapshot);
});

it("keeps an explicit empty snapshot from discovering workspace instructions", async () => {
  const skillDir = path.join(prepared.workspaceDir, "skills", "ambient");
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(
    path.join(skillDir, "SKILL.md"),
    "---\nname: ambient\ndescription: Must remain excluded\n---\nUnselected instructions\n",
  );
  const result = await compact({
    agentId: "main",
    sessionId: prepared.sessionId,
    sessionKey,
    sessionTarget: { agentId: "main", sessionId: prepared.sessionId, sessionKey, storePath },
    sessionFile: sessionKey,
    workspaceDir: prepared.workspaceDir,
    config: {
      agents: { defaults: { workspace: prepared.workspaceDir } },
      plugins: { enabled: false },
      skills: { allowBundled: [], load: { watch: false } },
    },
    skillsSnapshot: { prompt: "", skills: [] },
    trigger: "manual",
    force: true,
  });
  expect(result, result.reason).toMatchObject({ ok: true, compacted: true });
  expect(buildConfiguredAgentSystemPromptMock.mock.calls.at(-1)?.[0]?.skillsPrompt).toBe("");
});
