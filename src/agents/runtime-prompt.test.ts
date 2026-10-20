import { beforeEach, expect, it, vi } from "vitest";
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

vi.mock("./shell-utils.js", () => ({ detectRuntimeShell: () => "zsh" }));
vi.mock("./git-coauthor-prompt.js", () => ({ resolveSessionGitCoauthorPrompt: vi.fn() }));
vi.mock("../infra/machine-name.js", () => ({ getMachineDisplayName: async () => "test-host" }));
vi.mock("../infra/os-summary.js", () => ({ resolveRuntimeOsLabel: () => "TestOS 1.0" }));

const gitCoauthorPrompt = "Git co-authors:\nCo-authored-by: Ada <ada@example.com>";
const params = { config: {}, agentId: "main", model: "openai/gpt-test" };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(resolveSessionGitCoauthorPrompt).mockResolvedValue(gitCoauthorPrompt);
});

it("resolves shared runtime and channel prompt facts", async () => {
  const session = { sessionKey: "agent:main:telegram:direct:123", sessionId: "session-1" };
  const result = await resolveAgentRuntimePrompt({
    ...params,
    ...session,
    workspaceDir: "/tmp/workspace",
    cwd: "/tmp/workspace",
    channel: "Telegram",
    accountId: "work",
    chatType: "group",
  });

  const channelContext = { cfg: params.config, channel: "telegram", accountId: "work" };
  for (const mock of Object.values(channelMocks)) {
    expect(mock).toHaveBeenCalledWith(channelContext);
  }
  expect(resolveSessionGitCoauthorPrompt).toHaveBeenCalledExactlyOnceWith({
    config: params.config,
    agentId: "main",
    ...session,
  });
  expect(result).toMatchObject({
    runtimeInfo: {
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
    },
    runtimeChannel: "telegram",
    runtimeCapabilities: ["voice"],
    messageToolHints: ["Use the message tool."],
  });
  expect(result.reactionGuidance).toEqual({ level: "minimal", channel: "Telegram" });
});

it.each([
  { name: "prepared credit", preparedGitCoauthorPrompt: gitCoauthorPrompt },
  { name: "explicit undefined", preparedGitCoauthorPrompt: undefined },
  { name: "explicit null", preparedGitCoauthorPrompt: null },
])("retains $name without refreshing session credit", async ({ preparedGitCoauthorPrompt }) => {
  const result = await resolveAgentRuntimePrompt({
    ...params,
    preparedGitCoauthorPrompt,
  });

  expect(result.runtimeInfo.gitCoauthorPrompt).toBe(preparedGitCoauthorPrompt ?? undefined);
  expect(resolveSessionGitCoauthorPrompt).not.toHaveBeenCalled();
});
