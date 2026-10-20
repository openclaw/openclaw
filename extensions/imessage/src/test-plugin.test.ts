import fs from "node:fs";
import path from "node:path";
import { buildTypedExecApprovalPendingReplyPayload } from "openclaw/plugin-sdk/approval-reply-runtime";
import {
  createMessageReceiptFromOutboundResults,
  sendDurableMessageBatch,
  verifyChannelMessageAdapterCapabilityProofs,
} from "openclaw/plugin-sdk/channel-outbound";
import {
  createTestRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/channel-test-helpers";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { drainPendingDeliveries } from "openclaw/plugin-sdk/delivery-queue-runtime";
import { withStateDirEnv } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearIMessageApprovalReactionTargetsForTest,
  resolveIMessageApprovalReactionTargetWithPersistence,
} from "./approval-reactions.js";
import { imessagePlugin } from "./channel.js";
import * as cliOutput from "./cli-output.js";
import type { IMessageRpcClient } from "./client.js";
import { extractMarkdownFormatRuns } from "./markdown-format.js";
import { sendMessageIMessage } from "./send.js";

beforeEach(clearIMessageApprovalReactionTargetsForTest);
afterEach(() => {
  vi.restoreAllMocks();
});

function mockCliSend() {
  const run = vi.fn<(args: readonly string[]) => Promise<Record<string, unknown>>>();
  vi.spyOn(cliOutput, "runIMessageCliJsonCommand").mockImplementation(({ args }) => run(args));
  return run;
}

const IMESSAGE_WORKSPACE_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=",
  "base64",
);

function required<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new Error("Expected iMessage adapter capability");
  }
  return value;
}

function messageContext<T>(send: T) {
  return { cfg: {}, to: "+15551234567", text: "", deps: { imessage: send } };
}

function mediaAccessFor(workspaceDir: string) {
  const readFile = vi.fn((filePath: string) => fs.promises.readFile(filePath));
  return { localRoots: [workspaceDir], workspaceDir, readFile };
}

function delivery(messageId: string) {
  return { channel: "imessage" as const, messageId };
}

function receipt(messageId: string, kind: "text" | "media" | "voice" = "text", replyToId?: string) {
  return createMessageReceiptFromOutboundResults({
    results: [delivery(messageId)],
    kind,
    replyToId,
  });
}

function nativeSender(request: () => Promise<unknown>) {
  const client = { request, stop: vi.fn(async () => {}) } as unknown as IMessageRpcClient;
  return vi.fn<typeof sendMessageIMessage>((to, text, options) =>
    sendMessageIMessage(to, text, { ...options, client }),
  );
}

function attachment(stateDir: string, filename: string, contents: Buffer) {
  const workspaceDir = fs.realpathSync(stateDir);
  const sourcePath = path.join(workspaceDir, filename);
  fs.writeFileSync(sourcePath, contents);
  return { sourcePath, mediaAccess: mediaAccessFor(workspaceDir) };
}

const durableConfig: OpenClawConfig = { channels: { imessage: { accounts: { default: {} } } } };

