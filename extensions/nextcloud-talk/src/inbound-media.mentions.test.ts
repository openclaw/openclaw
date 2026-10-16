import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildMentionRegexes, matchesMentionPatterns } from "openclaw/plugin-sdk/channel-inbound";
import {
  closeOpenClawStateDatabaseForTest,
  createChannelIngressQueueForTests,
} from "openclaw/plugin-sdk/channel-ingress-test-runtime";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginRuntime, RuntimeEnv } from "../runtime-api.js";
import type { ResolvedNextcloudTalkAccount } from "./accounts.js";
import { handleNextcloudTalkInbound } from "./inbound.js";
import { createSignedFileSharedActivityRequest } from "./monitor.test-fixtures.js";
import { setNextcloudTalkRuntime } from "./runtime.js";
import type { CoreConfig, NextcloudTalkInboundMessage } from "./types.js";
import type { NextcloudTalkIngressPayload } from "./webhook-spool-state.js";
import {
  createNextcloudTalkWebhookSpool,
  type NextcloudTalkIngressLifecycle,
} from "./webhook-spool.js";

vi.mock("./room-info.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./room-info.js")>()),
  resolveNextcloudTalkRoomKind: vi.fn(async () => "group"),
}));

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  vi.restoreAllMocks();
});

describe("file-share caption mention admission", () => {
  it.each([
    { caption: "{mention-user1} inspect {file}", mentioned: true },
    { caption: "@bert inspect {file}", mentioned: true },
    { caption: "inspect {file}", mentioned: false },
    { caption: "{file}", mentioned: false },
  ])(
    "gates durable caption $caption without treating file metadata as mentions",
    async ({ caption, mentioned }) => {
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), "nextcloud-mentions-"));
      const core = createPluginRuntimeMock();
      core.channel.mentions.buildMentionRegexes = buildMentionRegexes;
      core.channel.mentions.matchesMentionPatterns = matchesMentionPatterns;
      setNextcloudTalkRuntime(core as unknown as PluginRuntime);
      const account: ResolvedNextcloudTalkAccount = {
        accountId: "default",
        enabled: true,
        baseUrl: "https://nextcloud.example",
        secret: "fixture",
        secretSource: "config",
        config: {
          groupPolicy: "open",
          mediaAllowFrom: [],
          rooms: { "redacted-room-token": { requireMention: true } },
        },
      };
      const config = {
        messages: { groupChat: { mentionPatterns: ["@bert\\b"] } },
        channels: { "nextcloud-talk": account.config },
      } as CoreConfig;
      const runtime = { log: vi.fn(), error: vi.fn() } as unknown as RuntimeEnv;
      const queue = createChannelIngressQueueForTests<NextcloudTalkIngressPayload>({
        channelId: "nextcloud-talk",
        accountId: "default",
        stateDir: directory,
      });
      const deliver = vi.fn(
        async (message: NextcloudTalkInboundMessage, lifecycle: NextcloudTalkIngressLifecycle) => {
          await handleNextcloudTalkInbound({
            message,
            account,
            config,
            runtime,
            turnAdoptionLifecycle: lifecycle,
          });
        },
      );
      const spool = createNextcloudTalkWebhookSpool({
        accountId: "default",
        queue,
        deliver,
        runtime,
        legacyReplayStore: null,
        pollIntervalMs: 60_000,
      });
      try {
        const envelope = JSON.parse(createSignedFileSharedActivityRequest().body);
        const content = JSON.parse(envelope.object.content);
        content.message = caption;
        content.parameters["mention-user1"] = { type: "user", id: "bert", name: "bert" };
        // These values must not manufacture a mention when absent from the caption.
        content.parameters.actor.name = "bert";
        content.parameters.file.name = "bert.pdf";
        envelope.object.content = JSON.stringify(content);
        expect(await spool.receive(JSON.stringify(envelope))).toBe("accepted");
        await spool.waitForIdle();
        expect(deliver).toHaveBeenCalledTimes(1);
        expect(runtime.error).not.toHaveBeenCalled();
        expect(core.channel.inbound.dispatch).toHaveBeenCalledTimes(mentioned ? 1 : 0);
        expect(core.channel.media.saveRemoteMedia).not.toHaveBeenCalled();
        if (mentioned) {
          expect(
            vi.mocked(core.channel.inbound.buildContext).mock.calls[0]?.[0].access?.mentions
              ?.wasMentioned,
          ).toBe(true);
        }
      } finally {
        await spool.stop();
        closeOpenClawStateDatabaseForTest();
        await fs.rm(directory, { recursive: true, force: true });
      }
    },
  );
});
