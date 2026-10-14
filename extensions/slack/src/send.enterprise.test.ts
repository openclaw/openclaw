import type { ChatPostMessageResponse, WebClient } from "@slack/web-api";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerSlackInstallationState } from "./installation-identity-state.js";
import { SLACK_EDIT_TEXT_MAX_BYTES } from "./limits.js";
import type { SlackPostMessagePayload } from "./post-message-payload.js";
import {
  clearSlackThreadParticipationCache,
  hasSlackThreadParticipation,
} from "./sent-thread-cache.js";
import { countSlackTextUtf8Bytes } from "./truncate.js";

const loadOutboundMediaFromUrl = vi.hoisted(() =>
  vi.fn(async () => ({
    buffer: Buffer.from("image"),
    contentType: "image/png",
    fileName: "image.png",
  })),
);
const fetchWithSsrFGuard = vi.hoisted(() => vi.fn());
const getSlackWriteClientMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/fetch-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/fetch-runtime")>()),
  withTrustedEnvProxyGuardedFetchMode: (value: unknown) => value,
}));
vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({ fetchWithSsrFGuard }));
vi.mock("openclaw/plugin-sdk/outbound-media", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/outbound-media")>()),
  loadOutboundMediaFromUrl,
}));
vi.mock("./client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./client.js")>();
  return { ...actual, getSlackWriteClient: getSlackWriteClientMock };
});

const { sendMessageSlack, updateMessageSlack } = await import("./send.js");

type Post = (payload: SlackPostMessagePayload) => Promise<ChatPostMessageResponse>;
type EnterpriseTestClient = WebClient & {
  chat: { postMessage: ReturnType<typeof vi.fn<Post>> };
  files: {
    getUploadURLExternal: ReturnType<typeof vi.fn>;
    completeUploadExternal: ReturnType<typeof vi.fn>;
  };
};

const ENTERPRISE_CFG = { channels: { slack: {} } };

function createEnterpriseClient(): EnterpriseTestClient {
  return {
    chat: {
      postMessage: vi.fn(async () => ({ ok: true, ts: "123.456", channel: "C123" })),
    },
    files: {
      getUploadURLExternal: vi.fn(async () => ({
        ok: true,
        upload_url: "https://files.slack.com/upload",
        file_id: "F123",
      })),
      completeUploadExternal: vi.fn(async () => ({ ok: true })),
    },
  } as unknown as EnterpriseTestClient;
}

function eventScope(client: WebClient, teamId = "T1", writeClient: WebClient = client) {
  return {
    teamId,
    client,
    writeClient,
  };
}

function enterpriseOptions(client: WebClient, teamId = "T1", writeClient: WebClient = client) {
  return {
    cfg: ENTERPRISE_CFG,
    eventScope: eventScope(client, teamId, writeClient),
  };
}

