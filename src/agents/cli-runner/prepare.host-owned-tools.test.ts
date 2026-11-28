import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import type { resolveMcpLoopbackScopedTools } from "../../gateway/mcp-http.runtime.js";
import type { CliBackendPlugin } from "../../plugins/cli-backend.types.js";
import * as globalHooks from "../../plugins/hook-runner-global.js";
import { testing as cliBackendsTesting } from "../cli-backends.test-support.js";
import { createCliRunnerPrepareFixture } from "../cli-runner.test-helpers.js";
import { mockCliMcpPreparation } from "./prepare-mcp.test-support.js";
import { prepareCliRunContext } from "./prepare.js";
import { resetCliRunnerPrepareTestDeps } from "./prepare.test-support.js";

// mock-isolation: the loopback projection is the subject; prompt tools stay inert.
vi.mock("../openclaw-tools.js", () => ({ createOpenClawToolsAsync: async () => [] }));
// mock-isolation: coding tools stay inert so no host shell is assembled.
vi.mock("../agent-tools.async.js", () => ({
  createOpenClawCodingToolsInternalAsync: async () => [],
}));

vi.mock("../../plugins/hook-runner-global.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/hook-runner-global.js")>()),
  getGlobalHookRunner: vi.fn(() => null),
}));

let fixture: ReturnType<typeof createCliRunnerPrepareFixture>;

function registerBackend(backend: CliBackendPlugin & { pluginId: string }) {
  cliBackendsTesting.setDepsForTest({
    resolvePluginSetupCliBackend: () => undefined,
    resolveRuntimeCliBackends: () => [backend],
  });
}

beforeEach(() => {
  fixture = createCliRunnerPrepareFixture((params) => {
    setRuntimeConfigSnapshot(params.config ?? {});
    return prepareCliRunContext({ skillsSnapshot: { prompt: "", skills: [] }, ...params });
  });
});

afterEach(async () => {
  clearRuntimeConfigSnapshot();
  vi.mocked(globalHooks.getGlobalHookRunner).mockReset();
  resetCliRunnerPrepareTestDeps();
  cliBackendsTesting.resetDepsForTest();
  await fixture.cleanup();
});

it("mediates ordinary turns for prepare-execution backends declaring file hostOwnedTools", async () => {
  const mediatedTools = ["read", "write", "edit", "apply_patch", "exec", "process"];
  const projectTools = (scope: Parameters<typeof resolveMcpLoopbackScopedTools>[0]) => ({
    agentId: "main",
    tools: mediatedTools
      .filter(
        (name) =>
          !scope.context.toolsAllow ||
          scope.context.toolsAllow.includes("*") ||
          scope.context.toolsAllow.includes(name),
      )
      .map((name) => ({ name })),
  });
  const { mint } = mockCliMcpPreparation({
    resolveMcpLoopbackScopedTools: projectTools,
    resolveMcpLoopbackPolicyTools: projectTools,
  });
  const prepareExecution = vi.fn(async () => ({ toolAvailabilityEnforced: true as const }));
  registerBackend({
    id: "prepared-mediated-cli",
    pluginId: "prepared-mediated-plugin",
    bundleMcp: true,
    bundleMcpMode: "claude-config-file",
    nativeToolMode: "selectable",
    hostOwnedTools: mediatedTools,
    toolAvailabilityEnforcement: "prepare-execution",
    prepareExecution,
    config: {
      command: "prepared-mediated-cli",
      args: ["--print"],
      output: "jsonl",
      input: "stdin",
      sessionMode: "existing",
    },
  });

  const context = await fixture.prepare({
    provider: "prepared-mediated-cli",
    agentId: "main",
    config: { plugins: { enabled: false } },
  });

  expect(prepareExecution).toHaveBeenCalledWith(
    expect.objectContaining({
      toolAvailability: { native: [], openClaw: mediatedTools },
    }),
  );
  expect(context.params.cliToolAvailability).toEqual({
    native: [],
    openClaw: mediatedTools,
  });
  expect(mint.mock.calls[0]?.[0]?.context.toolsAllow).toEqual(mediatedTools);
  await context.preparedBackend.cleanup?.();
});

it("passes hostOwnedTools to prepareExecution and enforces acknowledgment for shell-only prepare-execution backends", async () => {
  const projectTools = (scope: Parameters<typeof resolveMcpLoopbackScopedTools>[0]) => ({
    agentId: "main",
    tools: [...(scope.defaultMediatedToolNames ?? []), "message"]
      .filter((name) => !scope.context.toolsAllow || scope.context.toolsAllow.includes(name))
      .map((name) => ({ name })),
  });
  const { mint } = mockCliMcpPreparation({
    resolveMcpLoopbackScopedTools: projectTools,
    resolveMcpLoopbackPolicyTools: projectTools,
  });
  const prepareExecution = vi.fn(async () => ({ hostOwnedToolsEnforced: true as const }));
  registerBackend({
    id: "prepared-shell-cli",
    pluginId: "prepared-shell-plugin",
    bundleMcp: true,
    bundleMcpMode: "claude-config-file",
    nativeToolMode: "selectable",
    hostOwnedTools: ["exec", "process"],
    toolAvailabilityEnforcement: "prepare-execution",
    prepareExecution,
    config: {
      command: "prepared-shell-cli",
      args: ["--print"],
      output: "jsonl",
      input: "stdin",
      sessionMode: "existing",
    },
  });

  const context = await fixture.prepare({
    provider: "prepared-shell-cli",
    agentId: "main",
    config: { plugins: { enabled: false } },
  });

  expect(prepareExecution).toHaveBeenCalledWith(
    expect.objectContaining({
      toolAvailability: undefined,
      hostOwnedTools: ["exec", "process"],
    }),
  );
  expect(context.hostOwnedTools).toEqual(["exec", "process"]);
  expect(mint.mock.calls[0]?.[0]?.context.toolsAllow).toEqual(["exec", "process", "message"]);
  await context.preparedBackend.cleanup?.();
});

