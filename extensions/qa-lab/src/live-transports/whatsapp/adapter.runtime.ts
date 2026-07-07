// Qa Lab plugin module implements WhatsApp live transport adapter behavior.
import fs from "node:fs/promises";
import path from "node:path";
import { startWhatsAppQaDriverSession } from "@openclaw/whatsapp/api.js";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { buildQaTarget } from "openclaw/plugin-sdk/qa-channel";
import type { QaRunnerCliRegistration } from "openclaw/plugin-sdk/qa-runner-runtime";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";
import {
  acquireQaCredentialLease,
  startQaCredentialLeaseHeartbeat,
} from "../shared/credential-lease.runtime.js";
import { __testing as whatsappLive } from "./whatsapp-live.runtime.js";

type AdapterFactory = NonNullable<QaRunnerCliRegistration["adapterFactory"]>;
type FactoryContext = Parameters<AdapterFactory["create"]>[0];
type AdapterDefinition = Awaited<ReturnType<AdapterFactory["create"]>>;
type WhatsAppRuntimeEnv = ReturnType<typeof whatsappLive.resolveWhatsAppQaRuntimeEnv>;

export async function createWhatsAppQaTransportAdapter(
  context: FactoryContext,
): Promise<AdapterDefinition> {
  const options = context.adapterOptions ?? {};
  const lease = await acquireQaCredentialLease<WhatsAppRuntimeEnv>({
    kind: "whatsapp",
    source: options.credentialSource,
    role: options.credentialRole,
    resolveEnvPayload: () => whatsappLive.resolveWhatsAppQaRuntimeEnv(),
    parsePayload: whatsappLive.parseWhatsAppQaCredentialPayload,
  });
  const heartbeat = startQaCredentialLeaseHeartbeat(lease);
  const runtimeEnv = lease.payload;
  let authRoot: string | undefined;
  let driver: Awaited<ReturnType<typeof startWhatsAppQaDriverSession>> | undefined;
  let sutAuthDir: string;
  try {
    authRoot = await fs.mkdtemp(
      path.join(resolvePreferredOpenClawTmpDir(), "openclaw-whatsapp-qa-adapter-"),
    );
    const [driverAuthDir, unpackedSutAuthDir] = await Promise.all([
      whatsappLive.unpackWhatsAppAuthArchive({
        archiveBase64: runtimeEnv.driverAuthArchiveBase64,
        clearSignalSessions: true,
        label: "driver-auth",
        parentDir: authRoot,
      }),
      whatsappLive.unpackWhatsAppAuthArchive({
        archiveBase64: runtimeEnv.sutAuthArchiveBase64,
        clearSignalSessions: true,
        label: "sut-auth",
        parentDir: authRoot,
      }),
    ]);
    sutAuthDir = unpackedSutAuthDir;
    driver = await startWhatsAppQaDriverSession({ authDir: driverAuthDir });
  } catch (error) {
    await driver?.close().catch(() => undefined);
    await heartbeat.stop();
    await lease.release();
    if (authRoot) {
      await fs.rm(authRoot, { force: true, recursive: true });
    }
    throw error;
  }
  const accountId = options.sutAccountId?.trim() || "sut";
  const dmTargets = whatsappLive.resolveWhatsAppQaMessageTargets({
    driverPhoneE164: runtimeEnv.driverPhoneE164,
    scenarioTarget: "dm",
    sutPhoneE164: runtimeEnv.sutPhoneE164,
  });
  let observedCount = driver.getObservedMessages().length;
  let stopped = false;
  let pollingError: Error | undefined;
  let logicalConversationId = dmTargets.gatewayTarget;
  let logicalConversationKind: "direct" | "group" = "direct";
  const nativeMessageIds = new Map<string, string>();
  const busMessageIds = new Map<string, string>();
  const polling = (async () => {
    for (;;) {
      if (stopped) {
        return;
      }
      const messages = driver.getObservedMessages();
      for (const message of messages.slice(observedCount)) {
        observedCount += 1;
        if (message.fromPhoneE164 !== runtimeEnv.sutPhoneE164) {
          continue;
        }
        await context.messages.addOutboundMessage({
          accountId,
          to: buildQaTarget({
            chatType: logicalConversationKind,
            conversationId: logicalConversationId,
          }),
          senderId: message.fromPhoneE164,
          text: message.text,
          timestamp: Date.parse(message.observedAt),
          replyToId: message.quoted?.messageId
            ? busMessageIds.get(message.quoted.messageId)
            : undefined,
        });
      }
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 500);
      });
    }
  })().catch((error: unknown) => {
    if (!stopped) {
      pollingError = error instanceof Error ? error : new Error(String(error));
    }
  });

  return {
    id: "whatsapp",
    label: "WhatsApp live",
    accountId,
    requiredPluginIds: ["whatsapp"],
    supportedActions: [],
    assertTransportHealthy() {
      if (pollingError) {
        throw pollingError;
      }
      heartbeat.throwIfFailed();
    },
    async sendInbound(input) {
      heartbeat.throwIfFailed();
      logicalConversationId = input.conversation.id;
      logicalConversationKind = input.conversation.kind === "direct" ? "direct" : "group";
      const targets = whatsappLive.resolveWhatsAppQaMessageTargets({
        driverPhoneE164: runtimeEnv.driverPhoneE164,
        groupJid: runtimeEnv.groupJid,
        scenarioTarget: logicalConversationKind === "direct" ? "dm" : "group",
        sutPhoneE164: runtimeEnv.sutPhoneE164,
      });
      const quotedMessageId = input.replyToId ? nativeMessageIds.get(input.replyToId) : undefined;
      const sent = await driver.sendText(
        targets.driverTarget,
        input.text,
        quotedMessageId
          ? {
              quotedMessageKey: {
                id: quotedMessageId,
                remoteJid: targets.driverTarget,
                fromMe: true,
              },
            }
          : undefined,
      );
      const message = await context.messages.addInboundMessage({
        ...input,
        accountId,
        senderId: runtimeEnv.driverPhoneE164,
      });
      if (sent.messageId) {
        nativeMessageIds.set(message.id, sent.messageId);
        busMessageIds.set(sent.messageId, message.id);
      }
      return message;
    },
    resetTransport: () => {
      logicalConversationId = dmTargets.gatewayTarget;
      logicalConversationKind = "direct";
      nativeMessageIds.clear();
      busMessageIds.clear();
    },
    createGatewayConfig: () =>
      whatsappLive.buildWhatsAppQaConfig({} as OpenClawConfig, {
        allowFrom: [runtimeEnv.driverPhoneE164],
        authDir: sutAuthDir,
        dmPolicy: "allowlist",
        groupJid: runtimeEnv.groupJid,
        overrides: options.transportPolicy?.topLevelReplies ? { replyToMode: "off" } : undefined,
        sutAccountId: accountId,
      }),
    waitReady: async ({ gateway }) =>
      await whatsappLive.waitForWhatsAppChannelStable(gateway as never, accountId),
    buildAgentDelivery: () => ({
      channel: "whatsapp",
      to: dmTargets.gatewayTarget,
      replyChannel: "whatsapp",
      replyTo: dmTargets.gatewayTarget,
    }),
    async handleAction() {
      throw new Error("WhatsApp live QA adapter does not implement transport actions");
    },
    createReportNotes: () => ["Uses the WhatsApp live adapter."],
    async cleanup() {
      stopped = true;
      await polling.catch(() => undefined);
      await driver.close();
      await heartbeat.stop();
      await lease.release();
      await fs.rm(authRoot, { force: true, recursive: true });
    },
  };
}
