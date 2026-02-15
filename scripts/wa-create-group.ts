/**
 * Create a WhatsApp group using Baileys directly
 * Usage: npx tsx scripts/wa-create-group.ts "Group Name" "+phone1" "+phone2" ...
 */

import {
  makeWASocket,
  useMultiFileAuthState,
  makeCacheableSignalKeyStore,
  fetchLatestBaileysVersion,
} from "@whiskeysockets/baileys";
import pino from "pino";
import path from "node:path";
import os from "node:os";

const AUTH_DIR = path.join(os.homedir(), ".openclaw/credentials/whatsapp/default");

async function main() {
  const args = process.argv.slice(2);
  
  if (args.length < 2) {
    console.error("Usage: npx tsx scripts/wa-create-group.ts \"Group Name\" \"+phone1\" \"+phone2\" ...");
    process.exit(1);
  }
  
  const [name, ...rawParticipants] = args;
  
  // Convert phone numbers to WhatsApp JIDs
  const participants = rawParticipants.map(p => {
    const cleaned = p.replace(/[^0-9]/g, "");
    return `${cleaned}@s.whatsapp.net`;
  });
  
  console.log(`🔌 Connecting to WhatsApp...`);
  
  const logger = pino({ level: "silent" });
  const { state } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();
  
  const sock = makeWASocket({
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    version,
    logger,
    printQRInTerminal: false,
    browser: ["OpenClaw Group Creator", "Chrome", "1.0.0"],
    markOnlineOnConnect: false,
  });

  await new Promise<void>((resolve, reject) => {
    sock.ev.on("connection.update", (update) => {
      if (update.connection === "open") resolve();
      if (update.connection === "close") reject(new Error("Connection closed"));
    });
    setTimeout(() => reject(new Error("Connection timeout")), 30000);
  });

  console.log(`✅ Connected!`);
  console.log(`📱 Creating group "${name}" with ${participants.length} participants...`);
  
  try {
    const result = await sock.groupCreate(name, participants);
    console.log(`\n✅ Group created!`);
    console.log(`   ID: ${result.id}`);
    console.log(`   Name: ${result.subject}`);
    console.log(`   Created: ${new Date(result.creation * 1000).toISOString()}`);
  } catch (err) {
    console.error(`\n❌ Failed to create group:`, (err as Error).message);
    throw err;
  } finally {
    sock.ws?.close();
    process.exit(0);
  }
}

main().catch(err => {
  console.error("Fatal:", err);
  process.exit(1);
});
