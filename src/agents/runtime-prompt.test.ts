import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveSessionGitCoauthorPrompt } from "./git-coauthor-prompt.js";
import { resolveAgentRuntimePrompt } from "./runtime-prompt.js";

const channelMocks = vi.hoisted(() => ({
  capabilities: vi.fn(() => ["voice"]),
  hints: vi.fn(() => ["Use the message tool."]),
  reactions: vi.fn(() => ({ level: "minimal" as const, channel: "Telegram" })),
}));

vi.mock("./channel-tools.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./channel-tools.js")>()),
  resolveChannelMessageToolHints: channelMocks.hints,
  resolveChannelPromptCapabilities: vi.fn(() => []),
  resolveChannelReactionGuidance: channelMocks.reactions,
}));

vi.mock("./model-selection.js", () => ({
  resolveDefaultModelForAgent: vi.fn(() => ({ provider: "openai", model: "gpt-default" })),
}));

vi.mock("../config/channel-capabilities.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/channel-capabilities.js")>()),
  resolveChannelCapabilities: channelMocks.capabilities,
}));

vi.mock("./shell-utils.js", () => ({
  detectRuntimeShell: vi.fn(() => "zsh"),
}));

vi.mock("./git-coauthor-prompt.js", () => ({
  resolveSessionGitCoauthorPrompt: vi.fn(),
}));

vi.mock("../infra/machine-name.js", () => ({
  getMachineDisplayName: vi.fn(async () => "test-host"),
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
    for (const mock of Object.values(channelMocks)) {
      expect(mock).toHaveBeenCalledWith(channelContext);
    }
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
