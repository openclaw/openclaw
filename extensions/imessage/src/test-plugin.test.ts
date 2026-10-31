import fs from "node:fs";
import path from "node:path";
import { buildTypedExecApprovalPendingReplyPayload } from "openclaw/plugin-sdk/approval-reply-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { withStateDirEnv } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IMessageRpcClient } from "./client.js";

let createMessageReceiptFromOutboundResults: typeof import("openclaw/plugin-sdk/channel-outbound").createMessageReceiptFromOutboundResults;
let sendDurableMessageBatch: typeof import("openclaw/plugin-sdk/channel-outbound").sendDurableMessageBatch;
let createTestRegistry: typeof import("openclaw/plugin-sdk/channel-test-helpers").createTestRegistry;
let resetPluginRuntimeStateForTest: typeof import("openclaw/plugin-sdk/channel-test-helpers").resetPluginRuntimeStateForTest;
let setActivePluginRegistry: typeof import("openclaw/plugin-sdk/channel-test-helpers").setActivePluginRegistry;
let drainPendingDeliveries: typeof import("openclaw/plugin-sdk/delivery-queue-runtime").drainPendingDeliveries;
let resolveIMessageApprovalReactionTargetWithPersistence: typeof import("./approval-reactions.js").resolveIMessageApprovalReactionTargetWithPersistence;
let imessagePlugin: typeof import("./channel.js").imessagePlugin;
let cliOutput: typeof import("./cli-output.js");
let sendMessageIMessage: typeof import("./send.js").sendMessageIMessage;

