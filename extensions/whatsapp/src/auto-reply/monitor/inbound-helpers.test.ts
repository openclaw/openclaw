import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it } from "vitest";
import { createTestWebInboundMessage } from "../../inbound/test-message.test-helper.js";
import { noteGroupMember } from "./group-members.js";
import {
  resolveVisibleWhatsAppGroupHistory,
  resolveVisibleWhatsAppReplyContext,
} from "./inbound-context.js";
import { trackBackgroundTask } from "./last-route.js";

type ReplyContextParams = Parameters<typeof resolveVisibleWhatsAppReplyContext>[0];
const visibility = {
  mode: "allowlist",
  groupPolicy: "allowlist",
  groupAllowFrom: ["+111"],
} as const satisfies Omit<ReplyContextParams, "msg">;
const visibleReply = (quote: ReplyContextParams["msg"]["quote"]) =>
  resolveVisibleWhatsAppReplyContext({
    msg: createTestWebInboundMessage({
      admission: { conversation: { kind: "group", id: "123@g.us" } },
      quote,
    }),
    ...visibility,
  });
const historyEntry = (name: string, phone: string, body: string) => ({
  sender: `${name} (${phone})`,
  body,
  senderJid: `${phone.slice(1)}@s.whatsapp.net`,
});

describe("whatsapp inbound context visibility", () => {
  it("filters non-allowlisted group history from supplemental context", () => {
    const allowed = historyEntry("Alice", "+111", "Allowed context");
    const history = resolveVisibleWhatsAppGroupHistory({
      history: [allowed, historyEntry("Mallory", "+999", "Blocked context")],
      ...visibility,
    });

    expect(history).toEqual([allowed]);
  });

  it("redacts blocked quoted replies in allowlist mode", () => {
    expect(
      visibleReply({
        body: "Blocked quoted text",
        sender: { jid: "999@s.whatsapp.net" },
      }),
    ).toBeNull();
  });

  it("renders structured quoted media only at the visible preview boundary", () => {
    const reply = visibleReply({
      context: {
        id: "quoted-sticker",
        body: "",
        media: { contentType: "image/webp", kind: "sticker" },
        sender: { jid: "111@s.whatsapp.net", label: "Alice (+111)" },
      },
    });

    expect(reply).toMatchObject({
      body: "<media:sticker>",
      media: { contentType: "image/webp", kind: "sticker" },
    });
  });

  it("resolves quoted LID sender to mapped phone label via authDir", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-reply-lid-test-"));
    try {
      fs.writeFileSync(path.join(tempDir, "lid-mapping-111_reverse.json"), JSON.stringify("111"));
      const reply = resolveVisibleWhatsAppReplyContext({
        msg: createTestWebInboundMessage({
          admission: { conversation: { kind: "group", id: "123@g.us" } },
          quote: {
            context: {
              id: "quoted-lid",
              body: "hello from lid",
              sender: { lid: "111@lid", label: "111@lid" },
            },
          },
        }),
        ...visibility,
        authDir: tempDir,
      });
      expect(reply?.sender).toMatchObject({
        lid: "111@lid",
        e164: "+111",
        label: "+111",
      });
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

it("ignores incomplete group member values", () => {
  const groupMemberNames = new Map<string, Map<string, string>>();

  noteGroupMember(groupMemberNames, "g1", undefined, "Alice");
  noteGroupMember(groupMemberNames, "g1", "+15551234567", undefined);

  expect(groupMemberNames.get("g1")).toBeUndefined();
});

it("does not leak unhandled rejections when a tracked task fails", async () => {
  const unhandledRejections: unknown[] = [];
  const onUnhandledRejection = (reason: unknown) => unhandledRejections.push(reason);

  process.on("unhandledRejection", onUnhandledRejection);
  try {
    const backgroundTasks = new Set<Promise<unknown>>();
    const { promise: task, reject } = createDeferred<void>();

    trackBackgroundTask(backgroundTasks, task);
    expect(backgroundTasks.size).toBe(1);

    reject(new Error("boom"));
    await Promise.allSettled([task]);
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });

    expect(backgroundTasks.size).toBe(0);
    expect(unhandledRejections).toStrictEqual([]);
  } finally {
    process.off("unhandledRejection", onUnhandledRejection);
  }
});