describe("sendMessageSlack Enterprise listener scope", () => {
  beforeEach(() => {
    clearSlackThreadParticipationCache();
    loadOutboundMediaFromUrl.mockClear();
    fetchWithSsrFGuard.mockReset();
    getSlackWriteClientMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rejects a bare detached target for an authenticated Enterprise install", async () => {
    const installationState = registerSlackInstallationState("default", "enterprise");
    try {
      await expect(
        sendMessageSlack("C08GQH53EJM", "hello", {
          cfg: ENTERPRISE_CFG,
          token: "xoxb-enterprise",
        }),
      ).rejects.toThrow("unsupported_enterprise_slack_delivery");
      expect(getSlackWriteClientMock).not.toHaveBeenCalled();
    } finally {
      installationState.release();
    }
  });

  it("rejects qualified targets in a listener-owned workspace", async () => {
    const client = createEnterpriseClient();
    await expect(
      sendMessageSlack("team:T123:channel:C08GQH53EJM", "hello", enterpriseOptions(client)),
    ).rejects.toThrow("unsupported_enterprise_slack_delivery_target");
    expect(client.chat.postMessage).not.toHaveBeenCalled();
  });

  it.each(["T1", "T2"])(
    "isolates workspace queues and snapshots the writer (second workspace: %s)",
    async (teamId) => {
      const firstClient = createEnterpriseClient();
      const secondClient = createEnterpriseClient();
      const replacementClient = createEnterpriseClient();
      const firstStarted = createDeferred<void>();
      const release = createDeferred<void>();
      const secondStarted = createDeferred<void>();
      firstClient.chat.postMessage.mockImplementationOnce(async () => {
        firstStarted.resolve();
        await release.promise;
        return { ok: true, ts: "1.000", channel: "C123" };
      });
      secondClient.chat.postMessage.mockImplementationOnce(async () => {
        secondStarted.resolve();
        return { ok: true, ts: "2.000", channel: "C123" };
      });
      const first = sendMessageSlack("C123", "first", enterpriseOptions(firstClient));
      await firstStarted.promise;
      const scope = eventScope(secondClient, teamId);
      const second = sendMessageSlack("C123", "second", { cfg: ENTERPRISE_CFG, eventScope: scope });
      scope.client = replacementClient;
      scope.writeClient = replacementClient;
      if (teamId === "T1") {
        await Promise.resolve();
        expect(secondClient.chat.postMessage).not.toHaveBeenCalled();
      } else {
        await secondStarted.promise;
      }
      release.resolve();
      await Promise.all([first, second]);
      expect(secondClient.chat.postMessage).toHaveBeenCalledOnce();
      expect(replacementClient.chat.postMessage).not.toHaveBeenCalled();
    },
  );

  it("rejects delivery without the one-shot writer", async () => {
    const client = createEnterpriseClient();
    await expect(
      sendMessageSlack("C123", "caption", {
        cfg: ENTERPRISE_CFG,
        eventScope: { teamId: "T1", client },
        mediaUrl: "https://example.com/image.png",
      }),
    ).rejects.toThrow("missing_enterprise_slack_write_client");
    expect(client.files.getUploadURLExternal).not.toHaveBeenCalled();
    expect(fetchWithSsrFGuard).not.toHaveBeenCalled();
  });

  it("keeps upload URL reads on the listener and completion plus posts on the one-shot writer", async () => {
    const release = vi.fn(async () => {});
    fetchWithSsrFGuard.mockResolvedValue({
      response: { ok: true, status: 200 },
      release,
    });
    const listenerClient = createEnterpriseClient();
    const writeClient = createEnterpriseClient();
    writeClient.chat.postMessage
      .mockResolvedValueOnce({ ok: true, ts: "123.001", channel: "C123" })
      .mockResolvedValueOnce({ ok: true, ts: "123.002", channel: "C123" });

    const result = await sendMessageSlack("C123", "12345678abcdefghZ", {
      ...enterpriseOptions(listenerClient, "T1", writeClient),
      mediaUrl: "https://example.com/image.png",
      textLimit: 8,
      mediaMaxBytes: 5,
      threadTs: "1712345678.123456",
      cfg: { channels: { slack: { unfurlLinks: true, unfurlMedia: true } } },
    });

    expect(loadOutboundMediaFromUrl).toHaveBeenCalledWith(
      "https://example.com/image.png",
      expect.objectContaining({ maxBytes: 5 }),
    );
    expect(fetchWithSsrFGuard).toHaveBeenCalledWith(
      expect.objectContaining({ auditContext: "slack-enterprise-immediate-upload" }),
    );
    expect(listenerClient.files.getUploadURLExternal).toHaveBeenCalledOnce();
    expect(listenerClient.files.completeUploadExternal).not.toHaveBeenCalled();
    expect(writeClient.files.getUploadURLExternal).not.toHaveBeenCalled();
    expect(writeClient.files.completeUploadExternal).toHaveBeenCalledWith({
      files: [{ id: "F123", title: "image.png" }],
      channel_id: "C123",
      initial_comment: "12345678",
      thread_ts: "1712345678.123456",
    });
    expect(writeClient.chat.postMessage.mock.calls.map((call) => call[0]?.text)).toEqual([
      "abcdefgh",
      "Z",
    ]);
    expect(listenerClient.chat.postMessage).not.toHaveBeenCalled();
    expect(writeClient.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ unfurl_links: false, unfurl_media: true }),
    );
    expect(writeClient.chat.postMessage.mock.calls[0]?.[0]).not.toHaveProperty("team_id");
    expect(hasSlackThreadParticipation("default", "C123", "1712345678.123456", "T1")).toBe(true);
    expect(hasSlackThreadParticipation("default", "C123", "1712345678.123456", "T2")).toBe(false);
    expect(hasSlackThreadParticipation("default", "C123", "1712345678.123456")).toBe(false);
    expect(release).toHaveBeenCalledOnce();
    expect(result.receipt).toMatchObject({
      primaryPlatformMessageId: "F123",
      platformMessageIds: ["F123", "123.001", "123.002"],
    });
  });

  it("preserves account unfurl overrides when a block send falls back from custom identity", async () => {
    const postMessage = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error("missing_scope"), {
          data: { error: "missing_scope", needed: "chat:write.customize" },
        }),
      )
      .mockResolvedValue({ ts: "171234.567" });
    const client = { chat: { postMessage } } as unknown as WebClient;
    await sendMessageSlack("channel:C123", "https://example.com", {
      token: "xoxb-test",
      accountId: "work",
      client,
      cfg: {
        channels: {
          slack: {
            botToken: "xoxb-root",
            unfurlLinks: false,
            unfurlMedia: true,
            accounts: { work: { unfurlLinks: true, unfurlMedia: false } },
          },
        },
      },
      blocks: [{ type: "divider" }],
      identity: { username: "OpenClaw" },
    });
    expect(postMessage).toHaveBeenCalledTimes(2);
    for (const [payload] of postMessage.mock.calls) {
      expect(payload).toMatchObject({
        blocks: [{ type: "divider" }],
        unfurl_links: true,
        unfurl_media: false,
      });
    }
    expect(postMessage.mock.calls[1]?.[0]).not.toHaveProperty("username");
  });

  it("caps Enterprise finalization text at Slack's UTF-8 edit limit", async () => {
    const update = vi.fn(async (_payload: { text: string }) => ({ ok: true }));
    getSlackWriteClientMock.mockReturnValue({ chat: { update } } as unknown as WebClient);
    const installation = registerSlackInstallationState("default", "enterprise");
    try {
      await updateMessageSlack({
        cfg: { channels: { slack: { botToken: "xoxb-test" } } },
        channelId: "C123",
        teamId: "T123",
        messageTs: "171234.567",
        text: `${"x".repeat(3_999)}…tail`,
        blocks: [{ type: "section", text: { type: "mrkdwn", text: "status" } }],
      });
      expect(getSlackWriteClientMock).toHaveBeenCalledWith("xoxb-test", { teamId: "T123" });
      expect(update).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ text: `${"x".repeat(3_997)}…` }),
      );
      expect(countSlackTextUtf8Bytes(update.mock.calls[0]![0].text)).toBe(
        SLACK_EDIT_TEXT_MAX_BYTES,
      );
    } finally {
      installation.release();
    }
  });
});
