import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Agent, createSigner, createUser } from "@xmtp/agent-sdk";
import { getXmtpRuntime } from "./runtime.js";

export interface XmtpBusOptions {
  accountId?: string;
  walletKey: string;
  dbEncryptionKey: string;
  env: "local" | "dev" | "production";
  dbPath?: string;
  shouldAutoConsent?: (senderAddress: string) => boolean;
  onMessage: (params: {
    senderAddress: string;
    senderInboxId: string;
    conversationId: string;
    isDm: boolean;
    text: string;
    messageId: string;
  }) => Promise<void>;
  onError?: (error: Error, context: string) => void;
  onConnect?: () => void;
}

export interface XmtpBusHandle {
  sendText(target: string, text: string): Promise<void>;
  getAddress(): string;
  close(): Promise<void>;
}

type XmtpConversationHandle = {
  sendText: (text: string) => Promise<unknown>;
};

type XmtpAgentHandle = Awaited<ReturnType<typeof Agent.create>>;

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

export async function startXmtpBus(options: XmtpBusOptions): Promise<XmtpBusHandle> {
  const {
    walletKey,
    dbEncryptionKey,
    env,
    dbPath: configDbPath,
    shouldAutoConsent,
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
      if (ctx.isDM(ctx.conversation)) {
        if (!shouldAutoConsent) {
          ctx.conversation.updateConsentState("allowed");
        } else {
          const senderAddress = await (ctx as { getSenderAddress?: () => Promise<string | null> }).getSenderAddress?.();
          if (senderAddress && shouldAutoConsent(senderAddress.toLowerCase())) {
            ctx.conversation.updateConsentState("allowed");
          }
        }
      }
    } catch (err) {
      onError?.(err as Error, "auto-consent conversation");
    }
  });

  agent.on("text", async (ctx) => {
    try {
      const senderAddressRaw = await ctx.getSenderAddress();
      if (!senderAddressRaw) {
        throw new Error("XMTP message missing sender address");
      }
      const senderAddress = senderAddressRaw.toLowerCase();
      const senderInboxId = ctx.message.senderInboxId;
      const conversationId = ctx.conversation.id;
      const isDm = ctx.isDm();
      const text = ctx.message.content as string;
      const messageId = ctx.message.id;

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
