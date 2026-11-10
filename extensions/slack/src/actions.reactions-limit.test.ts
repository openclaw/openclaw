import { WebClient } from "@slack/web-api";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { slackActionRuntime } from "./action-runtime.js";
import {
  listSlackReactions,
  reactSlackMessage,
  removeOwnSlackReactions,
  type SlackMessageSummary,
} from "./actions.js";
import { createSlackActions } from "./channel-actions.js";
import { registerSlackInstallationState } from "./installation-identity-state.js";

const getSlackWriteClientMock = vi.hoisted(() => vi.fn());
const installations: Array<ReturnType<typeof registerSlackInstallationState>> = [];
vi.mock("./client.js", async () => ({
  ...(await vi.importActual<typeof import("./client.js")>("./client.js")),
  getSlackWriteClient: getSlackWriteClientMock,
}));
type SlackReaction = NonNullable<SlackMessageSummary["reactions"]>[number];
const slackConfig: OpenClawConfig = {
  channels: { slack: { botToken: "xoxb-local-proof", groupPolicy: "open" } },
};
function createClient(
  reactions: SlackReaction[] = [],
  failure?: { method: string; error: string },
) {
  let pendingFailure = failure;
  const calls: Array<{ method: string; body: URLSearchParams }> = [];
  const client = new WebClient("xoxb-local-proof", {
    retryConfig: { retries: 0 },
    fetch: async (input, init) => {
      const method = new URL(String(input)).pathname.split("/").at(-1) ?? "";
      if (typeof init?.body !== "string") {
        throw new Error("Expected URL-encoded Slack request");
      }
      calls.push({ method, body: new URLSearchParams(init.body) });
      if (pendingFailure?.method === method) {
        const error = pendingFailure.error;
        pendingFailure = undefined;
        return Response.json({ ok: false, error });
      }
      const result =
        method === "reactions.get"
          ? { message: { reactions } }
          : method === "auth.test"
            ? { user_id: "UBOT" }
            : method === "reactions.add" || method === "reactions.remove"
              ? {}
              : undefined;
      if (!result) {
        throw new Error("Unexpected Slack API method: " + method);
      }
      return Response.json({ ok: true, ...result });
    },
  });
  return { client, calls };
}
function lookupSpies(client: WebClient) {
  vi.spyOn(slackActionRuntime, "listSlackReactions").mockImplementation(
    (channelId, messageId, options) =>
      listSlackReactions(channelId, messageId, { ...options, client }),
  );
  return vi.spyOn(slackActionRuntime, "readSlackMessages");
}
function action(kind: "reactions" | "read", cfg: OpenClawConfig, params: Record<string, unknown>) {
  return createSlackActions("slack").handleAction?.({
    action: kind,
    cfg,
    conversationReadOrigin: "direct-operator",
    params: { channelId: "C1", messageId: "123.456", ...params },
  } as never);
}

function installEnterprise() {
  installations.push(registerSlackInstallationState("default", "enterprise"));
}

function expectReactionWrites(
  calls: ReturnType<typeof createClient>["calls"],
  method: string,
  names: string[],
) {
  expect(
    calls
      .filter((call) => call.method === method)
      .map(({ body }) => [body.get("channel"), body.get("timestamp"), body.get("name")]),
  ).toEqual(names.map((name) => ["C1", "123.456", name]));
}

