import { beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeSessionDeliveryState } from "../utils/delivery-context.shared.js";
import { resolveSessionGitCoauthorPrompt } from "./git-coauthor-prompt.js";
import { resolveAgentRuntimePrompt } from "./runtime-prompt.js";
import { buildConfiguredAgentSystemPrompt } from "./system-prompt-config.js";

const {
  resolveChannelCapabilitiesMock,
  getMachineDisplayNameMock,
  resolveChannelMessageToolHintsMock,
  resolveChannelReactionGuidanceMock,
} = vi.hoisted(() => ({
  resolveChannelCapabilitiesMock: vi.fn(() => ["voice"]),
  getMachineDisplayNameMock: vi.fn(async () => "test-host"),
  resolveChannelMessageToolHintsMock: vi.fn(() => ["Use the message tool."]),
  resolveChannelReactionGuidanceMock: vi.fn(() => ({
    level: "minimal" as const,
    channel: "Telegram",
  })),
}));

vi.mock("./channel-tools.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./channel-tools.js")>()),
  resolveChannelMessageToolHints: resolveChannelMessageToolHintsMock,
  resolveChannelPromptCapabilities: vi.fn(() => []),
  resolveChannelReactionGuidance: resolveChannelReactionGuidanceMock,
}));

vi.mock("./model-selection.js", () => ({
  resolveDefaultModelForAgent: vi.fn(() => ({ provider: "openai", model: "gpt-default" })),
}));

vi.mock("../config/channel-capabilities.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/channel-capabilities.js")>()),
  resolveChannelCapabilities: resolveChannelCapabilitiesMock,
}));

vi.mock("./shell-utils.js", () => ({
  detectRuntimeShell: vi.fn(() => "zsh"),
}));

vi.mock("./git-coauthor-prompt.js", () => ({
  resolveSessionGitCoauthorPrompt: vi.fn(),
}));

vi.mock("../infra/machine-name.js", () => ({
  getMachineDisplayName: getMachineDisplayNameMock,
}));

vi.mock("../infra/os-summary.js", () => ({
  resolveRuntimeOsLabel: vi.fn(() => "TestOS 1.0"),
}));

describe("resolveAgentRuntimePrompt", () => {
  const gitCoauthorPrompt =
    "Git co-authors: add these exact trailers to every commit you make from this session.\n" +
    "Co-authored-by: ada <20+ada@users.noreply.github.com>";

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(resolveSessionGitCoauthorPrompt).mockResolvedValue(gitCoauthorPrompt);
  });

  it("resolves shared runtime and channel prompt facts", async () => {
    const config = {};
    const result = await resolveAgentRuntimePrompt({
      config,
      agentId: "main",
      workspaceDir: "/tmp/workspace",
      cwd: "/tmp/workspace",
      sessionKey: "agent:main:telegram:direct:123",
      sessionId: "session-1",
      model: "openai/gpt-test",
      channel: "Telegram",
      accountId: "work",
      chatType: "group",
    });

    const channelContext = { cfg: config, channel: "telegram", accountId: "work" };
    expect(resolveChannelCapabilitiesMock).toHaveBeenCalledWith(channelContext);
    expect(resolveChannelReactionGuidanceMock).toHaveBeenCalledWith(channelContext);
    expect(resolveChannelMessageToolHintsMock).toHaveBeenCalledWith(channelContext);
    expect(resolveSessionGitCoauthorPrompt).toHaveBeenCalledExactlyOnceWith({
      config,
      agentId: "main",
      sessionKey: "agent:main:telegram:direct:123",
      sessionId: "session-1",
    });
    expect(result.runtimeInfo).toMatchObject({
      agentId: "main",
      host: "test-host",
      os: "TestOS 1.0",
      model: "openai/gpt-test",
      defaultModel: "openai/gpt-default",
      shell: "zsh",
      channel: "telegram",
      chatType: "group",
      capabilities: ["voice"],
      gitCoauthorPrompt,
    });
    expect(result).toEqual(
      expect.objectContaining({
        runtimeChannel: "telegram",
        runtimeCapabilities: ["voice"],
        reactionGuidance: { level: "minimal", channel: "Telegram" },
        messageToolHints: ["Use the message tool."],
      }),
    );
  });

  it.each([
    { delivery: { kind: "internal" as const }, expectedChannel: "webchat" },
    { delivery: { kind: "none" as const }, expectedChannel: undefined },
    {
      delivery: normalizeSessionDeliveryState({
        context: { channel: "telegram", to: "123", accountId: "work", threadId: "4" },
      }),
      expectedChannel: "telegram",
    },
  ])(
    "keeps session presentation for $delivery.kind delivery",
    async ({ delivery, expectedChannel }) => {
      const prompts = [];
      for (const channel of ["webchat", undefined]) {
        const result = await resolveAgentRuntimePrompt({
          config: {},
          agentId: "main",
          workspaceDir: "/tmp/workspace",
          sessionKey: "agent:main:prompt-continuity",
          sessionId: "session-1",
          preparedSessionEntry: { sessionId: "session-1", updatedAt: 1, delivery },
          model: "local/qwen3:8b",
          channel,
        });
        expect(result.runtimeInfo.channel).toBe(expectedChannel);
        expect(result.runtimeChannel).toBe(channel);
        prompts.push(
          buildConfiguredAgentSystemPrompt({ ...result, workspaceDir: "/tmp/workspace" }),
        );
      }
      expect(prompts[1]).toBe(prompts[0]);
      expect(prompts[0]?.includes("## Control UI Embed")).toBe(delivery.kind === "internal");
    },
  );

  it.each([
    { name: "prepared credit", preparedGitCoauthorPrompt: gitCoauthorPrompt },
    { name: "explicit undefined", preparedGitCoauthorPrompt: undefined },
    { name: "explicit null", preparedGitCoauthorPrompt: null },
  ])("retains $name without refreshing session credit", async ({ preparedGitCoauthorPrompt }) => {
    const result = await resolveAgentRuntimePrompt({
      config: {},
      agentId: "main",
      sessionKey: "agent:main:main",
      model: "openai/gpt-test",
      preparedGitCoauthorPrompt,
    });

    expect(result.runtimeInfo.gitCoauthorPrompt).toBe(preparedGitCoauthorPrompt ?? undefined);
    expect(resolveSessionGitCoauthorPrompt).not.toHaveBeenCalled();
  });
});
