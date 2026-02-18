import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Agent, createSigner, createUser } from "@xmtp/agent-sdk";
import { getXmtpRuntime } from "./runtime.js";

export type XmtpReplyContext = {
  referenceId: string;
  referencedText?: string;
};

export interface XmtpBusOptions {
  accountId?: string;
  walletKey: string;
  dbEncryptionKey: string;
  env: "local" | "dev" | "production";
  dbPath?: string;
  // Default to auto-consenting DMs so pairing flows can proceed.
  shouldConsentDm: (senderAddress: string) => boolean;
  onMessage: (params: {
    senderAddress: string;
    senderInboxId: string;
    conversationId: string;
    isDm: boolean;
    text: string;
    messageId: string;
    replyContext?: XmtpReplyContext;
  }) => Promise<void>;
  onError?: (error: Error, context: string) => void;
  onConnect?: () => void;
}

export interface XmtpBusHandle {
  sendText(target: string, text: string): Promise<void>;
  sendReply(target: string, text: string, referenceMessageId: string): Promise<void>;
  getAddress(): string;
  close(): Promise<void>;
}

type XmtpConversationHandle = {
  sendText: (text: string) => Promise<unknown>;
  sendReply?: (reply: unknown) => Promise<unknown>;
};

type XmtpAgentHandle = Awaited<ReturnType<typeof Agent.create>>;

type XmtpInboundMessageContext = {
  getSenderAddress: () => Promise<string | null>;
  message: {
    senderInboxId: string;
    content: unknown;
    id: string;
  };
  conversation: {
    id: string;
  };
  isDm: () => boolean;
};

function looksLikeEthAddress(value: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(value.trim());
}

async function resolveConversationForTarget(
  agent: XmtpAgentHandle,
  target: string,
): Promise<XmtpConversationHandle> {
  const trimmedTarget = target.trim();
  if (!trimmedTarget) {
    throw new Error("Target is required");
  }

  if (looksLikeEthAddress(trimmedTarget)) {
    const normalizedAddress = normalizeEthAddress(trimmedTarget);
    const agentWithAddressDm = agent as XmtpAgentHandle & {
      createDmWithAddress?: (address: string) => Promise<XmtpConversationHandle | null>;
    };
    if (typeof agentWithAddressDm.createDmWithAddress === "function") {
      const dmConversation = await agentWithAddressDm.createDmWithAddress(normalizedAddress);
      if (dmConversation) {
        return dmConversation;
      }
      throw new Error(`Conversation not found for address: ${normalizedAddress}`);
    }

    const conversationsWithAddressDm = agent.client.conversations as {
      createDmWithAddress?: (address: string) => Promise<XmtpConversationHandle | null>;
    };
    if (typeof conversationsWithAddressDm.createDmWithAddress === "function") {
      const dmConversation =
        await conversationsWithAddressDm.createDmWithAddress(normalizedAddress);
      if (dmConversation) {
        return dmConversation;
      }
      throw new Error(`Conversation not found for address: ${normalizedAddress}`);
    }

    throw new Error("XMTP SDK does not support address-based DM creation");
  }

  const conversation = await agent.client.conversations.getConversationById(trimmedTarget);
  if (!conversation) {
    throw new Error(`Conversation not found: ${trimmedTarget}`);
  }
  return conversation as XmtpConversationHandle;
}

function resolveDbDirectory(env: string, configDbPath?: string): string {
  if (configDbPath) {
    const resolved = configDbPath.replace(/^~/, os.homedir());
    fs.mkdirSync(resolved, { recursive: true, mode: 0o700 });
    return resolved;
  }

  const runtime = getXmtpRuntime();
  const stateDir = runtime.state.resolveStateDir(process.env, os.homedir);
  const dbDir = path.join(stateDir, "channels", "xmtp", env);
  fs.mkdirSync(dbDir, { recursive: true, mode: 0o700 });
  return dbDir;
}

function extractTextFromMessageContent(content: unknown): string | undefined {
  if (typeof content === "string") {
    return content;
  }
  if (content && typeof content === "object") {
    const nestedContent = (content as { content?: unknown }).content;
    if (typeof nestedContent === "string") {
      return nestedContent;
    }
  }
  return undefined;
}

function extractReplyContext(content: unknown): XmtpReplyContext | undefined {
  if (!content || typeof content !== "object") {
    return undefined;
  }

  const referenceIdRaw = (content as { referenceId?: unknown }).referenceId;
  if (typeof referenceIdRaw !== "string" || !referenceIdRaw.trim()) {
    return undefined;
  }

  const inReplyTo = (content as { inReplyTo?: unknown }).inReplyTo;
  const referencedText = extractTextFromMessageContent(inReplyTo);

  return {
    referenceId: referenceIdRaw,
    ...(referencedText ? { referencedText } : {}),
  };
}

