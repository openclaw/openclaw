import fs from "node:fs/promises";
import { setImmediate } from "node:timers/promises";
import type { ContextVisibilityMode, OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { getMediaDir } from "openclaw/plugin-sdk/media-runtime";
import { resetInboundDedupe } from "openclaw/plugin-sdk/reply-runtime";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  defaultSlackTestConfig,
  getSlackHandlerOrThrow,
  getSlackClient,
  getSlackTestState,
  resetSlackTestState,
  runSlackHandlerWithDispatch,
  startSlackMonitor,
  stopSlackMonitor,
  waitForSlackTestApp,
} from "./monitor.test-helpers.js";
import * as mediaRuntime from "./monitor/media.runtime.js";
import type { SlackMessageEvent } from "./types.js";

const mediaFetchMock = vi.hoisted(() =>
  vi.fn<typeof import("./monitor/media.runtime.js").fetchWithRuntimeDispatcher>(),
);
vi.mock("./monitor/media.runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./monitor/media.runtime.js")>()),
  fetchWithRuntimeDispatcher: mediaFetchMock,
}));
const { monitorSlackProvider } = await import("./monitor/provider.js");
const slackTestState = getSlackTestState();
const { sendMock, replyMock } = slackTestState;

beforeEach(async () => {
  mediaFetchMock.mockReset().mockRejectedValue(new Error("Unexpected Slack media test request"));
  resetInboundDedupe();
  await resetSlackTestState(defaultSlackTestConfig());
});

afterEach(async () => {
  clearRuntimeConfigSnapshot();
  await fs.rm(getMediaDir(), { recursive: true, force: true });
});

function makeSlackMessageEvent(overrides: Partial<SlackMessageEvent>): SlackMessageEvent {
  return {
    type: "message",
    user: "U1",
    text: "hello",
    ts: "123",
    channel: "C1",
    channel_type: "channel",
    ...overrides,
  };
}
function captureReplyContexts<T extends Record<string, unknown>>() {
  const contexts: T[] = [];
  replyMock.mockImplementation(async (ctx: unknown) => {
    contexts.push(ctx as T);
  });
  return contexts;
}

function historyConfig(users = ["U1"], contextVisibility: ContextVisibilityMode = "allowlist") {
  const config: OpenClawConfig = {
    channels: {
      slack: {
        groupPolicy: "open",
        contextVisibility,
        channels: { C1: { requireMention: true, users } },
      },
    },
  };
  slackTestState.config = config;
  return config;
}

function revokeHistory(config: OpenClawConfig) {
  const revoked: OpenClawConfig = {
    channels: { slack: { ...config.channels?.slack, enabled: false } },
  };
  setRuntimeConfigSnapshot(revoked, revoked);
}

function imageFile(name: string) {
  return {
    id: `F${name}`,
    name: `${name}.png`,
    mimetype: "image/png",
    url_private: `https://files.slack.com/${name}.png`,
  };
}

function imageResponse() {
  return new Response(Buffer.from("historical image"), {
    headers: { "content-type": "image/png" },
  });
}

async function runHistoryMessage(event: SlackMessageEvent) {
  const monitor = startSlackMonitor(monitorSlackProvider);
  try {
    await waitForSlackTestApp(monitor, "started");
    const handler = await getSlackHandlerOrThrow("message");
    // Policy interleavings own these downloads; host load must not expire their deadlines.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await runSlackHandlerWithDispatch(handler, { event });
  } finally {
    vi.useRealTimers();
    await stopSlackMonitor(monitor);
  }
}

