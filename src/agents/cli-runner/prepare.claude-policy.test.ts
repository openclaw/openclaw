import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureSessionEventTargetForHost } from "../../auto-reply/reply/session-event-target.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.js";
import type { mintMcpLoopbackClientGrant as MintMcpLoopbackClientGrant } from "../../gateway/mcp-grant-store.js";
import {
  resolveMcpLoopbackPolicyTools,
  resolveMcpLoopbackScopedTools,
} from "../../gateway/mcp-http.runtime.js";
import {
  createClaudeMcpCliBackend,
  testing as cliBackendsTesting,
} from "../cli-backends.test-support.js";
import {
  createCliRunnerPrepareFixture,
  createTestMcpLoopbackClientGrant,
} from "../cli-runner.test-helpers.js";
import { prepareCliRunContext } from "./prepare.js";
import {
  resetCliRunnerPrepareTestDeps,
  setCliRunnerPrepareTestDeps,
} from "./prepare.test-support.js";

const claudeBackend = createClaudeMcpCliBackend();

describe("Claude preparation policy boundaries", () => {
  let fixture: ReturnType<typeof createCliRunnerPrepareFixture>;
  const mintGrant = vi.fn<typeof MintMcpLoopbackClientGrant>();

  beforeEach(() => {
    mintGrant.mockReset().mockImplementation(createTestMcpLoopbackClientGrant);
    cliBackendsTesting.setDepsForTest({
      resolvePluginSetupCliBackend: () => undefined,
      resolveRuntimeCliBackends: () => [claudeBackend],
    });
    setCliRunnerPrepareTestDeps({
      isWorkspaceBootstrapPending: async () => false,
      makeBootstrapWarn: () => () => undefined,
      resolveBootstrapContextForRun: async () => ({ bootstrapFiles: [], contextFiles: [] }),
      getActiveMcpLoopbackRuntime: () => ({
        port: 31783,
        ownerToken: "loopback-owner-token",
        nonOwnerToken: "loopback-non-owner-token",
      }),
      mintMcpLoopbackClientGrant: mintGrant,
      bindMcpLoopbackClientGrantAdmission: () => true,
      revokeMcpLoopbackClientGrant: () => true,
      resolveMcpLoopbackPolicyTools,
      resolveMcpLoopbackScopedTools,
      resolveOpenClawReferencePaths: async () => ({ docsPath: null, sourcePath: null }),
      prepareClaudeCliSkillsPlugin: async () => ({ args: [], cleanup: async () => {} }),
      getCliLiveSessionGeneration: () => undefined,
      loadManifestModelCatalog: () => [],
    });
    fixture = createCliRunnerPrepareFixture((params) => {
      setRuntimeConfigSnapshot(params.config ?? {});
      return prepareCliRunContext({ skillsSnapshot: { prompt: "", skills: [] }, ...params });
    });
  });

  afterEach(async () => {
    await fixture.cleanup();
    clearRuntimeConfigSnapshot();
    resetCliRunnerPrepareTestDeps();
    cliBackendsTesting.resetDepsForTest();
  });

  it.each([false, true])(
    "captures a prepared Claude producer policy for its own conversation (explicit cap: %s)",
    async (explicitCap) => {
      const { sessionTarget } = fixture.session;
      const sessionEntry = { sessionId: sessionTarget.sessionId, updatedAt: 0 };
      const otherTarget = { ...sessionTarget, sessionKey: "agent:main:other", sessionId: "other" };
      replaceSessionEntrySync(otherTarget, { sessionId: "other", updatedAt: 0 });
      const context = await fixture.prepare({
        provider: "claude-cli",
        sessionKey: sessionTarget.sessionKey,
        sessionEntry,
        ...(explicitCap ? { toolsAllow: ["read"] } : {}),
        config: {
          session: { store: sessionTarget.storePath },
          tools: { allow: ["read"] },
        },
      });
      try {
        const producerPolicy = context.sessionEventSourcePolicy;
        expect(producerPolicy?.toolsAllow).toEqual(["read"]);
        // No caller identity is installed: delayed producers retain the actual prepared policy.
        const own = await captureSessionEventTargetForHost("main", sessionTarget.sessionKey, {
          producerPolicy,
        });
        const other = await captureSessionEventTargetForHost("main", otherTarget.sessionKey, {
          producerPolicy,
        });
        expect(own.toolsAllow).toEqual(explicitCap ? ["read"] : undefined);
        expect(other.toolsAllow).toEqual(["read"]);
      } finally {
        await context.preparedBackend.cleanup?.();
      }
    },
  );
});
