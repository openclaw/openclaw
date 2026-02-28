#!/usr/bin/env node
/**
 * SimpleX Plugin CLI Test Runner
 * Connects to simplex-chat WebSocket and handles messages interactively.
 * Usage: node cli-test.mjs [--port 5225] [--dry-run]
 */

import { createInterface } from "readline";
import WebSocket from "ws";

const WS_URL = process.argv.includes("--port")
  ? `ws://127.0.0.1:${process.argv[process.argv.indexOf("--port") + 1]}`
  : "ws://127.0.0.1:5225";
const DRY_RUN = process.argv.includes("--dry-run");

let ws;
let corrCounter = 0;
const pendingCommands = new Map();

function log(tag, msg) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] [${tag}] ${msg}`);
}

function sendCommand(cmd) {
  const corrId = `cli-${++corrCounter}`;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingCommands.delete(corrId);
      reject(new Error(`Command timed out: ${cmd}`));
    }, 10000);

    pendingCommands.set(corrId, { resolve, reject, timeout, cmd });

    const payload = JSON.stringify({ corrId, cmd });
    if (DRY_RUN) {
      log("DRY", `Would send: ${cmd}`);
      clearTimeout(timeout);
      pendingCommands.delete(corrId);
      resolve({ type: "dry-run" });
      return;
    }
    ws.send(payload);
    log("SEND", cmd);
  });
}

function handleResponse(data) {
  try {
    const parsed = JSON.parse(data.toString());
    const corrId = parsed.corrId;
    const respType = parsed.resp?.type || "unknown";

    // Handle correlated responses
    if (corrId && pendingCommands.has(corrId)) {
      const { resolve, timeout } = pendingCommands.get(corrId);
      clearTimeout(timeout);
      pendingCommands.delete(corrId);
      resolve(parsed.resp);
    }

    // Handle incoming messages
    if (respType === "newChatItems") {
      const items = parsed.resp?.chatItems || [];
      for (const item of items) {
        const ci = item.chatItem;
        if (!ci) continue;

        const direction = ci.chatDir?.type;
        if (direction === "directRcv" || direction === "groupRcv") {
          const content = ci.content;
          const sender = ci.chatDir?.contactId
            ? ci.chatDir.localDisplayName || "unknown"
            : ci.chatDir?.groupMember?.localDisplayName || "unknown";
          const group = ci.chatDir?.groupInfo?.groupProfile?.displayName;
          const msgText = content?.text || content?.msgContent?.text || "[non-text]";
          const isVoice = content?.msgContent?.type === "voice";

          if (group) {
            log("MSG", `[${group}] ${sender}: ${msgText}${isVoice ? " 🎤" : ""}`);
          } else {
            log("MSG", `DM from ${sender}: ${msgText}${isVoice ? " 🎤" : ""}`);
          }
        }
      }
    } else if (respType === "contactConnected") {
      const name = parsed.resp?.contact?.localDisplayName || "unknown";
      log("CONNECT", `Contact connected: ${name}`);
    } else if (respType === "rcvFileComplete") {
      const path = parsed.resp?.filePath || "unknown";
      log("FILE", `File received: ${path}`);
    } else if (!corrId) {
      // Log uncorrelated events we care about
      if (
        !["chatItemsStatusesUpdated", "subscriptionEnd", "contactAnotherClient"].includes(respType)
      ) {
        log("EVENT", `${respType}`);
      }
    }
  } catch (e) {
    log("ERROR", `Parse error: ${e.message}`);
  }
}

async function connect() {
  return new Promise((resolve, reject) => {
    log("INFO", `Connecting to ${WS_URL}...`);
    ws = new WebSocket(WS_URL);

    ws.on("open", () => {
      log("INFO", "✅ Connected to SimpleX CLI");
      resolve();
    });

    ws.on("message", handleResponse);

    ws.on("close", (code, reason) => {
      log("WARN", `WebSocket closed: ${code} ${reason}`);
    });

    ws.on("error", (err) => {
      log("ERROR", `WebSocket error: ${err.message}`);
      reject(err);
    });
  });
}

async function main() {
  if (DRY_RUN) {
    log("INFO", "🧪 DRY RUN MODE — no WebSocket connection");
  } else {
    await connect();
  }

  // Get initial state
  if (!DRY_RUN) {
    try {
      const profile = await sendCommand("/u");
      log("INFO", `Profile: ${profile?.user?.localDisplayName || "unknown"}`);

      const contacts = await sendCommand("/contacts");
      const contactList = contacts?.contacts || [];
      log("INFO", `Contacts (${contactList.length}):`);
      for (const c of contactList) {
        log("INFO", `  - ${c.localDisplayName} (id:${c.contactId})`);
      }

      const groups = await sendCommand("/groups");
      const groupList = groups?.groups || [];
      log("INFO", `Groups (${groupList.length}):`);
      for (const g of groupList) {
        const gp = g.groupInfo?.groupProfile;
        log("INFO", `  - ${gp?.displayName || "?"} (id:${g.groupInfo?.groupId})`);
      }
    } catch (e) {
      log("WARN", `Init error: ${e.message}`);
    }
  }

  // Interactive REPL
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  console.log("\n📡 SimpleX CLI Test Runner");
  console.log("Commands:");
  console.log("  msg @Contact message    — Send DM");
  console.log("  msg #Group message      — Send group message");
  console.log("  file @Contact /path     — Send file");
  console.log("  file #Group /path       — Send file to group");
  console.log("  contacts                — List contacts");
  console.log("  groups                  — List groups");
  console.log("  raw <command>           — Send raw SimpleX command");
  console.log("  quit                    — Exit\n");

  const prompt = () =>
    rl.question("simplex> ", async (input) => {
      const trimmed = input.trim();
      if (!trimmed) return prompt();

      try {
        if (trimmed === "quit" || trimmed === "exit") {
          log("INFO", "Shutting down...");
          ws?.close();
          rl.close();
          process.exit(0);
        } else if (trimmed.startsWith("msg ")) {
          const match = trimmed.match(/^msg\s+([@#]\S+)\s+(.+)$/);
          if (match) {
            const [, target, text] = match;
            if (target.startsWith("#")) {
              await sendCommand(`${target} ${text}`);
            } else {
              await sendCommand(`${target} ${text}`);
            }
          } else {
            console.log("Usage: msg @Contact message  OR  msg #Group message");
          }
        } else if (trimmed.startsWith("file ")) {
          const match = trimmed.match(/^file\s+([@#]\S+)\s+(.+)$/);
          if (match) {
            const [, target, path] = match;
            await sendCommand(`/file ${target} ${path}`);
          }
        } else if (trimmed === "contacts") {
          await sendCommand("/contacts");
        } else if (trimmed === "groups") {
          await sendCommand("/groups");
        } else if (trimmed.startsWith("raw ")) {
          await sendCommand(trimmed.slice(4));
        } else {
          console.log('Unknown command. Type "quit" to exit.');
        }
      } catch (e) {
        log("ERROR", e.message);
      }

      prompt();
    });

  prompt();
}

main().catch((e) => {
  log("FATAL", e.message);
  process.exit(1);
});