describe("Slack reactions", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    getSlackWriteClientMock.mockReset();
    for (const installation of installations.splice(0)) {
      installation.release();
    }
  });

  it("bounds public users without changing reaction facts", async () => {
    const users = Array.from({ length: 101 }, (_, index) => "U" + String(index + 1));
    const { client, calls } = createClient([
      { name: "eyes", count: 101, users },
      { name: "heart", count: 5 },
      { name: "party", count: 0, users: [] },
    ]);
    vi.spyOn(slackActionRuntime, "resolveSlackConversationInfo").mockResolvedValue({
      type: "channel",
    });
    lookupSpies(client);
    const result = await action("reactions", slackConfig, {});
    const content = result?.content[0];
    if (!content || content.type !== "text") {
      throw new Error("Expected text tool result");
    }
    expect(JSON.parse(content.text)).toEqual({
      ok: true,
      reactions: [
        { name: "eyes", count: 101, users: users.slice(0, 100) },
        { name: "heart", count: 5 },
        { name: "party", count: 0, users: [] },
      ],
    });
    expect(users).toHaveLength(101);
    expect(calls.map(({ method, body }) => [method, body.get("full"), body.has("limit")])).toEqual([
      ["reactions.get", "true", false],
    ]);
  });

  it.each(["reactions", "read"] as const)(
    "authorizes %s before inspecting malformed limits",
    async (kind) => {
      const { client, calls } = createClient();
      const lookups = lookupSpies(client);
      await expect(
        action(
          kind,
          {
            channels: {
              slack: {
                botToken: "xoxb-local-proof",
                groupPolicy: "allowlist",
                channels: { C_ALLOWED: { enabled: true } },
              },
            },
          },
          { channelId: "C_FORBIDDEN", limit: 0 },
        ),
      ).rejects.toThrow("Slack read target channel is not allowed.");
      expect(lookups).not.toHaveBeenCalled();
      expect(calls).toEqual([]);
    },
  );

  it("rejects invalid read limits before Slack API work", async () => {
    const { client, calls } = createClient();
    const lookups = lookupSpies(client);
    vi.spyOn(slackActionRuntime, "resolveSlackConversationInfo").mockResolvedValue({
      type: "channel",
    });
    await expect(action("read", slackConfig, { limit: 0 })).rejects.toThrow(
      "limit must be a positive integer.",
    );
    expect(lookups).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it("sends normalized emoji through the workspace-scoped Enterprise Grid client", async () => {
    const { client, calls } = createClient();
    getSlackWriteClientMock.mockReturnValue(client);
    installEnterprise();
    await reactSlackMessage("C1", "123.456", "👍🏽", { teamId: "T1", token: "xoxb-test" });
    expect(getSlackWriteClientMock).toHaveBeenCalledWith("xoxb-test", { teamId: "T1" });
    expectReactionWrites(calls, "reactions.add", ["thumbsup::skin-tone-4"]);
  });

  it("rejects an unscoped Enterprise Grid reaction before constructing a client", async () => {
    installEnterprise();
    await expect(reactSlackMessage("C1", "123.456", "✅", { token: "xoxb-test" })).rejects.toThrow(
      "unsupported_enterprise_slack_delivery",
    );
    expect(getSlackWriteClientMock).not.toHaveBeenCalled();
  });

  it("keeps prototype-named shortcodes intact on an idempotent add", async () => {
    const { client, calls } = createClient([], {
      method: "reactions.add",
      error: "already_reacted",
    });
    await expect(
      reactSlackMessage("C1", "123.456", ":constructor:", { client }),
    ).resolves.toBeUndefined();
    expectReactionWrites(calls, "reactions.add", ["constructor"]);
  });

  it("propagates unrelated API errors", async () => {
    const { client } = createClient([], { method: "reactions.add", error: "invalid_name" });
    await expect(reactSlackMessage("C1", "123.456", "⚠️", { client })).rejects.toMatchObject({
      message: "An API error occurred: invalid_name",
      data: { ok: false, error: "invalid_name" },
    });
  });

  it("removes only own reactions beyond the public cap through the idempotent remove helper", async () => {
    const users = [...Array.from({ length: 100 }, (_, index) => "U" + String(index)), "UBOT"];
    const { client, calls } = createClient(
      [
        { name: "thumbsup", users },
        { name: "eyes", users: ["U2", "UBOT"] },
        { name: "wave", users: ["U2"] },
      ],
      { method: "reactions.remove", error: "no_reaction" },
    );
    await expect(removeOwnSlackReactions("C1", "123.456", { client })).resolves.toEqual([
      "thumbsup",
      "eyes",
    ]);
    expect(calls.map(({ method }) => method)).toEqual([
      "auth.test",
      "reactions.get",
      "reactions.remove",
      "reactions.remove",
    ]);
    expect(calls[1]?.body.get("full")).toBe("true");
    expectReactionWrites(calls, "reactions.remove", ["thumbsup", "eyes"]);
  });
});
