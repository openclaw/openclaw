import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  setRuntimeConfigSnapshot,
  clearRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import { setActiveNodeContexts } from "../../infra/active-node-context.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";
import { testing as cliBackendsTesting } from "../cli-backends.test-support.js";
import { createCliRunnerPrepareFixture } from "../cli-runner.test-helpers.js";
import { setRawCliBackendForPrepareTest } from "./prepare-mcp.test-support.js";
import { prepareCliRunContext } from "./prepare.js";
import {
  resetCliRunnerPrepareTestDeps,
  setCliRunnerPrepareTestDeps,
} from "./prepare.test-support.js";

describe("CLI bootstrap workspace preparation", () => {
  let fixture: ReturnType<typeof createCliRunnerPrepareFixture>;

  beforeEach(() => {
    setRawCliBackendForPrepareTest({
      id: "test-cli",
      pluginId: "test",
      bundleMcp: false,
      nativeToolMode: "always-on",
      config: {
        command: "test-cli",
        args: ["--print"],
        systemPromptArg: "--system-prompt",
        systemPromptWhen: "always",
        sessionMode: "existing",
        output: "text",
        input: "arg",
      },
    });
    setCliRunnerPrepareTestDeps({
      isWorkspaceBootstrapPending: async () => false,
      getActiveMcpLoopbackRuntime: () => undefined,
      loadManifestModelCatalog: () => [],
    });
    setActiveNodeContexts([]);
    setActivePluginRegistry(createTestRegistry());
    fixture = createCliRunnerPrepareFixture((params) => {
      setRuntimeConfigSnapshot(params.config ?? {});
      return prepareCliRunContext({ skillsSnapshot: { prompt: "", skills: [] }, ...params });
    });
  });

  afterEach(async () => {
    await fixture.settle();
    cliBackendsTesting.resetDepsForTest();
    resetCliRunnerPrepareTestDeps();
    clearRuntimeConfigSnapshot();
    setActiveNodeContexts([]);
    setActivePluginRegistry(createTestRegistry());
    await fixture.cleanup();
  });

  it("loads agent bootstrap from its configured workspace and layers execution AGENTS", async () => {
    const canonicalDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-cli-bootstrap-agent-"));
    const executionDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-cli-bootstrap-task-"));
    fs.writeFileSync(path.join(canonicalDir, "AGENTS.md"), "CANONICAL-AGENT-RULE");
    fs.writeFileSync(path.join(canonicalDir, "SOUL.md"), "CANONICAL-SOUL-MARKER");
    fs.writeFileSync(path.join(canonicalDir, "USER.md"), "CANONICAL-USER-MARKER");
    fs.writeFileSync(path.join(canonicalDir, "MEMORY.md"), "CANONICAL-MEMORY-MARKER");
    fs.writeFileSync(path.join(executionDir, "AGENTS.md"), "EXECUTION-PROJECT-RULE");
    fs.writeFileSync(path.join(executionDir, "USER.md"), "EXECUTION-USER-MUST-NOT-OVERRIDE");

    try {
      const context = await fixture.prepare({
        config: {
          agents: {
            defaults: { workspace: canonicalDir },
            entries: { main: { workspace: canonicalDir } },
          },
        },
        workspaceDir: executionDir,
        cwd: executionDir,
      });

      expect(context.systemPrompt).toContain("CANONICAL-AGENT-RULE");
      expect(context.systemPrompt).toContain("CANONICAL-SOUL-MARKER");
      expect(context.systemPrompt).toContain("CANONICAL-USER-MARKER");
      expect(context.systemPrompt).toContain("CANONICAL-MEMORY-MARKER");
      expect(context.systemPrompt).toContain("EXECUTION-PROJECT-RULE");
      expect(context.systemPrompt).not.toContain("EXECUTION-USER-MUST-NOT-OVERRIDE");
    } finally {
      fs.rmSync(canonicalDir, { recursive: true, force: true });
      fs.rmSync(executionDir, { recursive: true, force: true });
    }
  });
});
