import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { resolveMcpLoopbackScopedTools } from "../../gateway/mcp-http.runtime.js";
import type { CliBackendPlugin } from "../../plugins/cli-backend.types.js";
import {
  AUDIENCE_CHILD_KEY,
  withChildAudience,
} from "../../plugins/memory-provider-runtime.audience.test-support.js";
import { loadBundledPluginFacade } from "../../test-utils/bundled-plugin-public-surface.js";
import { testing as cliBackendsTesting } from "../cli-backends.test-support.js";
import { createCliRunnerPrepareFixture } from "../cli-runner.test-helpers.js";
import { mockCliMcpPreparation } from "./prepare-mcp.test-support.js";
import { prepareCliRunContext } from "./prepare.js";
import { resetCliRunnerPrepareTestDeps } from "./prepare.test-support.js";

const { buildAnthropicCliBackend } = await loadBundledPluginFacade<{
  buildAnthropicCliBackend: () => CliBackendPlugin;
}>({ pluginId: "anthropic", artifactBasename: "api.js" });

// mock-isolation: the loopback projection is the subject; prompt tools stay inert.
vi.mock("../openclaw-tools.js", () => ({ createOpenClawToolsAsync: async () => [] }));
// mock-isolation: coding tools stay inert so no host shell is assembled.
vi.mock("../agent-tools.async.js", () => ({
  createOpenClawCodingToolsInternalAsync: async () => [],
}));

let fixture: ReturnType<typeof createCliRunnerPrepareFixture>;
beforeEach(() => {
  cliBackendsTesting.setDepsForTest({
    resolvePluginSetupCliBackend: () => undefined,
    resolveRuntimeCliBackends: () => [{ ...buildAnthropicCliBackend(), pluginId: "anthropic" }],
  });
  fixture = createCliRunnerPrepareFixture((params) =>
    prepareCliRunContext({ skillsSnapshot: { prompt: "", skills: [] }, ...params }),
  );
});
afterEach(async () => {
  resetCliRunnerPrepareTestDeps();
  cliBackendsTesting.resetDepsForTest();
  await fixture.cleanup();
});

// A sessionless run resolves no turn audience, so its grant's own session resolves one.
it.each([
  ["the turn's own session", AUDIENCE_CHILD_KEY],
  ["a session the grant resolves itself", undefined],
])("lists audience-gated tools in a Claude CLI grant on %s", async (_name, sessionKey) => {
  await withChildAudience(true, async ({ audience: memoryAudience }) => {
    const release = vi.fn();
    const resolveAudience = vi.fn(async () => ({ memoryAudience, release }));
    // Like a memory slot plugin, the gated tool exists only when its factory gets the audience.
    const projectTools = (scope: Parameters<typeof resolveMcpLoopbackScopedTools>[0]) => ({
      agentId: "main",
      tools: ["exec", "memory_probe"]
        .filter((name) => name === "exec" || scope.memoryAudience === memoryAudience)
        .map((name) => ({ name })),
    });
    const { mint, revokeMinted } = mockCliMcpPreparation({
      resolveCliMcpMemoryAudience: resolveAudience,
      resolveMcpLoopbackScopedTools: projectTools,
      resolveMcpLoopbackPolicyTools: projectTools,
    });

    const context = await fixture.prepare({
      provider: "claude-cli",
      sessionKey,
      senderIsOwner: true,
      sessionEntry: { sessionId: "session-test", chatType: "direct", updatedAt: 1 },
      config: { plugins: { enabled: false } },
    });

    expect(resolveAudience).toHaveBeenCalledOnce();
    expect(mint).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        memoryAudience,
        context: expect.objectContaining({ toolsAllow: ["exec", "memory_probe"] }),
      }),
    );
    await context.preparedBackend.cleanup?.();
    // The grant that carries the audience is revoked before its lease ends.
    expect(release).toHaveBeenCalledOnce();
    expect(revokeMinted.mock.invocationCallOrder[0]).toBeLessThan(
      release.mock.invocationCallOrder[0] ?? 0,
    );
  });
});