describe("Slack native history sender policy through monitor dispatch", () => {
  it.each(["allowlist", "all"] as const)(
    "enforces %s visibility before bot history hydration and dispatch",
    async (contextVisibility) => {
      historyConfig(["U1", "UALLOWED", "BONLY"], contextVisibility);
      const messages = [
        { ts: "102", user: "UDENIED", bot_id: "BONLY", text: "denied user identity" },
        { ts: "101", bot_id: "BDENIED", text: "denied bot identity" },
        { ts: "100", user: "UALLOWED", bot_id: "BALLOWED", text: "allowed bot user" },
        { ts: "99", bot_id: "BONLY", text: "allowed bot-only identity" },
      ].map((message) => Object.assign(message, { files: [imageFile(message.ts)] }));
      getSlackClient().conversations.history.mockResolvedValue({ messages });
      mediaFetchMock.mockImplementation(async () => imageResponse());
      const captured = captureReplyContexts<{
        Body?: string;
        RawBody?: string;
        InboundHistory?: Array<{ body: string; media?: Array<{ path?: string }> }>;
      }>();
      await runHistoryMessage(
        makeSlackMessageEvent({
          text: "<@bot-user> inspect prior bot discussion",
          ts: "103",
          channel_type: "channel",
        }),
      );
      expect(captured).toHaveLength(1);
      const visible = contextVisibility === "all" ? messages : messages.slice(2);
      expect(captured[0]?.InboundHistory?.map((entry) => entry.body)).toEqual(
        visible.toReversed().map((message) => message.text),
      );
      expect(captured[0]?.InboundHistory?.map((entry) => entry.media?.length)).toEqual(
        visible.map(() => 1),
      );
      expect(mediaFetchMock.mock.calls.map(([url]) => url)).toEqual(
        visible.toReversed().flatMap((message) => message.files.map((file) => file.url_private)),
      );
      expect(captured[0]?.RawBody).toContain("inspect prior bot discussion");
      expect(captured[0]?.Body).toContain("allowed bot user");
      expect(captured[0]?.Body).toContain("allowed bot-only identity");
      if (contextVisibility !== "all") {
        expect(captured[0]?.Body).not.toContain("denied");
      }
    },
  );

  it.each(["room", "thread"] as const)(
    "stops %s bot history media and dispatch when live policy is revoked during its native read",
    async (scope) => {
      const config = historyConfig(["U1", "UALLOWED"]);
      setRuntimeConfigSnapshot(config, config);
      const client = getSlackClient();
      const read = scope === "thread" ? client.conversations.replies : client.conversations.history;
      read.mockImplementation(async () => {
        revokeHistory(config);
        return {
          messages: [
            {
              ts: "100",
              user: "UALLOWED",
              bot_id: "BALLOWED",
              text: "revoked bot context",
              files: [imageFile("revoked")],
            },
          ],
        };
      });
      await runHistoryMessage(
        makeSlackMessageEvent({
          text: "<@bot-user> inspect bot discussion",
          ts: "103",
          channel_type: "channel",
          ...(scope === "thread" ? { thread_ts: "100" } : {}),
        }),
      ).catch((error: unknown) => {
        expect(error).toBeInstanceOf(Error);
      });
      expect(read).toHaveBeenCalledOnce();
      expect(mediaFetchMock).not.toHaveBeenCalled();
      expect(replyMock).not.toHaveBeenCalled();
      expect(sendMock).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    "settles historical media before dispatch when mid-download revocation is %s",
    async (revoke) => {
      const config = historyConfig();
      setRuntimeConfigSnapshot(config, config);
      const client = getSlackClient();
      const files = [1, 2, 3, 4].map((id) => imageFile(String(id)));
      client.conversations.history.mockResolvedValue({
        messages: [{ ts: "100", user: "U1", text: "four historical images", files }],
      });
      const refresh = vi.fn().mockResolvedValue({
        file: { ...files[1], url_private: "https://files.slack.com/2-refreshed.png" },
      });
      const previousFiles = Reflect.get(client, "files");
      Reflect.set(client, "files", { info: refresh });
      const started = createDeferred<void>();
      const release = createDeferred<void>();
      mediaFetchMock.mockImplementation(async (url) => {
        if (mediaFetchMock.mock.calls.length === 3) {
          started.resolve();
        }
        await release.promise;
        return url === "https://files.slack.com/2.png"
          ? new Response("expired URL", { status: 404 })
          : imageResponse();
      });
      const captured = captureReplyContexts<{
        InboundHistory?: Array<{ media?: Array<{ path?: string }> }>;
      }>();
      const mediaDir = getMediaDir();
      await fs.mkdir(mediaDir, { recursive: true });
      const run = runHistoryMessage(
        makeSlackMessageEvent({ ts: "103", text: "<@bot-user> inspect images" }),
      ).catch((error: unknown) => {
        if (!revoke) {
          throw error;
        }
        expect(error).toBeInstanceOf(Error);
      });
      try {
        await started.promise;
        if (revoke) {
          revokeHistory(config);
        }
        release.resolve();
        await run;
        const writtenFiles = (
          await fs.readdir(mediaDir, { recursive: true, withFileTypes: true })
        ).filter((entry) => entry.isFile());
        if (revoke) {
          expect(mediaFetchMock).toHaveBeenCalledTimes(3);
          expect(refresh).not.toHaveBeenCalled();
          expect(writtenFiles).toEqual([]);
          expect(replyMock).not.toHaveBeenCalled();
          expect(sendMock).not.toHaveBeenCalled();
        } else {
          expect(mediaFetchMock).toHaveBeenCalledTimes(5);
          expect(refresh).toHaveBeenCalledExactlyOnceWith({ file: "F2" });
          expect(captured).toHaveLength(1);
          const media = captured[0]?.InboundHistory?.flatMap((entry) => entry.media ?? []) ?? [];
          expect(media).toHaveLength(4);
          expect(writtenFiles).toHaveLength(4);
          for (const item of media) {
            if (!item.path) {
              throw new Error("Expected local history media");
            }
            expect(await fs.readFile(item.path, "utf8")).toBe("historical image");
          }
        }
      } finally {
        release.resolve();
        try {
          await run;
        } finally {
          if (previousFiles === undefined) {
            Reflect.deleteProperty(client, "files");
          } else {
            Reflect.set(client, "files", previousFiles);
          }
        }
      }
    },
  );

  it("observes a rejected direct image while joining pending forwarded media", async () => {
    const config = historyConfig();
    setRuntimeConfigSnapshot(config, config);
    const directUrl = "https://files.slack.com/direct.png";
    getSlackClient().conversations.history.mockResolvedValue({
      messages: [
        {
          ts: "100",
          user: "U1",
          text: "mixed historical media",
          files: [imageFile("direct")],
          attachments: [{ is_share: true, image_url: "https://files.slack.com/forwarded.png" }],
        },
      ],
    });
    const bothStarted = createDeferred<void>();
    const releaseDirect = createDeferred<void>();
    const releaseForwarded = createDeferred<void>();
    const directFinished = createDeferred<void>();
    const bothFinished = createDeferred<void>();
    const saveRemoteMedia = mediaRuntime.saveRemoteMedia;
    let finishedSaves = 0;
    const saveSpy = vi
      .spyOn(mediaRuntime, "saveRemoteMedia")
      .mockImplementation(async (options) => {
        try {
          return await saveRemoteMedia(options);
        } finally {
          if (options.url === directUrl) {
            directFinished.resolve();
          }
          if (++finishedSaves === 2) {
            bothFinished.resolve();
          }
        }
      });
    mediaFetchMock.mockImplementation(async (url) => {
      if (mediaFetchMock.mock.calls.length === 2) {
        bothStarted.resolve();
      }
      await (url === directUrl ? releaseDirect.promise : releaseForwarded.promise);
      return imageResponse();
    });
    const mediaDir = getMediaDir();
    await fs.mkdir(mediaDir, { recursive: true });
    let settled = false;
    const run = runHistoryMessage(
      makeSlackMessageEvent({ ts: "103", text: "<@bot-user> inspect mixed media" }),
    )
      .catch((error: unknown) => {
        expect(error).toBeInstanceOf(Error);
      })
      .finally(() => {
        settled = true;
      });
    try {
      await bothStarted.promise;
      revokeHistory(config);
      releaseDirect.resolve();
      await directFinished.promise;
      await setImmediate();
      expect(settled).toBe(false);
      releaseForwarded.resolve();
      await run;
      expect(mediaFetchMock).toHaveBeenCalledTimes(2);
      expect(replyMock).not.toHaveBeenCalled();
      expect(sendMock).not.toHaveBeenCalled();
      expect(
        (await fs.readdir(mediaDir, { recursive: true, withFileTypes: true })).filter((entry) =>
          entry.isFile(),
        ),
      ).toEqual([]);
    } finally {
      releaseDirect.resolve();
      releaseForwarded.resolve();
      await bothFinished.promise;
      try {
        await run;
      } finally {
        saveSpy.mockRestore();
      }
    }
  });
});