export async function startXmtpBus(options: XmtpBusOptions): Promise<XmtpBusHandle> {
  const {
    walletKey,
    dbEncryptionKey,
    env,
    dbPath: configDbPath,
    shouldConsentDm = () => true,
    onMessage,
    onError,
    onConnect,
  } = options;

  const dbDir = resolveDbDirectory(env, configDbPath);
  const user = createUser(walletKey as `0x${string}`);
  const signer = createSigner(user);

  const normalizedEncryptionKey = dbEncryptionKey.startsWith("0x")
    ? dbEncryptionKey
    : `0x${dbEncryptionKey}`;

  const agent = await Agent.create(signer, {
    env,
    dbEncryptionKey: normalizedEncryptionKey as `0x${string}`,
    dbPath: (inboxId: string) => path.join(dbDir, `xmtp-${inboxId}.db3`),
  });

  const agentAddress = agent.address ?? user.account.address.toLowerCase();

  agent.on("conversation", async (ctx) => {
    try {
      if (ctx.isDm()) {
        const senderAddress = await (
          ctx as { getSenderAddress?: () => Promise<string | null> }
        ).getSenderAddress?.();
        type ConsentState = Parameters<NonNullable<typeof ctx.conversation.updateConsentState>>[0];
        const conversation = ctx.conversation as unknown as {
          updateConsentState: (state: ConsentState) => void;
        };
        if (!senderAddress) {
          conversation.updateConsentState("allowed" as unknown as ConsentState);
          return;
        }
        if (shouldConsentDm(senderAddress.toLowerCase())) {
          conversation.updateConsentState("allowed" as unknown as ConsentState);
        }
      }
    } catch (err) {
      onError?.(err as Error, "auto-consent conversation");
    }
  });

  agent.on("text", async (ctx) => {
    try {
      const typedCtx = ctx as XmtpInboundMessageContext;
      const senderAddressRaw = await typedCtx.getSenderAddress();
      if (!senderAddressRaw) {
        throw new Error("XMTP message missing sender address");
      }
      const senderAddress = senderAddressRaw.toLowerCase();
      const senderInboxId = typedCtx.message.senderInboxId;
      const conversationId = typedCtx.conversation.id;
      const isDm = typedCtx.isDm();
      const text = typedCtx.message.content as string;
      const messageId = typedCtx.message.id;

      if (!isDm) return;

      await onMessage({
        senderAddress,
        senderInboxId,
        conversationId,
        isDm,
        text,
        messageId,
      });
    } catch (err) {
      onError?.(err as Error, "handle text message");
    }
  });

  (
    agent as {
      on: (event: string, handler: (ctx: unknown) => Promise<void>) => void;
    }
  ).on("reply", async (ctx) => {
    try {
      const typedCtx = ctx as XmtpInboundMessageContext;
      const senderAddressRaw = await typedCtx.getSenderAddress();
      if (!senderAddressRaw) {
        throw new Error("XMTP message missing sender address");
      }
      const senderAddress = senderAddressRaw.toLowerCase();
      const senderInboxId = typedCtx.message.senderInboxId;
      const conversationId = typedCtx.conversation.id;
      const isDm = typedCtx.isDm();
      const messageId = typedCtx.message.id;
      const replyContent = typedCtx.message.content;
      const text = extractTextFromMessageContent(replyContent);

      if (!isDm) return;
      if (!text?.trim()) {
        return;
      }

      await onMessage({
        senderAddress,
        senderInboxId,
        conversationId,
        isDm,
        text,
        messageId,
        replyContext: extractReplyContext(replyContent),
      });
    } catch (err) {
      onError?.(err as Error, "handle reply message");
    }
  });

  agent.on("unhandledError", (error) => {
    onError?.(error, "unhandled agent error");
  });

  await agent.start();
  onConnect?.();

  return {
    async sendText(target: string, text: string): Promise<void> {
      const conversation = await resolveConversationForTarget(agent, target);
      await conversation.sendText(text);
    },

    async sendReply(target: string, text: string, referenceMessageId: string): Promise<void> {
      const trimmedReferenceMessageId = referenceMessageId.trim();
      if (!trimmedReferenceMessageId) {
        throw new Error("referenceMessageId is required");
      }

      const conversation = await resolveConversationForTarget(agent, target);
      if (typeof conversation.sendReply === "function") {
        await conversation.sendReply({
          content: text,
          referenceId: trimmedReferenceMessageId,
        });
        return;
      }

      await conversation.sendText(text);
    },

    getAddress(): string {
      return agentAddress;
    },

    async close(): Promise<void> {
      await agent.stop();
    },
  };
}

export function normalizeEthAddress(input: string): string {
  const trimmed = input.trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(trimmed)) {
    throw new Error("Invalid Ethereum address: must be 0x-prefixed 40 hex chars");
  }
  return trimmed;
}
