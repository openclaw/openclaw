import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../config/io.js";
import { createOpenClawCodingTools } from "./agent-tools.js";
import { applyEmbeddedAttemptToolsAllow } from "./embedded-agent-runner/run/attempt-tool-construction-plan.js";
import { buildEmbeddedAttemptToolRunContext as buildRunContext } from "./embedded-agent-runner/run/attempt-tool-run-context.js";
import { configureMockSubagentRegistryPersistence } from "./subagent-test-fixtures.test-helpers.js";
import {
  addSubagentRunForTests as addRun,
  getSubagentRunByRunId as getRun,
  resetSubagentRegistryForTests,
} from "./subagents/registry/subagent-registry.test-helpers.js";
import { consumeSwarmStructuredOutput } from "./tools/structured-output-tool.js";

const runId = "collector-tool-contract";
const sessionKey = "agent:main:subagent:collector-contract";
const config = { agents: { entries: { main: {} } }, tools: { swarm: true } };
const schema = {
  type: "object",
  properties: { answer: { type: "string" } },
  required: ["answer"],
  additionalProperties: false,
};
let workspaceDir: string;
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

beforeEach(async () => {
  setRuntimeConfigSnapshot(config);
  workspaceDir = tempDirs.make("collector-tools-");
  await resetSubagentRegistryForTests({ persist: false });
  await configureMockSubagentRegistryPersistence({ persistRegistryRows: () => {} });
});

afterEach(async () => {
  consumeSwarmStructuredOutput(runId);
  await resetSubagentRegistryForTests({ persist: false });
  clearRuntimeConfigSnapshot();
});

it.each<[string[] | undefined]>([[undefined], [[]]])("collector surface %j", async (toolsAllow) => {
  await addRun({ runId, childSessionKey: sessionKey, collect: true, outputSchema: schema });
  const context = buildRunContext({ toolsAllow, swarmCollector: true, swarmOutputSchema: schema });
  const constructedTools = createOpenClawCodingTools({
    ...context,
    config,
    agentId: "main",
    modelProvider: "openai",
    modelId: "gpt-5.6-luna",
    disableMessageTool: true,
    runId,
    sessionKey,
    workspaceDir,
    cwd: workspaceDir,
  });
  const tools = applyEmbeddedAttemptToolsAllow(constructedTools, context.runtimeToolAllowlist);
  const names = tools.map((tool) => tool.name);
  function find(name: string) {
    const tool = tools.find((candidate) => candidate.name === name);
    return expectDefined(tool, name);
  }
  if (toolsAllow) {
    expect(names.toSorted()).toEqual([...toolsAllow, "structured_output"].toSorted());
  }
  for (const forbidden of ["ask_user", "sessions_send", "sessions_yield", "message"]) {
    expect(names).not.toContain(forbidden);
  }
  if (!toolsAllow) {
    expect(names).toEqual(
      expect.arrayContaining(["read", "write", "edit", "apply_patch", "exec", "process"]),
    );
    await find("write").execute("collector-write", { path: "result.txt", content: "proof" });
    const result = await find("read").execute("collector-read", { path: "result.txt" });
    expect(result.content).toContainEqual(
      expect.objectContaining({ type: "text", text: expect.stringContaining("proof") }),
    );
  }
  const output = find("structured_output");
  expect(output.catalogMode).toBe("direct-only");
  const result = await output.execute("collector-result", { result: { answer: "ok" } });
  expect(result.details).toEqual({ status: "recorded" });
  expect(getRun(runId)?.structuredOutput).toEqual({
    structured: { answer: "ok" },
    invalidAttempts: 0,
  });
});
