import fs from "node:fs/promises";
import path from "node:path";
import {
  createMockPluginRegistry,
  initializeGlobalHookRunner,
  registerSkillsChangeListener,
  resetGlobalHookRunner,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { createOpenClawTestState, type OpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as libraryModule from "./library.js";
import * as skillsRootModule from "./skills-root.js";
import { useWorkshopPluginScope } from "./test-support.js";

vi.mock("openclaw/plugin-sdk/skill-workshop-host-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/skill-workshop-host-runtime")>()),
  recordWorkshopChange: vi.fn(async () => {
    throw new Error("change log unavailable");
  }),
}));

const { scoped } = useWorkshopPluginScope();
const { createWorkshopSkill } = scoped(libraryModule);
const { resolveWorkshopSkillsDir } = scoped(skillsRootModule);

let state: OpenClawTestState;
beforeEach(async () => {
  state = await createOpenClawTestState({ layout: "state-only" });
});
afterEach(async () => {
  resetGlobalHookRunner();
  await state.cleanup();
});

it("refreshes discovery for a committed write even when the change log fails", async () => {
  const hook = vi.fn();
  initializeGlobalHookRunner(
    createMockPluginRegistry([{ hookName: "skill_changed", handler: hook }]),
  );
  const reasons: string[] = [];
  const unregister = registerSkillsChangeListener((event) => reasons.push(event.reason));
  try {
    await expect(
      createWorkshopSkill(
        { config: {}, agentId: "main", actor: "agent" },
        {
          name: "deploy",
          content: "---\nname: deploy\ndescription: Deploy staging builds\n---\n\nRun it.\n",
        },
      ),
    ).rejects.toThrow("change log unavailable");
  } finally {
    unregister();
  }
  await expect(
    fs.readFile(path.join(resolveWorkshopSkillsDir({}, "main"), "deploy", "SKILL.md"), "utf8"),
  ).resolves.toContain("name: deploy");
  expect(reasons).toContain("workshop");
  // As before: an unrecorded change is not announced.
  expect(hook).not.toHaveBeenCalled();
});