describe("imessagePlugin contracts", () => {
  it("tells the model to omit redacted current-conversation targets", () => {
    const hints = imessagePlugin.agentPrompt?.messageToolHints?.({ cfg: {}, accountId: "default" });

    expect(hints?.join("\n")).toContain("omit target");
    expect(hints?.join("\n")).toContain("never copy a redacted display value");
  });

  it("rejects unqualified provider identifiers and exposes qualification guidance", async () => {
    const targetResolver = required(imessagePlugin.messaging?.targetResolver);
    const resolveTarget = required(targetResolver.resolveTarget);

    expect(targetResolver.hint).toBe(
      "<phone|email|chat_id:ID|auto:contact|imessage:contact|sms:contact>",
    );

    await expect(
      resolveTarget({ cfg: {}, input: "C0AG22RN7L3", normalized: "+02273" }),
    ).resolves.toBeNull();

    await expect(
      resolveTarget({
        cfg: {},
        input: "auto:Alice Smith",
        normalized: "auto:AliceSmith",
      }),
    ).resolves.toMatchObject({ kind: "user", to: "auto:AliceSmith" });
  });

  it("preserves sanitized HTML formatting as native ranges", () => {
    const text = `<strong title="b>">bold</strong> <del data-note='s>'>strike</del>`;
    const sanitized = imessagePlugin.outbound?.sanitizeText?.({ text, payload: { text } });

    expect(sanitized).toBe("**bold** ~~strike~~");
    expect(extractMarkdownFormatRuns(sanitized ?? "")).toEqual({
      text: "bold strike",
      ranges: [
        { start: 0, length: 4, styles: ["bold"] },
        { start: 5, length: 6, styles: ["strikethrough"] },
      ],
    });
  });

  it("preserves the local approval prompt suppressor through attached-result composition", () => {
    const suppressor = required(imessagePlugin.outbound?.shouldSuppressLocalPayloadPrompt);

    expect(
      suppressor({
        cfg: {
          channels: { imessage: { enabled: true, allowFrom: ["+15551230000"] } },
          approvals: { exec: { enabled: true } },
        },
        accountId: "default",
        payload: {
          text: "Approval required.",
          channelData: {
            execApproval: {
              approvalId: "exec-1",
              approvalSlug: "exec-1",
              approvalKind: "exec",
              sessionKey: "agent:main:imessage:+15551230000",
            },
          },
        },
        hint: { kind: "approval-pending", approvalKind: "exec", nativeRouteActive: true },
      }),
    ).toBe(true);
  });

  it("keeps shared forwarded approvals reaction-resolvable through outbound hooks", async () => {
    const beforeDeliverPayload = required(imessagePlugin.outbound?.beforeDeliverPayload);
    const afterDeliverPayload = required(imessagePlugin.outbound?.afterDeliverPayload);
    const cfg = { channels: { imessage: { enabled: true } } };
    const payload = buildTypedExecApprovalPendingReplyPayload({
      approvalId: "exec-shared-hook",
      approvalSlug: "shared-hook",
      command: "echo shared",
      host: "gateway",
      allowedDecisions: ["allow-once", "deny"],
    });
    const target = { channel: "imessage", to: "+15551230000", accountId: "default" };

    await beforeDeliverPayload({
      cfg,
      target,
      payload,
      hint: { kind: "approval-pending", approvalKind: "exec" },
    });
    expect(payload.text).toContain("👍 Allow Once");
    expect(payload.text).toContain("👎 Deny");

    await afterDeliverPayload({
      cfg,
      target,
      payload,
      results: [
        {
          channel: "imessage",
          messageId: "42",
          meta: {
            imessageMessageGuid: "p:0/shared-hook-guid",
            imessageVisibleText: payload.text,
          },
        },
      ],
    });
    await expect(
      resolveIMessageApprovalReactionTargetWithPersistence({
        accountId: "default",
        conversation: { handle: "+15551230000" },
        messageId: "p:0/shared-hook-guid",
        reactionKey: "👍",
      }),
    ).resolves.toEqual({
      approvalId: "exec-shared-hook",
      approvalKind: "exec",
      decision: "allow-once",
    });
  });

  it("backs declared message adapter capabilities with delivery proofs", async () => {
    const sendIMessage = async (
      _to: string,
      _text: string,
      opts?: { mediaUrl?: string; replyToId?: string; audioAsVoice?: boolean },
    ) => {
      const messageId = opts?.mediaUrl ? "imsg-media-1" : "imsg-text-1";
      return {
        messageId,
        sentText: opts?.mediaUrl ? "<media:image>" : "hello",
        receipt: receipt(
          messageId,
          opts?.audioAsVoice ? "voice" : opts?.mediaUrl ? "media" : "text",
          opts?.replyToId,
        ),
      };
    };
    const adapter = required(imessagePlugin.message);
    const sendText = required(adapter.send?.text);
    const sendMedia = required(adapter.send?.media);
    const context = messageContext(sendIMessage);

    await verifyChannelMessageAdapterCapabilityProofs({
      adapterName: "imessageMessage",
      adapter,
      proofs: {
        text: async () => {
          const result = await sendText({ ...context, text: "hello" });
          expect(result.receipt.platformMessageIds).toEqual(["imsg-text-1"]);
        },
        media: async () => {
          const result = await sendMedia({
            ...context,
            text: "caption",
            mediaUrl: "/tmp/image.png",
            mediaLocalRoots: ["/tmp"],
            audioAsVoice: true,
          });
          expect(result.receipt.platformMessageIds).toEqual(["imsg-media-1"]);
          expect(result.receipt.parts.map((part) => part.kind)).toEqual(["voice"]);
        },
        replyTo: async () => {
          const result = await sendText({ ...context, text: "reply", replyToId: "reply-1" });
          expect(result.receipt.replyToId).toBe("reply-1");
        },
        messageSendingHooks: () => {
          expect(sendText).toBeTypeOf("function");
        },
      },
    });
  });

  it.each(["message", "outbound"] as const)(
    "preserves trusted host media access through the real %s adapter",
    async (adapterKind) => {
      const trustedReader = vi.fn(async () => Buffer.from("trusted"));
      const legacyReader = vi.fn(async () => Buffer.from("legacy"));
      const mediaAccess = {
        localRoots: ["/trusted/workspace"],
        workspaceDir: "/trusted/workspace",
        readFile: trustedReader,
      };
      const sendIMessage = vi.fn(
        async (
          _to: string,
          _text: string,
          _options: { mediaAccess?: typeof mediaAccess; mediaReadFile?: typeof legacyReader },
        ) => ({
          messageId: "p:0/trusted-media",
          receipt: receipt("p:0/trusted-media", "media"),
        }),
      );
      const context = {
        ...messageContext(sendIMessage),
        text: "caption",
        mediaUrl: "workspace-image.png",
        mediaAccess,
        mediaLocalRoots: ["/untrusted/legacy"],
        mediaReadFile: legacyReader,
      };

      const sendMedia = required(
        adapterKind === "message"
          ? imessagePlugin.message?.send?.media
          : imessagePlugin.outbound?.sendMedia,
      );
      await sendMedia(context);

      const forwarded = sendIMessage.mock.calls[0]?.[2];
      expect(forwarded?.mediaAccess).toBe(mediaAccess);
      expect(forwarded?.mediaReadFile).toBe(legacyReader);
      expect(forwarded).toMatchObject({ mediaLocalRoots: ["/untrusted/legacy"] });
    },
  );

  it("rejects a host media reader without explicit approved roots", async () => {
    const readFile = vi.fn(async () => IMESSAGE_WORKSPACE_PNG);
    const sendMedia = required(imessagePlugin.message?.send?.media);
    const nativeSend = vi.fn(sendMessageIMessage);

    await expect(
      sendMedia({
        ...messageContext(nativeSend),
        mediaUrl: "workspace-image.png",
        mediaAccess: { workspaceDir: "/trusted/workspace", readFile },
      }),
    ).rejects.toThrow("Host media read requires explicit localRoots");

    expect(readFile).not.toHaveBeenCalled();
  });

  it.each<[string, string, Buffer, number]>([
    ["workspace traversal despite wider legacy roots", "../outside.png", IMESSAGE_WORKSPACE_PNG, 0],
    ["private log document", "debug.log", Buffer.from("private operator logs"), 1],
    ["HTML before the host reader", "report.html", Buffer.from("<html>untrusted</html>"), 0],
    ["plain text disguised as a PDF", "report.pdf", Buffer.from("not a PDF"), 1],
    ["binary data disguised as plain text", "report.txt", Buffer.from([0x50, 0x4b, 0x03, 0x04]), 1],
  ])(
    "rejects %s before native iMessage delivery",
    async (_name, filename, contents, readerCalls) => {
      await withStateDirEnv("openclaw-imessage-media-policy-", async ({ stateDir }) => {
        const stateRoot = fs.realpathSync(stateDir);
        const workspaceDir = path.join(stateRoot, "workspace");
        fs.mkdirSync(workspaceDir);
        fs.writeFileSync(path.resolve(workspaceDir, filename), contents);
        const mediaAccess = mediaAccessFor(workspaceDir);
        const conflictingReader = vi.fn(async () => Buffer.from("conflicting reader"));
        const runCliJson = mockCliSend().mockResolvedValue({ messageId: "must-not-send" });
        const sendMedia = required(imessagePlugin.message?.send?.media);

        await expect(
          sendMedia({
            ...messageContext(sendMessageIMessage),
            mediaUrl: filename,
            mediaAccess,
            mediaLocalRoots: [stateRoot],
            mediaReadFile: conflictingReader,
          }),
        ).rejects.toMatchObject({ code: "path-not-allowed" });

        expect(mediaAccess.readFile).toHaveBeenCalledTimes(readerCalls);
        expect(conflictingReader).not.toHaveBeenCalled();
        expect(runCliJson).not.toHaveBeenCalled();
      });
    },
  );

  it("carries the stable iMessage GUID beside the broad adapter delivery identity", async () => {
    const sendText = required(imessagePlugin.message?.send?.text);
    const sendIMessage = async () => ({
      messageId: "42",
      guid: "p:0/stable-guid",
      sentText: "hello",
      receipt: receipt("42"),
    });

    const result = await sendText({ ...messageContext(sendIMessage), text: "hello" });

    expect(result.messageId).toBe("42");
    expect(result.receipt.primaryPlatformMessageId).toBe("42");
    expect((result as typeof result & { meta?: Record<string, unknown> }).meta).toEqual({
      imessageMessageGuid: "p:0/stable-guid",
      imessageVisibleText: "hello",
    });
  });

  describe("durable attachments", () => {
    beforeEach(() => {
      setActivePluginRegistry(
        createTestRegistry([{ pluginId: "imessage", plugin: imessagePlugin, source: "test" }]),
      );
    });
    afterEach(resetPluginRuntimeStateForTest);

    it("preserves provider-accepted attachment progress through actual durable core without replay", async () => {
      const captionError = new Error("caption failed after native attachment acceptance");
      const nativeSend = nativeSender(async () => {
        throw captionError;
      });
      const bytes = IMESSAGE_WORKSPACE_PNG;
      const runCliJson = mockCliSend().mockImplementation(async (args) => {
        const attachmentPath = args[args.indexOf("--file") + 1];
        expect(attachmentPath).toBeDefined();
        expect(fs.readFileSync(attachmentPath!)).toEqual(bytes);
        return { messageId: "p:0/durable-accepted-attachment" };
      });
      const onDeliveryResult = vi.fn();

      await withStateDirEnv("openclaw-imessage-durable-attachment-", async ({ stateDir }) => {
        const { sourcePath, mediaAccess } = attachment(stateDir, "workspace-image.png", bytes);
        const { readFile } = mediaAccess;
        const result = await sendDurableMessageBatch({
          cfg: durableConfig,
          channel: "imessage",
          to: "+15550004567",
          durability: "required",
          mediaAccess,
          deps: { imessage: nativeSend },
          onDeliveryResult,
          payloads: [{ text: "undelivered caption", mediaUrl: path.basename(sourcePath) }],
        });

        expect(result).toMatchObject({
          status: "partial_failed",
          sentBeforeError: true,
          receipt: { platformMessageIds: ["p:0/durable-accepted-attachment"] },
          results: [delivery("p:0/durable-accepted-attachment")],
          payloadOutcomes: [{ status: "failed", sentBeforeError: true }],
        });
        expect(onDeliveryResult).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining(delivery("p:0/durable-accepted-attachment")),
        );
        expect(readFile.mock.calls).toEqual([[sourcePath], [sourcePath]]);
        const forwardedMediaAccess = nativeSend.mock.calls[0]?.[2]?.mediaAccess;
        expect(forwardedMediaAccess).toEqual(mediaAccess);
        expect(forwardedMediaAccess?.readFile).toBe(readFile);

        await drainPendingDeliveries({
          drainKey: "imessage:default",
          logLabel: "iMessage accepted attachment recovery",
          cfg: durableConfig,
          stateDir,
          log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
          selectEntry: (entry) => ({ match: entry.channel === "imessage" }),
        });
        expect(runCliJson).toHaveBeenCalledTimes(1);
      });
    });

    it("halts native caption delivery when actual durable progress custody rejects", async () => {
      const custodyError = new Error("durable accepted-attachment custody rejected");
      const captionRequest = vi.fn(async () => ({ guid: "p:0/caption-must-not-send" }));
      const nativeSend = nativeSender(captionRequest);
      const bytes = Buffer.from("%PDF-1.4\n% actual durable custody failure\n");
      const runCliJson = mockCliSend().mockResolvedValue({
        messageId: "p:0/durable-custody-attachment",
      });
      const onDeliveryResult = vi.fn(async () => {
        throw custodyError;
      });

      await withStateDirEnv("openclaw-imessage-durable-custody-", async ({ stateDir }) => {
        const { sourcePath, mediaAccess } = attachment(stateDir, "custody-report.pdf", bytes);
        const result = await sendDurableMessageBatch({
          cfg: durableConfig,
          channel: "imessage",
          to: "+15550004567",
          durability: "required",
          mediaAccess,
          deps: { imessage: nativeSend },
          onDeliveryResult,
          payloads: [{ text: "caption must not send", mediaUrl: sourcePath }],
        });

        expect(result).toMatchObject({
          status: "partial_failed",
          sentBeforeError: true,
          results: [delivery("p:0/durable-custody-attachment")],
        });
        expect(onDeliveryResult).toHaveBeenCalledOnce();
        expect(runCliJson).toHaveBeenCalledOnce();
        expect(mediaAccess.readFile.mock.calls).toEqual([[sourcePath], [sourcePath]]);
        expect(captionRequest).not.toHaveBeenCalled();
      });
    });
  });
});
