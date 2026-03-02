import type { ChannelGroupContext } from "openclaw/plugin-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { resolveMattermostAccountMock } = vi.hoisted(() => ({
  resolveMattermostAccountMock: vi.fn(),
}));

vi.mock("./mattermost/accounts.js", () => ({
  resolveMattermostAccount: resolveMattermostAccountMock,
}));

import { resolveMattermostGroupRequireMention } from "./group-mentions.js";

function makeParams(): ChannelGroupContext {
  return {
    cfg: {},
    channel: "mattermost",
    groupId: "group-1",
    accountId: "default",
  } as unknown as ChannelGroupContext;
}

describe("resolveMattermostGroupRequireMention", () => {
  beforeEach(() => {
    resolveMattermostAccountMock.mockReset();
  });

  it("returns false for chatmode=onmessage even without explicit requireMention", () => {
    resolveMattermostAccountMock.mockReturnValue({
      chatmode: "onmessage",
      requireMention: undefined,
    });

    const result = resolveMattermostGroupRequireMention(makeParams());
    expect(result).toBe(false);
  });

  it("returns true for chatmode=oncall regardless of requireMention", () => {
    resolveMattermostAccountMock.mockReturnValue({
      chatmode: "oncall",
      requireMention: false,
    });

    const result = resolveMattermostGroupRequireMention(makeParams());
    expect(result).toBe(true);
  });

  it("falls back to explicit requireMention when chatmode is unset", () => {
    resolveMattermostAccountMock.mockReturnValue({
      chatmode: undefined,
      requireMention: false,
    });

    const result = resolveMattermostGroupRequireMention(makeParams());
    expect(result).toBe(false);
  });

  it("defaults to requiring mention when neither chatmode nor requireMention is set", () => {
    resolveMattermostAccountMock.mockReturnValue({
      chatmode: undefined,
      requireMention: undefined,
    });

    const result = resolveMattermostGroupRequireMention(makeParams());
    expect(result).toBe(true);
  });
});
