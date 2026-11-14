import assert from "node:assert/strict";
import { collectForRetentionCheck } from "../test-utils/retention.js";
import { applyCodeModeCatalog, createCodeModeTools } from "./code-mode.js";
import { Agent } from "./runtime/index.js";
import { createResourceLoader } from "./sessions/agent-session-loop-resource-loader.test-support.js";
import { AgentSession } from "./sessions/agent-session.js";
import { AuthStorage } from "./sessions/auth-storage.js";
import type { ExtensionRunner } from "./sessions/extensions/runner.js";
import { ModelRegistry } from "./sessions/model-registry.js";
import { SessionManager } from "./sessions/session-manager.js";
import { SettingsManager } from "./sessions/settings-manager.js";
import { createToolDefinitionFromAgentTool } from "./sessions/tools/tool-definition-wrapper.js";
import { createStubTool } from "./test-helpers/agent-tool-stubs.js";
import { clearToolSearchCatalog, createToolSearchCatalogRef } from "./tool-search-catalog.js";

function collected(...references: WeakRef<object>[]) {
  for (const reference of references) {
    assert.equal(reference.deref(), undefined, "Obsolete object must collect");
  }
}

function createScenario(resourceLoader: Awaited<ReturnType<typeof createResourceLoader>>) {
  const context = {
    config: { tools: { codeMode: true, toolSearch: false } },
    catalogRef: createToolSearchCatalogRef(),
    sessionId: "description-retention-session",
    sessionKey: "agent:main:description-retention",
    runId: "description-retention-run",
  };
  const exec = applyCodeModeCatalog({
    ...context,
    tools: [...createCodeModeTools(context), createStubTool("retention_target")],
  }).tools.find((tool) => tool.name === "exec");
  assert.ok(exec);
  const extensionRunnerRef: { current?: ExtensionRunner } = {};
  const agent = new Agent({
    streamFn: () => {
      throw new Error("This lifecycle fixture must not invoke a provider");
    },
  });
  const session = new AgentSession({
    systemPrompt: "Prepared Code Mode prompt",
    agent,
    cwd: process.cwd(),
    sessionManager: SessionManager.inMemory(process.cwd()),
    settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }),
    modelRegistry: ModelRegistry.inMemory(AuthStorage.inMemory()),
    resourceLoader,
    customTools: [createToolDefinitionFromAgentTool(exec)],
    allowedToolNames: ["exec"],
    extensionRunnerRef,
  });
  function current() {
    const tool = agent.state.tools.find((item) => item.name === "exec");
    assert.ok(tool);
    return tool;
  }
  const wrappers = [new WeakRef(current())];
  assert.ok(extensionRunnerRef.current);
  const runners = [new WeakRef(extensionRunnerRef.current)];
  let held: ReturnType<typeof current> | undefined = current();
  return {
    wrappers,
    runners,
    refresh() {
      resourceLoader.getExtensions().runtime.refreshTools();
      wrappers.push(new WeakRef(current()));
    },
    async reload() {
      await session.reload();
      wrappers.push(new WeakRef(current()));
      assert.ok(extensionRunnerRef.current);
      runners.push(new WeakRef(extensionRunnerRef.current));
    },
    releaseHeld() {
      assert.ok(held);
      held = undefined;
    },
    dispose() {
      clearToolSearchCatalog(context);
      session.dispose();
    },
  };
}

let scenario: ReturnType<typeof createScenario> | undefined;
// Do not retain the observed session as the result of an awaited setup promise.
await createResourceLoader().then((resourceLoader) => {
  scenario = createScenario(resourceLoader);
});
try {
  assert.ok(scenario);
  scenario.refresh();
  await scenario.reload();
  await scenario.reload();
  const control = new WeakRef({ unowned: true });
  await collectForRetentionCheck("description-replaced");
  const [heldWrapper, refreshedWrapper, reloadedWrapper] = scenario.wrappers;
  const [heldRunner, replacedRunner] = scenario.runners;
  assert.ok(heldWrapper && refreshedWrapper && reloadedWrapper && heldRunner && replacedRunner);
  collected(control, refreshedWrapper, reloadedWrapper, replacedRunner);
  assert.ok(heldWrapper.deref(), "Externally held wrapper remains usable");
  assert.ok(heldRunner.deref(), "Held wrapper still owns its execution context");
  scenario.releaseHeld();
  await collectForRetentionCheck("description-released");
  collected(heldWrapper, heldRunner);
  const { wrappers, runners } = scenario;
  scenario.dispose();
  scenario = undefined;
  await collectForRetentionCheck("description-disposed");
  collected(...wrappers, ...runners);
  process.stdout.write(JSON.stringify({ obsoleteWrappersReleased: true }));
} finally {
  scenario?.dispose();
}
