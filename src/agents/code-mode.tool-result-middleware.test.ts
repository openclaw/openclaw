import fs from "node:fs/promises";
import path from "node:path";
import { Type } from "typebox";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { AgentToolResultMiddlewareEvent } from "../plugins/agent-tool-result-middleware-types.js";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../plugins/hook-runner-global.js";
import type { PluginHookBeforeToolCallEvent } from "../plugins/hook-types.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createProcessSupervisor } from "../process/supervisor/supervisor.js";
import { withEnvAsync } from "../test-utils/env.js";
import { resetProcessRegistryForTests } from "./bash-process-registry.test-support.js";
import { createExecTool } from "./bash-tools.exec-run.js";
import { createSubscribedCodeModeHarness } from "./code-mode.bridge.lifecycle.test-support.js";
import { applyCodeModeCatalog } from "./code-mode.js";
import { resetCodeModeTestState, resultDetails } from "./code-mode.test-support.js";
import { SessionManager } from "./sessions/session-manager.js";
import { createReadTool } from "./sessions/tools/read.js";
import { jsonResult } from "./tools/common.js";

// mock-isolation: own the real supervisor so this test can join every child at teardown.
vi.mock("../process/supervisor/index.js", () => ({ getProcessSupervisor: () => supervisor }));
const supervisor = createProcessSupervisor();
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(async () => {
  await resetCodeModeTestState();
  await supervisor.shutdown();
  resetProcessRegistryForTests();
  resetGlobalHookRunner();
  setActivePluginRegistry(createEmptyPluginRegistry());
});

it.skipIf(process.platform === "win32")(
  "transforms nested shell output once before guest serialization without rewriting other values",
  async () => {
    const cwd = tempDirs.make("code-mode-result-middleware-");
    await withEnvAsync(
      {
        OPENCLAW_HOME: cwd,
        OPENCLAW_STATE_DIR: path.join(cwd, "state"),
        OPENCLAW_EXEC_SHELL_SNAPSHOT: "0",
        SHELL: "/bin/sh",
      },
      async () => {
        const events: AgentToolResultMiddlewareEvent[] = [];
        const command = "printf 'raw shell output'; exit 7";
        const requestedCommand = "printf 'before policy'; exit 7";
        const workdir = path.join(cwd, "shell-cwd");
        await fs.mkdir(workdir);
        const registry = createEmptyPluginRegistry();
        const handler = (event: AgentToolResultMiddlewareEvent) => {
          events.push(structuredClone(event));
          const details = event.result.details;
          if (!details || typeof details !== "object" || !("aggregated" in details)) {
            throw new Error("Expected real shell details");
          }
          return {
            result: {
              ...event.result,
              content: [{ type: "text" as const, text: "filtered shell output" }],
              details: { ...details, aggregated: "filtered shell output" },
            },
          };
        };
        registry.agentToolResultMiddlewares.push({
          pluginId: "shell-filter",
          pluginName: "Shell filter",
          source: "test",
          handler,
          rawHandler: handler,
          runtimes: ["openclaw"],
          scopes: [{ runtimes: ["openclaw"], matcher: ["exec"] }],
        });
        registry.typedHooks.push({
          pluginId: "shell-policy",
          hookName: "before_tool_call",
          matcher: ["exec"],
          source: "test",
          handler: (event: PluginHookBeforeToolCallEvent) =>
            event.params.command === requestedCommand
              ? { params: { ...event.params, command } }
              : undefined,
        });
        setActivePluginRegistry(registry);
        initializeGlobalHookRunner(registry);
        const harness = createSubscribedCodeModeHarness({
          name: "shell-middleware",
          sessionManager: SessionManager.inMemory(cwd),
        });
        const shell = createExecTool({
          host: "gateway",
          mode: "full",
          ask: "off",
          allowBackground: false,
          notifyOnExit: false,
          preparedStoreEnvironment: {},
          preparedSubagentExecution: false,
          cwd,
        });
        const exact = '{ "raw": "raw shell output", "spacing": [1,  2] }\n';
        await fs.writeFile(path.join(cwd, "fixture.json"), exact);
        const read = createReadTool(cwd);
        const schema = {
          name: "schema_result",
          label: "Schema result",
          description: "Return schema-declared fixture data",
          parameters: Type.Object({}),
          outputSchema: Type.Object({ raw: Type.String() }),
          execute: async () => jsonResult({ raw: exact }),
        };
        applyCodeModeCatalog({ ...harness, tools: [...harness.tools, shell, read, schema] });
        const input = { command: requestedCommand, workdir, yieldMs: 1000 };
        const code =
          "const shell = await exec(" +
          JSON.stringify(input) +
          ");" +
          'const failed = await exec({ command: "__openclaw_missing_fixture_command__", yieldMs: 1000 });' +
          'return { shell, failed, file: await read({ path: "fixture.json" }), schema: await schema_result({}) };';
        try {
          const outer = await harness.tools[0]!.execute("outer-cell", { code });
          expect(resultDetails(outer), JSON.stringify(outer)).toMatchObject({
            status: "completed",
            value: {
              shell: {
                aggregated: "filtered shell output",
                status: "completed",
                exitCode: 7,
                cwd: workdir,
              },
              failed: { aggregated: "filtered shell output", status: "failed", exitCode: 127 },
              file: { kind: "text", content: exact },
              schema: { raw: exact },
            },
          });
          expect(events).toHaveLength(2);
          expect(events[0]).toMatchObject({
            toolName: "exec",
            args: { ...input, command },
            cwd: workdir,
            isError: false,
            result: {
              details: {
                aggregated: "raw shell output\n\n(Command exited with code 7)",
                exitCode: 7,
                cwd: workdir,
              },
            },
          });
          expect(events[1]).toMatchObject({
            args: { command: "__openclaw_missing_fixture_command__", yieldMs: 1000 },
            cwd,
            isError: true,
            result: { details: { status: "failed", exitCode: 127 } },
          });
          expect(events[0]?.toolCallId).not.toBe("outer-cell");
          expect(outer.content).toEqual([
            { type: "text", text: expect.stringContaining('"status":"completed"') },
          ]);
        } finally {
          harness.dispose();
        }
      },
    );
  },
);