beforeEach(async () => {
  vi.resetModules();
  ({ createMessageReceiptFromOutboundResults, sendDurableMessageBatch } =
    await import("openclaw/plugin-sdk/channel-outbound"));
  ({ createTestRegistry, resetPluginRuntimeStateForTest, setActivePluginRegistry } =
    await import("openclaw/plugin-sdk/channel-test-helpers"));
  ({ drainPendingDeliveries } = await import("openclaw/plugin-sdk/delivery-queue-runtime"));
  ({ resolveIMessageApprovalReactionTargetWithPersistence } =
    await import("./approval-reactions.js"));
  ({ imessagePlugin } = await import("./channel.js"));
  cliOutput = await import("./cli-output.js");
  ({ sendMessageIMessage } = await import("./send.js"));
});

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

  it("suppresses local prompts and keeps forwarded approvals reaction-resolvable through outbound hooks", async () => {
    const beforeDeliverPayload = required(imessagePlugin.outbound?.beforeDeliverPayload);
    const afterDeliverPayload = required(imessagePlugin.outbound?.afterDeliverPayload);
    const cfg = { channels: { imessage: { enabled: true } } };
    const payload = buildTypedExecApprovalPendingReplyPayload({
      approvalId: "exec-shared-hook",
      approvalSlug: "shared-hook",
      command: "echo shared",
      host: "gateway",
      allowedDecisions: ["allow-once", "deny"],
      sessionKey: "agent:main:imessage:+15551230000",
    });
    const target = { channel: "imessage", to: "+15551230000", accountId: "default" };
    expect(
      required(imessagePlugin.outbound?.shouldSuppressLocalPayloadPrompt)({
        cfg: {
          channels: { imessage: { enabled: true, allowFrom: [target.to] } },
          approvals: { exec: { enabled: true } },
        },
        accountId: "default",
        payload,
        hint: { kind: "approval-pending", approvalKind: "exec", nativeRouteActive: true },
      }),
    ).toBe(true);

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
          _options: {
            mediaAccess?: typeof mediaAccess;
            mediaReadFile?: typeof legacyReader;
            audioAsVoice?: boolean;
          },
        ) => ({
          messageId: "p:0/trusted-media",
          receipt: receipt("p:0/trusted-media", _options.audioAsVoice ? "voice" : "media"),
        }),
      );
      const context = {
        ...messageContext(sendIMessage),
        text: "caption",
        mediaUrl: "workspace-image.png",
        mediaAccess,
        mediaLocalRoots: ["/untrusted/legacy"],
        mediaReadFile: legacyReader,
        audioAsVoice: true,
      };

      const sendMedia = required(
        adapterKind === "message"
          ? imessagePlugin.message?.send?.media
          : imessagePlugin.outbound?.sendMedia,
      );
      const result = await sendMedia(context);
      expect(result.receipt?.platformMessageIds).toEqual(["p:0/trusted-media"]);
      expect(result.receipt?.parts.map((part) => part.kind)).toEqual(["voice"]);

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
    const sendIMessage = async (_to: string, _text: string, options?: { replyToId?: string }) => ({
      messageId: "42",
      guid: "p:0/stable-guid",
      sentText: "hello",
      receipt: receipt("42", "text", options?.replyToId),
    });

    const result = await sendText({
      ...messageContext(sendIMessage),
      text: "hello",
      replyToId: "reply-1",
    });

    expect(result.messageId).toBe("42");
    expect(result.receipt.primaryPlatformMessageId).toBe("42");
    expect(result.receipt.platformMessageIds).toEqual(["42"]);
    expect(result.receipt.replyToId).toBe("reply-1");
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
    afterEach(() => resetPluginRuntimeStateForTest());

    it.each(["caption", "custody"] as const)(
      "preserves accepted attachment progress when %s fails",
      async (phase) => {
        const failure = new Error(phase + " failed after native attachment acceptance");
        const captionRequest = vi.fn(async () => {
          if (phase === "caption") {
            throw failure;
          }
          return { guid: "caption-must-not-send" };
        });
        const nativeSend = nativeSender(captionRequest);
        const messageId = "p:0/durable-accepted-attachment";
        const bytes =
          phase === "caption" ? IMESSAGE_WORKSPACE_PNG : Buffer.from("%PDF-1.4\nsynthetic\n");
        const runCliJson = mockCliSend().mockImplementation(async (args) => {
          const attachmentPath = args[args.indexOf("--file") + 1];
          expect(attachmentPath).toBeDefined();
          expect(fs.readFileSync(attachmentPath!)).toEqual(bytes);
          return { messageId };
        });
        const onDeliveryResult = vi.fn(async () => {
          if (phase === "custody") {
            throw failure;
          }
        });

        await withStateDirEnv("openclaw-imessage-durable-", async ({ stateDir }) => {
          const { sourcePath, mediaAccess } = attachment(
            stateDir,
            phase === "caption" ? "workspace-image.png" : "custody-report.pdf",
            bytes,
          );
          const result = await sendDurableMessageBatch({
            cfg: durableConfig,
            channel: "imessage",
            to: "+15550004567",
            durability: "required",
            mediaAccess,
            deps: { imessage: nativeSend },
            onDeliveryResult,
            payloads: [
              {
                text: "undelivered caption",
                mediaUrl: phase === "caption" ? path.basename(sourcePath) : sourcePath,
              },
            ],
          });
          expect(result).toMatchObject({
            status: "partial_failed",
            sentBeforeError: true,
            results: [delivery(messageId)],
          });
          expect(onDeliveryResult).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining(delivery(messageId)),
          );
          if (phase === "custody") {
            expect(captionRequest).not.toHaveBeenCalled();
          } else {
            expect(result).toMatchObject({
              receipt: { platformMessageIds: [messageId] },
              payloadOutcomes: [{ status: "failed", sentBeforeError: true }],
            });
            await drainPendingDeliveries({
              drainKey: "imessage:default",
              logLabel: "iMessage accepted attachment recovery",
              cfg: durableConfig,
              stateDir,
              log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
              selectEntry: (entry) => ({ match: entry.channel === "imessage" }),
            });
          }
          expect(runCliJson).toHaveBeenCalledOnce();
        });
      },
    );
  });
});
