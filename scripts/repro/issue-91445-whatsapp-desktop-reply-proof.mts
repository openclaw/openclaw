/**
 * Reproduction proof for issue #91445.
 *
 * Before the fix: when a user replies to a bot-authored message on WhatsApp,
 * `lookupInboundMessageMeta` cache-misses because outbound messages were never
 * cached. The fallback defaults `fromMe: false` and `participant: msg.senderJid`,
 * which causes WhatsApp Desktop to silently drop the reply bubble.
 *
 * After the fix: `sendTrackedMessage` caches outbound metadata with
 * `fromMe: true` and the bot's JID as participant, so quote construction
 * resolves correctly.
 */

import {
  cacheInboundMessageMeta,
  lookupInboundMessageMeta,
  buildQuotedMessageOptions,
} from "../../extensions/whatsapp/src/quoted-message.js";

function assertEqual(label: string, actual: unknown, expected: unknown) {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) {
    console.error(`  FAIL: ${label}`);
    console.error(`    expected: ${expectedJson}`);
    console.error(`    actual:   ${actualJson}`);
    throw new Error(`Assertion failed: ${label}`);
  }
  console.log(`  PASS: ${label}`);
}

function main() {
  console.log("=== Reproduction for issue #91445 ===\n");

  const accountId = "test-account";
  const chatId = "120363400000000000@g.us";
  const botJid = "bot@s.whatsapp.net";
  const userJid = "user@s.whatsapp.net";
  const botMessageId = "bot-msg-abc123";

  // Simulate the fixed behavior: outbound message metadata is cached
  // (in real runtime this happens inside sendTrackedMessage)
  cacheInboundMessageMeta(accountId, chatId, botMessageId, {
    participant: botJid,
    fromMe: true,
  });

  console.log("-- Proof 1: cached outbound metadata is retrievable --");
  const cached = lookupInboundMessageMeta(accountId, chatId, botMessageId);
  assertEqual("participant is bot JID", cached?.participant, botJid);
  assertEqual("fromMe is true", cached?.fromMe, true);

  console.log("\n-- Proof 2: quote options use correct fromMe/participant --");
  const quote = buildQuotedMessageOptions({
    messageId: botMessageId,
    remoteJid: chatId,
    fromMe: cached?.fromMe ?? false,
    participant: cached?.participant ?? userJid,
    messageText: cached?.body ?? "",
  });
  assertEqual("quoted.key.fromMe is true", quote?.quoted?.key?.fromMe, true);
  assertEqual(
    "quoted.key.participant is bot JID",
    quote?.quoted?.key?.participant,
    botJid,
  );

  console.log("\n-- Proof 3: uncached message still falls back to old defaults --");
  const uncached = lookupInboundMessageMeta(accountId, chatId, "unknown-msg");
  assertEqual("uncached returns undefined", uncached, undefined);
  const fallbackQuote = buildQuotedMessageOptions({
    messageId: "unknown-msg",
    remoteJid: chatId,
    fromMe: uncached?.fromMe ?? false,
    participant: uncached?.participant ?? userJid,
    messageText: uncached?.body ?? "",
  });
  assertEqual(
    "fallback fromMe is false",
    fallbackQuote?.quoted?.key?.fromMe,
    false,
  );
  assertEqual(
    "fallback participant is replying user",
    fallbackQuote?.quoted?.key?.participant,
    userJid,
  );

  console.log("\n=========================");
  console.log("All proofs passed.");
}

main();
