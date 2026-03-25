import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createWhatsAppPollFixture,
  expectWhatsAppPollSent,
} from "../../../src/test-helpers/whatsapp-outbound.js";
import {
  createDirectoryTestRuntime,
  expectDirectorySurface,
} from "../../../test/helpers/extensions/directory.ts";
import { whatsappPlugin } from "./channel.js";
import {
  resolveWhatsAppGroupRequireMention,
  resolveWhatsAppGroupToolPolicy,
} from "./group-policy.js";
import type { OpenClawConfig } from "./runtime-api.js";

const hoisted = vi.hoisted(() => ({
  sendPollWhatsApp: vi.fn(async () => ({ messageId: "wa-poll-1", toJid: "1555@s.whatsapp.net" })),
}));

vi.mock("./runtime.js", () => ({
  getWhatsAppRuntime: () => ({
    logging: {
      shouldLogVerbose: () => false,
    },
    channel: {
      whatsapp: {
        sendPollWhatsApp: hoisted.sendPollWhatsApp,
      },
    },
  }),
}));

describe("whatsappPlugin outbound sendMedia", () => {
  it("forwards mediaLocalRoots to sendMessageWhatsApp", async () => {
    const sendWhatsApp = vi.fn(async () => ({
      messageId: "msg-1",
      toJid: "15551234567@s.whatsapp.net",
    }));
    const mediaLocalRoots = ["/tmp/workspace"];

    const outbound = whatsappPlugin.outbound;
    if (!outbound?.sendMedia) {
      throw new Error("whatsapp outbound sendMedia is unavailable");
    }

    const result = await outbound.sendMedia({
      cfg: {} as never,
      to: "whatsapp:+15551234567",
      text: "photo",
      mediaUrl: "/tmp/workspace/photo.png",
      mediaLocalRoots,
      accountId: "default",
      deps: { sendWhatsApp },
      gifPlayback: false,
    });

    expect(sendWhatsApp).toHaveBeenCalledWith(
      "whatsapp:+15551234567",
      "photo",
      expect.objectContaining({
        verbose: false,
        mediaUrl: "/tmp/workspace/photo.png",
        mediaLocalRoots,
        accountId: "default",
        gifPlayback: false,
      }),
    );
    expect(result).toMatchObject({ channel: "whatsapp", messageId: "msg-1" });
  });
});

describe("whatsappPlugin outbound sendPoll", () => {
  beforeEach(async () => {
    vi.resetModules();
  });

  it("threads cfg into runtime sendPollWhatsApp call", async () => {
    const { cfg, poll, to, accountId } = createWhatsAppPollFixture();

    const result = await whatsappPlugin.outbound!.sendPoll!({
      cfg,
      to,
      poll,
      accountId,
    });

    expectWhatsAppPollSent(hoisted.sendPollWhatsApp, { cfg, poll, to, accountId });
    expect(result).toEqual({
      channel: "whatsapp",
      messageId: "wa-poll-1",
      toJid: "1555@s.whatsapp.net",
    });
  });
});

describe("whatsapp directory", () => {
  const runtimeEnv = createDirectoryTestRuntime() as never;

  it("lists peers and groups from config", async () => {
    const cfg = {
      channels: {
        whatsapp: {
          authDir: "/tmp/wa-auth",
          allowFrom: [
            "whatsapp:+15551230001",
            "15551230002@s.whatsapp.net",
            "120363999999999999@g.us",
          ],
          groups: {
            "120363111111111111@g.us": {},
            "120363222222222222@g.us": {},
          },
        },
      },
    } as unknown as OpenClawConfig;

    const directory = expectDirectorySurface(whatsappPlugin.directory);

    await expect(
      directory.listPeers({
        cfg,
        accountId: undefined,
        query: undefined,
        limit: undefined,
        runtime: runtimeEnv,
      }),
    ).resolves.toEqual(
      expect.arrayContaining([
        { kind: "user", id: "+15551230001" },
        { kind: "user", id: "+15551230002" },
      ]),
    );

    await expect(
      directory.listGroups({
        cfg,
        accountId: undefined,
        query: undefined,
        limit: undefined,
        runtime: runtimeEnv,
      }),
    ).resolves.toEqual(
      expect.arrayContaining([
        { kind: "group", id: "120363111111111111@g.us" },
        { kind: "group", id: "120363222222222222@g.us" },
      ]),
    );
  });
});

describe("whatsapp group policy", () => {
  it("uses generic channel group policy helpers", () => {
    const cfg = {
      channels: {
        whatsapp: {
          groups: {
            "1203630@g.us": {
              requireMention: false,
              tools: { deny: ["exec"] },
            },
            "*": {
              requireMention: true,
              tools: { allow: ["message.send"] },
            },
          },
        },
      },
      // oxlint-disable-next-line typescript/no-explicit-any
    } as any;

    expect(resolveWhatsAppGroupRequireMention({ cfg, groupId: "1203630@g.us" })).toBe(false);
    expect(resolveWhatsAppGroupRequireMention({ cfg, groupId: "other@g.us" })).toBe(true);
    expect(resolveWhatsAppGroupToolPolicy({ cfg, groupId: "1203630@g.us" })).toEqual({
      deny: ["exec"],
    });
    expect(resolveWhatsAppGroupToolPolicy({ cfg, groupId: "other@g.us" })).toEqual({
      allow: ["message.send"],
    });
  });
});
