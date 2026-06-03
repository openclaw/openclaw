import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyFeishuGroupActivationOverride,
  resolveFeishuGroupActivationOverride,
} from "./group-activation.js";

const { loadSessionStoreMock } = vi.hoisted(() => ({
  loadSessionStoreMock: vi.fn(),
}));

vi.mock("./bot-runtime-api.js", async () => {
  const actual =
    await vi.importActual<typeof import("./bot-runtime-api.js")>("./bot-runtime-api.js");
  return {
    ...actual,
    loadSessionStore: loadSessionStoreMock,
  };
});

afterAll(() => {
  vi.doUnmock("./bot-runtime-api.js");
  vi.resetModules();
});

describe("resolveFeishuGroupActivationOverride", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns mention when the session entry stores groupActivation=mention", () => {
    loadSessionStoreMock.mockReturnValue({
      "agent:main:feishu:group:oc_group_1": { groupActivation: "mention" },
    });
    expect(
      resolveFeishuGroupActivationOverride({
        storePath: "/tmp/feishu-sessions.json",
        sessionKey: "agent:main:feishu:group:oc_group_1",
      }),
    ).toBe("mention");
  });

  it("returns always when the session entry stores groupActivation=always", () => {
    loadSessionStoreMock.mockReturnValue({
      "agent:main:feishu:group:oc_group_1": { groupActivation: "always" },
    });
    expect(
      resolveFeishuGroupActivationOverride({
        storePath: "/tmp/feishu-sessions.json",
        sessionKey: "agent:main:feishu:group:oc_group_1",
      }),
    ).toBe("always");
  });

  it("ignores unrelated session keys", () => {
    loadSessionStoreMock.mockReturnValue({
      "agent:main:feishu:group:other_group": { groupActivation: "mention" },
    });
    expect(
      resolveFeishuGroupActivationOverride({
        storePath: "/tmp/feishu-sessions.json",
        sessionKey: "agent:main:feishu:group:oc_group_1",
      }),
    ).toBeUndefined();
  });

  it("returns undefined when the session entry has no activation", () => {
    loadSessionStoreMock.mockReturnValue({
      "agent:main:feishu:group:oc_group_1": { reasoningLevel: "on" },
    });
    expect(
      resolveFeishuGroupActivationOverride({
        storePath: "/tmp/feishu-sessions.json",
        sessionKey: "agent:main:feishu:group:oc_group_1",
      }),
    ).toBeUndefined();
  });

  it("returns undefined and reports errors when the store cannot be read", () => {
    loadSessionStoreMock.mockImplementationOnce(() => {
      throw new Error("disk unavailable");
    });
    const onError = vi.fn();
    expect(
      resolveFeishuGroupActivationOverride({
        storePath: "/tmp/feishu-sessions.json",
        sessionKey: "agent:main:feishu:group:oc_group_1",
        onError,
      }),
    ).toBeUndefined();
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("normalizes uppercase/whitespace activation values", () => {
    loadSessionStoreMock.mockReturnValue({
      "agent:main:feishu:group:oc_group_1": { groupActivation: " MENTION " },
    });
    expect(
      resolveFeishuGroupActivationOverride({
        storePath: "/tmp/feishu-sessions.json",
        sessionKey: "agent:main:feishu:group:oc_group_1",
      }),
    ).toBe("mention");
  });
});

describe("applyFeishuGroupActivationOverride", () => {
  it("forces requireMention=true when session activation is mention, even when config says false", () => {
    // Regression for #50490: `mentionRequired: false` + `/activation mention`
    // must still gate non-@ messages.
    expect(
      applyFeishuGroupActivationOverride({
        configRequireMention: false,
        activation: "mention",
      }),
    ).toBe(true);
  });

  it("forces requireMention=false when session activation is always, even when config says true", () => {
    expect(
      applyFeishuGroupActivationOverride({
        configRequireMention: true,
        activation: "always",
      }),
    ).toBe(false);
  });

  it("falls back to config when there is no session override", () => {
    expect(
      applyFeishuGroupActivationOverride({
        configRequireMention: true,
        activation: undefined,
      }),
    ).toBe(true);
    expect(
      applyFeishuGroupActivationOverride({
        configRequireMention: false,
        activation: undefined,
      }),
    ).toBe(false);
  });

  it("leaves the config decision intact when session activation matches it", () => {
    expect(
      applyFeishuGroupActivationOverride({
        configRequireMention: true,
        activation: "mention",
      }),
    ).toBe(true);
    expect(
      applyFeishuGroupActivationOverride({
        configRequireMention: false,
        activation: "always",
      }),
    ).toBe(false);
  });
});