it("fails closed when a prepare-execution backend returns only toolAvailabilityEnforced without hostOwnedToolsEnforced", async () => {
  const projectTools = (scope: Parameters<typeof resolveMcpLoopbackScopedTools>[0]) => ({
    agentId: "main",
    tools: [...(scope.defaultMediatedToolNames ?? []), "message"].map((name) => ({ name })),
  });
  mockCliMcpPreparation({
    resolveMcpLoopbackScopedTools: projectTools,
    resolveMcpLoopbackPolicyTools: projectTools,
  });
  // Returning only toolAvailabilityEnforced must not vacuously acknowledge partial hostOwnedTools.
  const prepareExecution = vi.fn(async () => ({ toolAvailabilityEnforced: true as const }));
  registerBackend({
    id: "unacknowledged-shell-cli",
    pluginId: "unacknowledged-shell-plugin",
    bundleMcp: true,
    bundleMcpMode: "claude-config-file",
    nativeToolMode: "selectable",
    hostOwnedTools: ["exec", "process"],
    toolAvailabilityEnforcement: "prepare-execution",
    prepareExecution,
    config: {
      command: "unacknowledged-shell-cli",
      args: ["--print"],
      output: "jsonl",
      input: "stdin",
      sessionMode: "existing",
    },
  });

  await expect(
    fixture.prepare({
      provider: "unacknowledged-shell-cli",
      agentId: "main",
      config: { plugins: { enabled: false } },
    }),
  ).rejects.toThrow("did not enforce host-owned tools during execution preparation");
  expect(prepareExecution).toHaveBeenCalledWith(
    expect.objectContaining({ hostOwnedTools: ["exec", "process"] }),
  );
});

it.each([false, true])(
  "enforces a final prompt-hook exact selection without a partial ownership acknowledgment (ack=%s)",
  async (acknowledgeExact) => {
    const projectTools = (scope: Parameters<typeof resolveMcpLoopbackScopedTools>[0]) => ({
      agentId: "main",
      tools: ["exec", "process", "message"]
        .filter((name) => !scope.context.toolsAllow || scope.context.toolsAllow.includes(name))
        .map((name) => ({ name })),
    });
    const { mint } = mockCliMcpPreparation({
      resolveMcpLoopbackScopedTools: projectTools,
      resolveMcpLoopbackPolicyTools: projectTools,
    });
    const prepareExecution = vi.fn(async () =>
      acknowledgeExact ? { toolAvailabilityEnforced: true as const } : {},
    );
    registerBackend({
      id: "hook-capped-shell-cli",
      pluginId: "hook-capped-shell-plugin",
      bundleMcp: true,
      bundleMcpMode: "claude-config-file",
      nativeToolMode: "selectable",
      hostOwnedTools: ["exec", "process"],
      toolAvailabilityEnforcement: "prepare-execution",
      prepareExecution,
      config: {
        command: "hook-capped-shell-cli",
        args: ["--print"],
        output: "jsonl",
        input: "stdin",
        sessionMode: "existing",
      },
    });
    const runBeforePromptBuild = vi.fn(async () => ({ toolsAllow: ["message"] }));
    vi.mocked(globalHooks.getGlobalHookRunner).mockReturnValue({
      hasHooks: (name: string) => name === "before_prompt_build",
      runBeforePromptBuild,
    } as never);
    const prepared = fixture.prepare({
      provider: "hook-capped-shell-cli",
      agentId: "main",
      config: {},
    });
    const outcome = await prepared.then(
      (value) => ({ value, error: undefined }),
      (error: unknown) => ({ value: undefined, error }),
    );
    expect(runBeforePromptBuild).toHaveBeenCalledOnce();
    expect(prepareExecution).toHaveBeenCalledWith(
      expect.objectContaining({
        hostOwnedTools: ["exec", "process"],
        toolAvailability: { native: [], openClaw: ["message"] },
      }),
    );
    if (!acknowledgeExact) {
      expect(outcome.error).toBeInstanceOf(Error);
      expect((outcome.error as Error).message).toContain(
        "did not enforce exact per-run tool availability",
      );
    } else {
      if (!outcome.value) {
        throw new Error("Expected an exact-selection run to prepare successfully", {
          cause: outcome.error,
        });
      }
      const context = outcome.value;
      expect(context.params.cliToolAvailability).toEqual({ native: [], openClaw: ["message"] });
      expect(mint.mock.calls[0]?.[0]?.context.toolsAllow).toEqual(["message"]);
      await context.preparedBackend.cleanup?.();
    }
  },
);
