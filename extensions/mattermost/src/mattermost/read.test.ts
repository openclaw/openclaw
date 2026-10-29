import { requestUrl } from "openclaw/plugin-sdk/test-env";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMattermostTestConfig } from "./reactions.test-helpers.js";
import { readMattermostMessages } from "./read.js";
import type { OpenClawConfig } from "./runtime-api.js";

const fetchFixture = await vi.hoisted(async () =>
  (await import("./fetch.test-support.js")).createMattermostFetchFixture(),
);
// mock-isolation: Preserve real exports while binding fetch to this suite's transport fixture.
vi.mock("openclaw/plugin-sdk/ssrf-runtime", fetchFixture.mockRuntime);

function createReadFetch(params?: { channelType?: string; postStatus?: number }) {
  return vi.fn<typeof fetch>(async (input) => {
    const url = requestUrl(input);
    const channelMatch = url.match(/\/api\/v4\/channels\/([^/?]+)$/);
    if (channelMatch) {
      return Response.json({ id: channelMatch[1], type: params?.channelType ?? "O" });
    }
    if (url.includes("/api/v4/channels/") && url.includes("/posts?")) {
      if (params?.postStatus === 403) {
        return Response.json(
          { message: "You do not have the appropriate permissions." },
          {
            status: 403,
            statusText: "Forbidden",
          },
        );
      }
      return Response.json({
        order: ["post-2", "post-1"],
        posts: {
          "post-1": { id: "post-1", channel_id: "CURRENT", message: "older", create_at: 1_000 },
          "post-2": { id: "post-2", channel_id: "CURRENT", message: "newer", create_at: 2_000 },
        },
      });
    }
    throw new Error(`Unexpected Mattermost request: ${url}`);
  });
}

function delegatedContext(currentChannelId = "channel:CURRENT", currentMessagingTarget?: string) {
  return {
    conversationReadOrigin: "delegated" as const,
    requesterAccountId: "default",
    toolContext: {
      currentChannelProvider: "mattermost",
      currentChannelId,
      currentMessagingTarget,
    },
  };
}

function config(overrides: NonNullable<NonNullable<OpenClawConfig["channels"]>["mattermost"]>) {
  const cfg = createMattermostTestConfig();
  Object.assign(cfg.channels!.mattermost!, overrides);
  return cfg;
}

function read(overrides: Partial<Parameters<typeof readMattermostMessages>[0]> = {}) {
  return readMattermostMessages({
    cfg: createMattermostTestConfig(),
    channelId: "OTHER",
    accountId: "default",
    context: delegatedContext(),
    ...overrides,
  });
}

describe("readMattermostMessages", () => {
  let fetchImpl: ReturnType<typeof createReadFetch>;
  beforeEach(() => {
    fetchFixture.current = fetchImpl = createReadFetch();
  });

  it.each([
    { groupPolicy: "allowlist", groups: { OTHER: { requireMention: false } } },
    { groupPolicy: "open" },
  ] as const)("allows delegated reads with $groupPolicy access", async (policy) => {
    await expect(read({ cfg: config(policy) })).resolves.toMatchObject({
      messages: [{ id: "post-2" }, { id: "post-1" }],
    });
  });

  it("denies direct-message cross-channel targets after one channel lookup", async () => {
    fetchFixture.current = fetchImpl = createReadFetch({ channelType: "D" });
    await expect(read({ cfg: config({ groupPolicy: "open" }) })).rejects.toThrow(
      "Mattermost read target channel is not allowed",
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("uses the trusted native channel ID for the current DM", async () => {
    const result = await read({
      channelId: "CURRENT",
      limit: 2,
      context: delegatedContext("channel:CURRENT", "user:PEER"),
    });

    expect(result.messages.map((message) => message.id)).toEqual(["post-2", "post-1"]);
    expect(requestUrl(fetchImpl.mock.calls[0]![0])).toContain("/channels/CURRENT/posts?per_page=2");
  });

  it.each([
    ["unconfigured cross-channel target", {}, "Mattermost read target channel is not allowed", 0],
    [
      "account switching",
      { context: { ...delegatedContext(), requesterAccountId: "other-account" } },
      "Mattermost delegated reads require the current Mattermost account",
      0,
    ],
    [
      "conflicting native conversation",
      { channelId: "CURRENT", context: delegatedContext("channel:OTHER", "channel:CURRENT") },
      "Mattermost read target channel is not allowed",
      0,
    ],
    [
      "disabled account",
      { cfg: config({ enabled: false }), channelId: "CURRENT" },
      'Mattermost account "default" is disabled',
      0,
    ],
  ] satisfies [string, Parameters<typeof read>[0], string, number][])(
    "rejects %s before reading posts",
    async (_name, params, error, requests) => {
      await expect(read(params)).rejects.toThrow(error);
      expect(fetchImpl).toHaveBeenCalledTimes(requests);
    },
  );

  it("lets a direct operator rely on Mattermost membership and preserves 403 errors", async () => {
    fetchFixture.current = createReadFetch({ postStatus: 403 });

    await expect(read({ context: { conversationReadOrigin: "direct-operator" } })).rejects.toThrow(
      "Mattermost API 403 Forbidden: You do not have the appropriate permissions.",
    );
  });
});
