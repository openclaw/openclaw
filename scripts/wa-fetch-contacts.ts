/**
 * Fetch all WhatsApp contacts from groups using Baileys
 * Resolves LIDs to real phone numbers
 * Run with: npx tsx scripts/wa-fetch-contacts.ts
 */

import {
  makeWASocket,
  useMultiFileAuthState,
  makeCacheableSignalKeyStore,
  fetchLatestBaileysVersion,
} from "@whiskeysockets/baileys";
import pino from "pino";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const AUTH_DIR = process.env.WA_AUTH_DIR || path.join(os.homedir(), ".openclaw/credentials/whatsapp/default");
const OUTPUT_PATH = path.join(os.homedir(), ".openclaw/workspace/bank/whatsapp-contacts-full.json");

// Load all LID reverse mappings
function loadLidMappings(): Map<string, string> {
  const mappings = new Map<string, string>();
  const files = fs.readdirSync(AUTH_DIR);
  
  for (const file of files) {
    if (file.startsWith("lid-mapping-") && file.endsWith("_reverse.json")) {
      try {
        const lid = file.replace("lid-mapping-", "").replace("_reverse.json", "");
        const content = fs.readFileSync(path.join(AUTH_DIR, file), "utf-8");
        const phone = JSON.parse(content);
        if (typeof phone === "string") {
          mappings.set(lid, phone);
        }
      } catch {
        // Skip invalid files
      }
    }
  }
  
  console.log(`📋 Loaded ${mappings.size} LID mappings`);
  return mappings;
}

async function main() {
  console.log("🔌 Connecting to WhatsApp...");
  
  const lidMappings = loadLidMappings();
  
  const logger = pino({ level: "silent" });
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();
  
  const sock = makeWASocket({
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    version,
    logger,
    printQRInTerminal: false,
    browser: ["OpenClaw Contact Sync", "Chrome", "1.0.0"],
    markOnlineOnConnect: false,
  });

  // Wait for connection
  await new Promise<void>((resolve, reject) => {
    sock.ev.on("connection.update", (update) => {
      if (update.connection === "open") {
        resolve();
      }
      if (update.connection === "close") {
        reject(new Error("Connection closed"));
      }
    });
    setTimeout(() => reject(new Error("Connection timeout")), 30000);
  });

  console.log("✅ Connected! Fetching all groups...");

  try {
    const groups = await sock.groupFetchAllParticipating();
    
    const contacts: Record<string, { 
      phone: string; 
      lid?: string;
      groups: Array<{ id: string; name: string; isAdmin: boolean }>; 
      isAdmin: boolean 
    }> = {};
    const groupList: Array<{ id: string; subject: string; participantCount: number }> = [];
    let unresolvedLids = 0;
    
    console.log(`📊 Found ${Object.keys(groups).length} groups`);
    
    for (const [jid, meta] of Object.entries(groups)) {
      groupList.push({
        id: jid,
        subject: meta.subject,
        participantCount: meta.participants?.length || 0,
      });
      
      for (const participant of meta.participants || []) {
        let rawId = participant.id?.split("@")[0];
        if (!rawId || rawId.includes(":")) continue;
        
        // Check if this is a LID that needs resolution
        let phone: string;
        let lid: string | undefined;
        
        if (lidMappings.has(rawId)) {
          // This is a LID, resolve to phone
          phone = `+${lidMappings.get(rawId)}`;
          lid = rawId;
        } else if (rawId.length > 15) {
          // Likely an unresolved LID
          unresolvedLids++;
          phone = `LID:${rawId}`;
          lid = rawId;
        } else {
          // Real phone number
          phone = `+${rawId}`;
        }
        
        if (!contacts[phone]) {
          contacts[phone] = {
            phone,
            lid,
            groups: [],
            isAdmin: false,
          };
        }
        
        contacts[phone].groups.push({
          id: jid,
          name: meta.subject,
          isAdmin: participant.admin ? true : false,
        });
        
        if (participant.admin) {
          contacts[phone].isAdmin = true;
        }
      }
    }

    // Sort contacts by number of groups
    const sortedContacts = Object.values(contacts).sort(
      (a, b) => b.groups.length - a.groups.length
    );
    
    // Separate resolved and unresolved
    const resolved = sortedContacts.filter(c => !c.phone.startsWith("LID:"));
    const unresolved = sortedContacts.filter(c => c.phone.startsWith("LID:"));

    const output = {
      extracted: new Date().toISOString(),
      source: "whatsapp-groups",
      selfId: sock.user?.id,
      stats: {
        totalGroups: groupList.length,
        totalContacts: sortedContacts.length,
        resolvedContacts: resolved.length,
        unresolvedLids: unresolved.length,
      },
      groups: groupList.sort((a, b) => b.participantCount - a.participantCount),
      contacts: resolved,
      unresolvedContacts: unresolved.length > 0 ? unresolved : undefined,
    };

    fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2));
    
    console.log(`\n📱 Extracted ${resolved.length} contacts from ${groupList.length} groups`);
    if (unresolved.length > 0) {
      console.log(`⚠️  ${unresolved.length} contacts have unresolved LIDs`);
    }
    console.log(`💾 Saved to: ${OUTPUT_PATH}`);
    
    // Print top contacts with real phone numbers
    console.log("\n🔝 Top contacts by group membership:");
    for (const contact of resolved.slice(0, 15)) {
      const admin = contact.isAdmin ? " (admin)" : "";
      console.log(`  ${contact.phone}: ${contact.groups.length} groups${admin}`);
    }

  } catch (err: unknown) {
    const error = err as Error;
    console.error("❌ Error:", error.message);
    throw err;
  } finally {
    sock.ws?.close();
    process.exit(0);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
