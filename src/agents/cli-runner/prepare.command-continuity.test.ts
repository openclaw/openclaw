import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createThrowingTestRuntime } from "../../commands/test-runtime-config-helpers.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import * as runtimeConfig from "../agent-runtime-config.js";
import { testing as cliBackendsTesting } from "../cli-backends.test-support.js";
import {
  buildDefaultTestCliBackend,
  createCliRunnerPrepareFixture,
  createTestMcpLoopbackClientGrant,
  createTestMcpLoopbackServer,
  createTestMcpLoopbackServerConfig,
} from "../cli-runner.test-helpers.js";
import { hashCliSessionText } from "../cli-session.js";
import { prepareAgentCommandExecution } from "../command/prepare.js";
import { prepareCliRunContext } from "./prepare.js";
import {
  resetCliRunnerPrepareTestDeps,
  setCliRunnerPrepareTestDeps,
} from "./prepare.test-support.js";
import type { PreparedCliRunContext, RunCliAgentParams } from "./types.js";

function nativeBinding(context: PreparedCliRunContext) {
  return {
    sessionId: "native-cli-session",
    extraSystemPromptHash: context.extraSystemPromptHash,
    messageToolPolicyHash: context.messageToolPolicyHash,
    promptToolNamesHash: context.promptToolNamesHash,
    cwdHash: context.cwdHash,
    mcpConfigHash: context.preparedBackend.mcpConfigHash,
    mcpResumeHash: context.preparedBackend.mcpResumeHash,
  };
}

