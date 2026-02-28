import { getSynologyChatRuntime } from "./runtime.js";
import { sendMessageSynologyChat } from "./send.js";
import type {
  CoreConfig,
  ResolvedSynologyChatAccount,
  SynologyChatInboundMessage,
} from "./types.js";

type HandleInboundParams = {
  message: SynologyChatInboundMessage;
  account: ResolvedSynologyChatAccount;
  config: CoreConfig;
};

/**
 * Handles an incoming message from Synology Chat webhook.
 */
export async function handleSynologyChatInbound(params: HandleInboundParams): Promise<void> {
  const { message, account, config } = params;
  const runtime = getSynologyChatRuntime();

  // Skip empty messages
  if (!message.text?.trim()) {
    return;
  }

  // Record inbound activity
  runtime.channel.activity.record({
    channel: "synology-chat",
    accountId: account.accountId,
    direction: "inbound",
  });

  // Check DM policy
  if (account.dmPolicy === "disabled") {
    console.log(`[synology-chat] DM from ${message.senderId} ignored (dmPolicy: disabled)`);
    return;
  }

  // Check allowlist
  if (account.dmPolicy === "allowlist" && account.allowFrom.length > 0) {
    if (!account.allowFrom.includes(message.senderId)) {
      console.log(`[synology-chat] DM from ${message.senderId} blocked (not in allowlist)`);
      return;
    }
  }

  // Check pairing status
  if (account.dmPolicy === "pairing") {
    const pairingState = runtime.channel.pairing.getPairingState({
      channel: "synology-chat",
      accountId: account.accountId,
      senderId: message.senderId,
    });

    if (!pairingState.paired) {
      // Handle pairing flow
      await handlePairingFlow({
        message,
        account,
        config,
        pairingState,
      });
      return;
    }
  }

  // Process message with AI
  await processWithAI({ message, account, config });
}

/**
 * Handles the pairing flow for new users.
 */
async function handlePairingFlow(params: {
  message: SynologyChatInboundMessage;
  account: ResolvedSynologyChatAccount;
  config: CoreConfig;
  pairingState: { paired: boolean; pending?: boolean };
}): Promise<void> {
  const { message, account, pairingState } = params;
  const runtime = getSynologyChatRuntime();

  // Check if user is pending confirmation
  if (pairingState.pending) {
    const text = message.text.trim().toLowerCase();

    if (text === "yes" || text === "confirm" || text === "ok") {
      // Confirm pairing
      runtime.channel.pairing.confirmPairing({
        channel: "synology-chat",
        accountId: account.accountId,
        senderId: message.senderId,
      });

      await sendMessageSynologyChat("Pairing confirmed! You can now chat with me.", {
        accountId: account.accountId,
      });
      return;
    }

    if (text === "no" || text === "cancel") {
      // Cancel pairing
      runtime.channel.pairing.cancelPairing({
        channel: "synology-chat",
        accountId: account.accountId,
        senderId: message.senderId,
      });

      await sendMessageSynologyChat("Pairing cancelled.", {
        accountId: account.accountId,
      });
      return;
    }

    // Still pending, remind user
    await sendMessageSynologyChat(
      "Please reply with 'yes' to confirm pairing, or 'no' to cancel.",
      { accountId: account.accountId },
    );
    return;
  }

  // Start new pairing request
  runtime.channel.pairing.startPairing({
    channel: "synology-chat",
    accountId: account.accountId,
    senderId: message.senderId,
    senderName: message.senderName,
  });

  await sendMessageSynologyChat(
    `Hello ${message.senderName}! I'm an AI assistant.\n\nTo chat with me, please reply with "yes" to confirm pairing.`,
    { accountId: account.accountId },
  );
}

/**
 * Processes a message with the AI agent.
 */
async function processWithAI(params: {
  message: SynologyChatInboundMessage;
  account: ResolvedSynologyChatAccount;
  config: CoreConfig;
}): Promise<void> {
  const { message, account } = params;
  const runtime = getSynologyChatRuntime();

  try {
    // Build conversation context
    const history = await getConversationHistory({
      senderId: message.senderId,
      account,
    });

    // Call AI agent
    const response = await runtime.agent.chat({
      channel: "synology-chat",
      accountId: account.accountId,
      conversationId: message.senderId,
      senderId: message.senderId,
      senderName: message.senderName,
      text: message.text,
      history,
    });

    // Send response
    if (response.text?.trim()) {
      await sendMessageSynologyChat(response.text, {
        accountId: account.accountId,
      });
    }
  } catch (err) {
    console.error("[synology-chat] Error processing message:", err);
    await sendMessageSynologyChat("Sorry, I encountered an error processing your message.", {
      accountId: account.accountId,
    });
  }
}

/**
 * Retrieves conversation history for context.
 */
async function getConversationHistory(params: {
  senderId: string;
  account: ResolvedSynologyChatAccount;
}): Promise<Array<{ role: "user" | "assistant"; content: string }>> {
  const { senderId, account } = params;
  const runtime = getSynologyChatRuntime();

  const historyLimit = account.dmHistoryLimit;
  if (historyLimit <= 0) {
    return [];
  }

  const history = await runtime.channel.history.getHistory({
    channel: "synology-chat",
    accountId: account.accountId,
    conversationId: senderId,
    limit: historyLimit,
  });

  return history.map((msg) => ({
    role: msg.direction === "inbound" ? "user" : "assistant",
    content: msg.text,
  }));
}
