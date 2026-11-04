import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { closeSkillsWatchers } from "../skills/runtime/refresh.js";
import { activateWorkshopPluginForTest } from "../skills/test-support/workshop-plugin.test-support.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { createOpenClawTools } from "./openclaw-tools.js";
import { withGatewayToolCallerIdentity } from "./tools/gateway-caller-context.js";

let state: OpenClawTestState;
let config: OpenClawConfig;
let resetWorkshopPlugin: (() => void) | undefined;
const skill = (name: string) =>
  `---\nname: ${name}\ndescription: Deploy staging builds\n---\n\nRun the deployment.\n`;

beforeEach(async () => {
  state = await createOpenClawTestState({
    prefix: "workshop-tool-authority-",
    prepareProfileCatalog: false,
  });
  config = {
    agents: { entries: { main: { workspace: state.workspaceDir } } },
    plugins: { enabled: true, allow: ["skill-workshop"] },
    skills: { load: { watch: false } },
  };
  await state.writeConfig(config);
  setRuntimeConfigSnapshot(config);
  resetWorkshopPlugin = (await activateWorkshopPluginForTest(config)).reset;
});
afterEach(async () => {
  resetWorkshopPlugin?.();
  await closeSkillsWatchers(true);
  await state.cleanup();
});

/**
 * Creates one skill through the loaded plugin's `skill_workshop`, built by the real OpenClaw
 * tool set and invoked under a Gateway caller whose receipt the test can revoke. The receipt is
 * revoked after the skill directory is prepared, so only the pre-write recheck can stop the write.
 */
async function createUnderCaller(name: string, revokeDuringPreparation: boolean) {
  const runId = randomUUID();
  const tool = createOpenClawTools({
    config,
    agentDir: state.agentDir(),
    workspaceDir: state.workspaceDir,
    agentSessionKey: "agent:main:authority",
    runId,
    assertInvocationCurrent: () => {},
    beforeToolCallHookContext: { runId },
  }).find((entry) => entry.name === "skill_workshop");
  expect(tool).toBeDefined();
  const trace: string[] = [];
  let live = true;
  const receiptAuthority = () => {
    trace.push(`check:${live ? "ok" : "revoked"}`);
    return live;
  };
  const skillDir = path.join(state.agentDir(), "workshop-skills", name);
  const realMkdir = fs.mkdir.bind(fs);
  using _ = vi.spyOn(fs, "mkdir").mockImplementation(async (target, options) => {
    const made = await realMkdir(target, options);
    if (String(target) === skillDir && live && revokeDuringPreparation) {
      live = false;
      trace.push("caller:revoked");
    }
    return made;
  });
  const pending = withGatewayToolCallerIdentity(
    { agentId: "main", sessionKey: "agent:main:authority", receiptAuthority },
    () => {
      const call = tool!.execute("authority", { action: "create", name, content: skill(name) });
      trace.push("authority:captured");
      return call;
    },
  );
  const outcome = await pending.then(
    () => "written",
    (error: unknown) => `refused (${error instanceof Error ? error.message : String(error)})`,
  );
  const skillFile = path.join(skillDir, "SKILL.md");
  const exists = await fs.stat(skillFile).then(
    () => true,
    () => false,
  );
  trace.push(outcome, `SKILL.md exists: ${exists}`);
  // Sanitized execution trace for the PR evidence; it carries no paths.
  console.info(`[workshop-authority] ${trace.join(" → ")}`);
  return { outcome, exists, trace };
}

it("writes the skill while the invoking caller stays authorized", async () => {
  const result = await createUnderCaller("authorized", false);
  expect(result.outcome).toBe("written");
  expect(result.exists).toBe(true);
});

it("refuses the write when the caller is revoked during awaited preparation", async () => {
  const result = await createUnderCaller("revoked", true);
  expect(result.trace).toContain("caller:revoked");
  expect(result.outcome).toBe("refused (tool invocation authority is no longer active)");
  expect(result.exists).toBe(false);
});
