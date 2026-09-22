import fs from "node:fs/promises";
import { setImmediate } from "node:timers/promises";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { getMediaDir } from "openclaw/plugin-sdk/media-runtime";
import { resetInboundDedupe } from "openclaw/plugin-sdk/reply-runtime";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  defaultSlackTestConfig,
  getSlackClient,
  getSlackTestState,
  resetSlackTestState,
  runSlackMessageOnce,
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
    return undefined;
  });
  return contexts;
}

describe("Slack native history sender policy through monitor dispatch", () => {
  it.each(["allowlist", "allowlist_quote", "all"] as const)(
    "enforces %s visibility before bot history hydration and dispatch",
    async (contextVisibility) => {
      slackTestState.config = {
        channels: {
          slack: {
            groupPolicy: "open",
            contextVisibility,
            channels: { C1: { requireMention: true, users: ["U1", "UALLOWED", "BONLY"] } },
          },
        },
      };
      const messages = [
        { ts: "102", user: "UDENIED", bot_id: "BONLY", text: "denied user identity" },
        { ts: "101", bot_id: "BDENIED", text: "denied bot identity" },
        { ts: "100", user: "UALLOWED", bot_id: "BALLOWED", text: "allowed bot user" },
        { ts: "99", bot_id: "BONLY", text: "allowed bot-only identity" },
      ].map((message) =>
        Object.assign(message, {
          files: [
            {
              id: `F${message.ts}`,
              name: `${message.ts}.png`,
              mimetype: "image/png",
              url_private: `https://files.slack.com/${message.ts}.png`,
            },
          ],
        }),
      );
      getSlackClient().conversations.history.mockResolvedValue({ messages });
      mediaFetchMock.mockImplementation(
        async () =>
          new Response(Buffer.from("image data"), {
            headers: { "content-type": "image/png" },
          }),
      );
      const captured = captureReplyContexts<{
        Body?: string;
        RawBody?: string;
        InboundHistory?: Array<{ body: string; media?: Array<{ path?: string }> }>;
      }>();
      try {
        await runSlackMessageOnce(
          monitorSlackProvider,
          {
            event: makeSlackMessageEvent({
              text: "<@bot-user> inspect prior bot discussion",
              ts: "103",
              channel_type: "channel",
            }),
          },
          { awaitDispatch: true },
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
      } finally {
        for (const ctx of captured) {
          for (const entry of ctx.InboundHistory ?? []) {
            for (const media of entry.media ?? []) {
              if (media.path) {
                await fs.rm(media.path, { force: true });
              }
            }
          }
        }
      }
    },
  );

  it.each(["room", "thread"] as const)(
    "stops %s bot history media and dispatch when live policy is revoked during its native read",
    async (scope) => {
      const config: OpenClawConfig = {
        channels: {
          slack: {
            groupPolicy: "open",
            contextVisibility: "allowlist",
            channels: { C1: { requireMention: true, users: ["U1", "UALLOWED"] } },
          },
        },
      };
      const revoked: OpenClawConfig = {
        channels: { slack: { ...config.channels?.slack, enabled: false } },
      };
      slackTestState.config = config;
      setRuntimeConfigSnapshot(config, config);
      const client = getSlackClient();
      const read = scope === "thread" ? client.conversations.replies : client.conversations.history;
      read.mockImplementation(async () => {
        setRuntimeConfigSnapshot(revoked, revoked);
        return {
          messages: [
            {
              ts: "100",
              user: "UALLOWED",
              bot_id: "BALLOWED",
              text: "revoked bot context",
              files: [
                {
                  id: "FREVOKED",
                  name: "revoked.png",
                  mimetype: "image/png",
                  url_private: "https://files.slack.com/revoked.png",
                },
              ],
            },
          ],
        };
      });
      try {
        await runSlackMessageOnce(
          monitorSlackProvider,
          {
            event: makeSlackMessageEvent({
              text: "<@bot-user> inspect bot discussion",
              ts: "103",
              channel_type: "channel",
              ...(scope === "thread" ? { thread_ts: "100" } : {}),
            }),
          },
          { awaitDispatch: true },
        ).catch((error: unknown) => {
          expect(error).toBeInstanceOf(Error);
        });
        expect(read).toHaveBeenCalledOnce();
        expect(mediaFetchMock).not.toHaveBeenCalled();
        expect(replyMock).not.toHaveBeenCalled();
        expect(sendMock).not.toHaveBeenCalled();
      } finally {
        clearRuntimeConfigSnapshot();
      }
    },
  );

  it.each([false, true])(
    "settles historical media before dispatch when mid-download revocation is %s",
    async (revoke) => {
      const config: OpenClawConfig = {
        channels: {
          slack: {
            groupPolicy: "open",
            contextVisibility: "allowlist",
            channels: { C1: { requireMention: true, users: ["U1"] } },
          },
        },
      };
      slackTestState.config = config;
      setRuntimeConfigSnapshot(config, config);
      const client = getSlackClient();
      const files = [1, 2, 3, 4].map((id) => ({
        id: `F${id}`,
        name: `${id}.png`,
        mimetype: "image/png",
        url_private: `https://files.slack.com/${id}.png`,
      }));
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
          : new Response(Buffer.from("historical image"), {
              headers: { "content-type": "image/png" },
            });
      });
      const captured = captureReplyContexts<{
        InboundHistory?: Array<{ media?: Array<{ path?: string }> }>;
      }>();
      const mediaDir = getMediaDir();
      await fs.mkdir(mediaDir, { recursive: true });
      const run = runSlackMessageOnce(
        monitorSlackProvider,
        { event: makeSlackMessageEvent({ ts: "103", text: "<@bot-user> inspect images" }) },
        { awaitDispatch: true },
      ).catch((error: unknown) => {
        if (!revoke) {
          throw error;
        }
        expect(error).toBeInstanceOf(Error);
      });
      try {
        await started.promise;
        if (revoke) {
          const revoked: OpenClawConfig = {
            channels: { slack: { ...config.channels?.slack, enabled: false } },
          };
          setRuntimeConfigSnapshot(revoked, revoked);
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
          clearRuntimeConfigSnapshot();
          if (previousFiles === undefined) {
            Reflect.deleteProperty(client, "files");
          } else {
            Reflect.set(client, "files", previousFiles);
          }
          await fs.rm(mediaDir, { recursive: true, force: true });
        }
      }
    },
  );

  it("observes a rejected direct image while joining pending forwarded media", async () => {
    const config: OpenClawConfig = {
      channels: {
        slack: {
          groupPolicy: "open",
          contextVisibility: "allowlist",
          channels: { C1: { requireMention: true, users: ["U1"] } },
        },
      },
    };
    slackTestState.config = config;
    setRuntimeConfigSnapshot(config, config);
    const directUrl = "https://files.slack.com/direct.png";
    getSlackClient().conversations.history.mockResolvedValue({
      messages: [
        {
          ts: "100",
          user: "U1",
          text: "mixed historical media",
          files: [
            { id: "FDIRECT", name: "direct.png", mimetype: "image/png", url_private: directUrl },
          ],
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
      return new Response(Buffer.from("historical image"), {
        headers: { "content-type": "image/png" },
      });
    });
    const mediaDir = getMediaDir();
    await fs.mkdir(mediaDir, { recursive: true });
    let settled = false;
    const run = runSlackMessageOnce(
      monitorSlackProvider,
      { event: makeSlackMessageEvent({ ts: "103", text: "<@bot-user> inspect mixed media" }) },
      { awaitDispatch: true },
    )
      .catch((error: unknown) => {
        expect(error).toBeInstanceOf(Error);
      })
      .finally(() => {
        settled = true;
      });
    try {
      await bothStarted.promise;
      const revoked: OpenClawConfig = {
        channels: { slack: { ...config.channels?.slack, enabled: false } },
      };
      setRuntimeConfigSnapshot(revoked, revoked);
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
        clearRuntimeConfigSnapshot();
        await fs.rm(mediaDir, { recursive: true, force: true });
      }
    }
  });
});