describe("direct CLI command continuity", () => {
  let cli: ReturnType<typeof createCliRunnerPrepareFixture>;

  beforeEach(() => {
    cliBackendsTesting.setDepsForTest({
      resolvePluginSetupCliBackend: () => undefined,
      resolveRuntimeCliBackends: () => [buildDefaultTestCliBackend()],
    });
    setCliRunnerPrepareTestDeps({
      isWorkspaceBootstrapPending: async () => false,
      resolveBootstrapContextForRun: async () => ({ bootstrapFiles: [], contextFiles: [] }),
      resolveOpenClawReferencePaths: async () => ({ docsPath: null, sourcePath: null }),
      prepareClaudeCliSkillsPlugin: async () => ({ args: [], cleanup: async () => {} }),
      loadManifestModelCatalog: () => [],
    });
    cli = createCliRunnerPrepareFixture((params) =>
      prepareCliRunContext({ skillsSnapshot: { prompt: "", skills: [] }, ...params }),
    );
  });

  afterEach(async () => {
    await cli.cleanup();
    resetCliRunnerPrepareTestDeps();
    cliBackendsTesting.resetDepsForTest();
    vi.restoreAllMocks();
  });

  it.each(["new", "existing", "published", "published-explicit-false"] as const)(
    "preserves CLI continuity through completion for %s requesters",
    async (sessionState) => {
      const { dir, sessionTarget: fixtureTarget } = cli.session;
      const sessionKey = "agent:main:cli-announce";
      const target = { storePath: fixtureTarget.storePath, sessionKey };
      const config: OpenClawConfig = {
        agents: {
          defaults: { workspace: dir, model: { primary: "anthropic/claude-sonnet-4-6" } },
        },
        session: { store: target.storePath },
        plugins: { enabled: false },
        messages: { visibleReplies: "automatic" },
      };
      vi.spyOn(runtimeConfig, "resolveAgentRuntimeConfig").mockResolvedValue(config);
      if (sessionState !== "new") {
        await replaceSessionEntry(target, {
          sessionId: "requester-session",
          updatedAt: Date.now(),
        });
      }
      const isPublished = sessionState.startsWith("published");
      let publishedBinding: ReturnType<typeof nativeBinding> | undefined;
      if (isPublished) {
        // v2026.9.8 direct commands supplied neither binding facts nor a reply-mode override.
        const previous = await cli.prepare({
          sessionId: "requester-session",
          sessionKey,
          sessionTarget: { ...target, agentId: "main", sessionId: "requester-session" },
          workspaceDir: dir,
          config,
          ...(sessionState === "published-explicit-false"
            ? { requireExplicitMessageTarget: false }
            : {}),
        });
        try {
          expect(previous.messageToolPolicyHash).toBe(
            sessionState === "published-explicit-false"
              ? "92a8de91722cbb4fe1a7fd6892245e359c339d96cafe8db3a08738ffda913d71"
              : undefined,
          );
          publishedBinding = nativeBinding(previous);
          await replaceSessionEntry(target, {
            sessionId: "requester-session",
            updatedAt: Date.now(),
            cliSessionBindings: { "test-cli": publishedBinding },
          });
        } finally {
          await previous.preparedBackend.cleanup?.();
        }
      }
      const runtime = createThrowingTestRuntime();
      const ordinary = await prepareAgentCommandExecution(
        { message: "start child work", sessionKey },
        runtime,
      );
      expect(ordinary.sessionEntry === undefined).toBe(sessionState === "new");
      expect(ordinary.opts.sourceReplyDeliveryMode).toBeUndefined();
      const sessionTarget = {
        ...target,
        agentId: ordinary.sessionAgentId,
        sessionId: ordinary.sessionId,
      };
      const first = await cli.prepare({
        ...ordinary.opts,
        sessionId: ordinary.sessionId,
        sessionTarget,
        workspaceDir: ordinary.workspaceDir,
        config,
        cliSessionBinding: publishedBinding,
      });
      const binding = nativeBinding(first);
      try {
        if (isPublished) {
          expect(first.reusableCliSession).toEqual({
            mode: "reuse",
            sessionId: "native-cli-session",
          });
          expect(first.messageToolPolicyHash).toBe(
            "3ae4a9801e78dd74aa01b3ccad9fb6ab5628c39000b88276f651ed7fb9bdb555",
          );
        }
      } finally {
        await first.preparedBackend.cleanup?.();
      }
      await replaceSessionEntry(target, {
        sessionId: ordinary.sessionId,
        updatedAt: Date.now(),
        cliSessionBindings: { "test-cli": binding },
      });
      const completion = await prepareAgentCommandExecution(
        {
          message: "child completed",
          sessionKey,
          sourceReplyDeliveryMode: "message_tool_only",
          inputProvenance: {
            kind: "inter_session",
            sourceSessionKey: "agent:main:subagent:child",
            sourceTool: "subagent_announce",
          },
        },
        runtime,
      );
      expect(completion.opts.sourceReplyDeliveryMode).toBe("message_tool_only");
      const resumed = await cli.prepare({
        ...completion.opts,
        sessionId: ordinary.sessionId,
        sessionTarget,
        workspaceDir: ordinary.workspaceDir,
        config,
        cliSessionBinding: binding,
      });
      try {
        expect(resumed.reusableCliSession).toEqual({
          mode: "reuse",
          sessionId: "native-cli-session",
        });
      } finally {
        await resumed.preparedBackend.cleanup?.();
      }
    },
  );

  it("reuses automatic CLI bindings across new inbound messages", async () => {
    const stableMode = "automatic";
    const staticPrompt = "group:telegram:group:automatic";
    const { dir } = cli.session;
    const getActiveMcpLoopbackRuntime = vi.fn(() => ({
      port: 31783,
      ownerToken: "loopback-owner-token",
      nonOwnerToken: "loopback-non-owner-token",
    }));
    const resolveMcpLoopbackScopedTools = vi.fn(() => ({
      agentId: "main",
      tools: [
        {
          name: "message",
          label: "Message",
          description: "Send a message",
          parameters: { type: "object", properties: {} },
          execute: vi.fn(),
        },
      ],
    }));
    setCliRunnerPrepareTestDeps({
      getActiveMcpLoopbackRuntime,
      ensureMcpLoopbackServer: createTestMcpLoopbackServer,
      createMcpLoopbackServerConfig: createTestMcpLoopbackServerConfig,
      mintMcpLoopbackClientGrant: createTestMcpLoopbackClientGrant,
      bindMcpLoopbackClientGrantAdmission: () => true,
      revokeMcpLoopbackClientGrant: () => true,
      resolveMcpLoopbackScopedTools,
    });
    const cliSessionBindingFacts = {
      extraSystemPromptStatic: staticPrompt,
      sourceReplyDeliveryMode: stableMode,
    } satisfies NonNullable<RunCliAgentParams["cliSessionBindingFacts"]>;
    cliBackendsTesting.setDepsForTest({
      resolvePluginSetupCliBackend: () => undefined,
      resolveRuntimeCliBackends: () => [buildDefaultTestCliBackend({ bundleMcp: true })],
    });
    const config = {};
    const prepared: PreparedCliRunContext[] = [];
    try {
      const first = await cli.prepare({
        config,
        sessionKey: "main",
        prompt: "first ask",
        requireExplicitMessageTarget: true,
        extraSystemPrompt: `volatile msg-1\n\n${staticPrompt}`,
        sourceReplyDeliveryMode: "message_tool_only",
        currentMessageId: "msg-1",
        cliSessionBindingFacts,
      });
      prepared.push(first);
      const second = await cli.prepare({
        config,
        sessionKey: "main",
        prompt: "second ask",
        extraSystemPrompt: `volatile msg-2\n\n${staticPrompt}`,
        sourceReplyDeliveryMode: stableMode,
        currentMessageId: "msg-2",
        cliSessionBindingFacts,
        cliSessionBinding: {
          sessionId: "cli-session",
          extraSystemPromptHash: first.extraSystemPromptHash,
          messageToolPolicyHash: first.messageToolPolicyHash,
          promptToolNamesHash: first.promptToolNamesHash,
          cwdHash: hashCliSessionText(dir),
          mcpConfigHash: first.preparedBackend.mcpConfigHash,
          mcpResumeHash: first.preparedBackend.mcpResumeHash,
        },
      });
      prepared.push(second);

      expect(resolveMcpLoopbackScopedTools).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          context: expect.objectContaining({ requireExplicitMessageTarget: true }),
        }),
      );
      expect(resolveMcpLoopbackScopedTools).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          context: expect.objectContaining({ requireExplicitMessageTarget: undefined }),
        }),
      );
      expect(first.extraSystemPromptHash).toBe(hashCliSessionText(staticPrompt));
      expect(first.messageToolPolicyHash).toBeDefined();
      expect(second.extraSystemPromptHash).toBe(first.extraSystemPromptHash);
      expect(second.messageToolPolicyHash).toBe(first.messageToolPolicyHash);
      expect(second.promptToolNamesHash).toBe(first.promptToolNamesHash);

      expect(first.systemPrompt).toContain("Current-session final text normally routes to source");
      expect(first.systemPrompt).toContain(
        "If turn says final private, visible output uses `message(action=send)`",
      );
      expect(first.params.prompt).toContain(
        "Visible source replies are not automatically delivered for this run.",
      );
      expect(first.params.prompt).toContain(
        "`send`: `target` + `message`; target required this turn.",
      );
      expect(first.params.transcriptPrompt).toBe("first ask");
      expect(second.params.prompt).toContain(
        "OpenClaw delivers your final response automatically.",
      );
      expect(second.params.prompt).not.toContain(
        "Visible source replies are not automatically delivered for this run.",
      );
      expect(second.params.transcriptPrompt).toBe("second ask");

      expect(second.reusableCliSession).toEqual({ mode: "reuse", sessionId: "cli-session" });
    } finally {
      for (const context of prepared) {
        await context.preparedBackend.cleanup?.();
      }
    }
  });
});
