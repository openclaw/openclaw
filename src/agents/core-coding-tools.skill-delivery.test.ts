import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createCanonicalFixtureSkill } from "../skills/test-support/test-helpers.js";
import { createCoreCodingTools } from "./core-coding-tools.js";
import { reconcileSkillInstructionDelivery } from "./skill-instruction-result.js";

const INSTRUCTIONS = "# Pond\nRead the pond gauge.\n";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function textOf(result: { content: unknown }): string {
  return (result.content as { type: string; text?: string }[])
    .map((part) => (part.type === "text" ? (part.text ?? "") : ""))
    .join("");
}

async function productionSkillReadTool(runId: string | undefined) {
  const root = await fs.realpath(tempDirs.make("openclaw-skill-delivery-"));
  const filePath = path.join(root, "SKILL.md");
  await fs.writeFile(filePath, INSTRUCTIONS);
  const skill = createCanonicalFixtureSkill({
    name: "pond",
    description: "Pond",
    filePath,
    baseDir: root,
    source: "bundled",
  });
  skill.readContent = INSTRUCTIONS;
  const tools = createCoreCodingTools({
    codingRoot: root,
    containmentRoot: root,
    includeBaseCodingTools: true,
    shellTools: "disabled",
    workspaceOnly: false,
    readOnly: false,
    applyPatchEnabled: false,
    applyPatchWorkspaceOnly: true,
    execDefaults: {},
    processDefaults: {},
    runId,
    skillReadResources: [skill],
    skillInstructionPaths: [filePath],
    skillInstructionDeliveryCache: new Map(),
  });
  return { filePath, tool: tools.find((entry) => entry.name === "read")! };
}

it("scopes skill delivery records to the attempt that built the production tools", async () => {
  const { filePath, tool } = await productionSkillReadTool("run-a");
  expect(textOf(await tool.execute("call_1", { path: filePath }))).toContain("Read the pond gauge");

  // A sibling attempt reconciling the same bare tool-call id must not consume this run's record.
  reconcileSkillInstructionDelivery({
    runId: "run-b",
    toolCallId: "call_1",
    deliveredText: undefined,
  });
  expect(textOf(await tool.execute("call_1", { path: filePath }))).toContain(
    "already served whole",
  );

  // The owning attempt reports a shortened copy, so the receipt is dropped and the whole
  // document is served again.
  reconcileSkillInstructionDelivery({
    runId: "run-a",
    toolCallId: "call_1",
    deliveredText: undefined,
  });
  expect(textOf(await tool.execute("call_1", { path: filePath }))).toContain("Read the pond gauge");
});
