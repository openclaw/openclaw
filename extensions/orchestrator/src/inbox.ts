// Watched-directory inbox seam for the Fleet Orchestrator agent. The
// recon (A-B2) flagged the inbound-message API as undefined; this
// fallback writes a `<task-id>.json` file under the agent's `inbox/`
// directory. The orchestrator agent's prompt loop polls the inbox at
// startup and on a schedule (driven by the agent runtime, not by
// this extension), parses each message, and calls `sessions_spawn`
// per its IDENTITY.md.

import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { FLEET_ORCHESTRATOR_AGENT_ID } from "./install.js";

export interface InboxOptions {
  /** Override agents root for tests. Default `~/.openclaw/agents`. */
  agentsDir?: string;
}

/** Schema of a single inbox message. Matches the prompt template the agent's IDENTITY.md expects. */
export interface InboxMessage {
  schemaVersion: 1;
  taskId: string;
  goal: string;
  assignedAgentId: string;
  capabilities: string[];
  parentSessionId?: string;
  /** ISO 8601 — used to detect stale messages on startup. */
  enqueuedAt: string;
}

function defaultAgentsDir(): string {
  return resolve(homedir(), ".openclaw", "agents");
}

export function inboxDir(options: InboxOptions = {}): string {
  return resolve(options.agentsDir ?? defaultAgentsDir(), FLEET_ORCHESTRATOR_AGENT_ID, "inbox");
}

function inboxPath(taskId: string, options: InboxOptions = {}): string {
  return resolve(inboxDir(options), `${taskId}.json`);
}

function tempPath(taskId: string, options: InboxOptions = {}): string {
  return resolve(inboxDir(options), `${taskId}.json.tmp`);
}

/**
 * Atomically enqueue an inbox message for the orchestrator agent. The
 * write is `<id>.json.tmp` followed by `rename(.tmp, .json)` so a
 * polling reader never sees a partial JSON object.
 */
export function enqueueInboxMessage(
  message: Omit<InboxMessage, "schemaVersion" | "enqueuedAt"> & {
    enqueuedAt?: string;
  },
  options: InboxOptions = {},
): InboxMessage {
  const target = inboxPath(message.taskId, options);
  mkdirSync(dirname(target), { recursive: true });
  const full: InboxMessage = {
    schemaVersion: 1,
    enqueuedAt: message.enqueuedAt ?? new Date().toISOString(),
    ...message,
  };
  const temp = tempPath(message.taskId, options);
  writeFileSync(temp, `${JSON.stringify(full, null, 2)}\n`);
  renameSync(temp, target);
  return full;
}

/** Read every pending inbox message. Used by the orchestrator agent's startup hook (not by this extension at runtime). */
export function readInboxMessages(options: InboxOptions = {}): InboxMessage[] {
  let entries: string[];
  try {
    entries = readdirSync(inboxDir(options));
  } catch {
    return [];
  }
  const out: InboxMessage[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) {
      continue;
    }
    if (entry.endsWith(".json.tmp")) {
      continue;
    }
    const path = resolve(inboxDir(options), entry);
    try {
      const raw = readFileSync(path, "utf8");
      const parsed = JSON.parse(raw) as InboxMessage;
      if (parsed.schemaVersion !== 1) {
        continue;
      }
      out.push(parsed);
    } catch {
      // skip unreadable / malformed messages — orchestrator agent will see fewer; sweeper cleans up
    }
  }
  out.sort((a, b) => (a.enqueuedAt < b.enqueuedAt ? -1 : 1));
  return out;
}

export function removeInboxMessage(taskId: string, options: InboxOptions = {}): boolean {
  try {
    unlinkSync(inboxPath(taskId, options));
    return true;
  } catch {
    return false;
  }
}
