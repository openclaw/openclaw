import type { Tool as SdkTool } from "@github/copilot-sdk";
import type { createMockPluginRegistry } from "openclaw/plugin-sdk/plugin-test-runtime";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { AttemptParamsLike } from "./attempt-types.js";
import type { FakeSdk, FakeSession } from "./attempt.test-support.js";
import type { createCopilotToolBridge } from "./tool-bridge.js";

type Bridge = Awaited<ReturnType<typeof createCopilotToolBridge>>;

export function registerCopilotPromptTests({
  makeAttempt,
  makeSdkTool,
  createStubToolBridge,
  stubToolBridge,
  requireCreateSessionConfig,
  requireSystemMessage,
  requireSession,
  installHooks,
  waitForEventLoopTurn,
  workspaceBootstrapMock,
}: {
  makeAttempt: () => {
    sdk: FakeSdk;
    run: (overrides?: Partial<AttemptParamsLike>) => Promise<unknown>;
  };
  makeSdkTool: (name: string) => SdkTool;
  createStubToolBridge: (tools: SdkTool[]) => Bridge;
  stubToolBridge: (build: () => Bridge) => unknown;
  requireCreateSessionConfig: (sdk: FakeSdk) => Record<string, unknown>;
  requireSystemMessage: (sdk: FakeSdk) => string;
  requireSession: (sdk: FakeSdk) => FakeSession;
  installHooks: (
    hooks: Record<string, Parameters<typeof createMockPluginRegistry>[0][number]["handler"]>,
  ) => void;
  waitForEventLoopTurn: () => Promise<void>;
  workspaceBootstrapMock: { loadCopilotWorkspaceInstructions: Mock };
}) {
  describe("workspace bootstrap (systemMessage)", () => {
    beforeEach(() => {
      workspaceBootstrapMock.loadCopilotWorkspaceInstructions.mockReset();
      workspaceBootstrapMock.loadCopilotWorkspaceInstructions.mockResolvedValue(undefined);
    });

    it.each([false, true])(
      "suppresses report-only delegation but keeps visible-reply guidance (routed=%s)",
      async (routed) => {
        const { sdk, run } = makeAttempt();
        stubToolBridge(() => createStubToolBridge(["message", "sessions_spawn"].map(makeSdkTool)));
        await run({
          agentId: "main",
          disableTools: false,
          sessionKey: "agent:main:main",
          sourceReplyDeliveryMode: "automatic",
          delegationCapability: "report_only",
          ...(routed ? { messageChannel: "telegram", currentChannelId: "123" } : {}),
        });
        const content = requireSystemMessage(sdk);
        expect(content).not.toContain("## Delegation");
        expect(content).toContain(
          routed
            ? "is your complete reply."
            : "OpenClaw delivers your final response automatically to the caller",
        );
      },
    );

    it("wraps minimal context without inventing workspace sections", async () => {
      const { sdk, run } = makeAttempt();
      await run({ extraSystemPrompt: "Child policy.", promptMode: "minimal" });
      const content = requireSystemMessage(sdk);
      expect(content).toContain("## Subagent Context\nChild policy.");
      expect(content).not.toContain("## Workspace");
    });

    it("sends the final appended developer instructions to the SDK and llm_input", async () => {
      const rendered = "# Project Context\nSoul voice goes here.";
      workspaceBootstrapMock.loadCopilotWorkspaceInstructions.mockResolvedValueOnce(rendered);
      const { sdk, run } = makeAttempt();
      const llmInput = vi.fn();
      installHooks({ llm_input: llmInput });
      const toolNames = [
        "message",
        "sessions_send",
        " sessions_spawn ",
        "sessions_spawn",
        "skill_workshop",
      ];

      stubToolBridge(() => createStubToolBridge(toolNames.map(makeSdkTool)));
      await run({
        agentId: "main",
        extraSystemPrompt: "Only answer in the current group thread.",
        disableTools: false,
        sessionKey: "agent:main:main",
      });
      await waitForEventLoopTurn();

      const content = requireSystemMessage(sdk);
      expect(requireCreateSessionConfig(sdk).systemMessage).toMatchObject({ mode: "append" });
      expect(content).toContain(
        `${rendered}\n\n## Conversation Context\nOnly answer in the current group thread.`,
      );
      expect(content).toContain("## Skill Workshop");
      expect(content).toContain(
        "Announced completion is push-based; collectors require explicit result collection.",
      );
      expect(content).not.toContain("sessions_yield");
      expect(content).not.toContain("subagents(action=list)");
      expect(content).toContain("spawn `sessions_spawn` with `visible=true`");
      expect(content).toContain("automatically to the caller.");
      expect(llmInput).toHaveBeenCalledWith(
        expect.objectContaining({ systemPrompt: content }),
        expect.any(Object),
      );
    });

    it.each([{ modelRun: true }, { promptMode: "none" as const }])(
      "keeps raw model runs outside generic prompt hooks: %j",
      async (mode) => {
        const beforePromptBuild = vi.fn(() => ({
          appendContext: "must not reach raw model probes",
          prependSystemContext: "must not reach raw model probes",
        }));
        installHooks({ before_prompt_build: beforePromptBuild });
        const { sdk, run } = makeAttempt();

        await run(mode);

        expect(beforePromptBuild).not.toHaveBeenCalled();
        expect(requireCreateSessionConfig(sdk)).not.toHaveProperty("systemMessage");
        expect(requireSession(sdk).sendAndWait.mock.calls[0]?.[0]).toMatchObject({
          prompt: "hello",
        });
      },
    );
  });
}
