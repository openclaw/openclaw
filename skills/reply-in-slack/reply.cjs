#!/usr/bin/env node
const { message } = require("@openclaw/tool-runtime");
const { getInboundContext } = require("@openclaw/runtime-sdk");

async function main() {
  const text = process.argv.slice(2).join(" ");
  if (!text) {
    console.error("Usage: reply.js <message>");
    process.exit(1);
  }

  const context = await getInboundContext();
  const channelId = context.chat_id;
  const threadTs = context.reply_to_id || context.message_id;

  if (!channelId || !threadTs) {
    console.error("Could not determine channel or thread from context.");
    process.exit(1);
  }

  try {
    await message({
      action: "send",
      channel: channelId,
      message: text,
      replyTo: threadTs,
    });
  } catch (e) {
    console.error("Failed to send reply:", e);
    process.exit(1);
  }
}

main();
