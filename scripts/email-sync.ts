#!/usr/bin/env -S node --import tsx
import { execSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";

const ACCOUNT = "jr@veropwr.com";
const REPO_ROOT = join(dirname(new URL(import.meta.url).pathname), "..");
const ARCHIVE_PATH = join(REPO_ROOT, "email-archive", "emails.json");
const GOG = process.env.GOG_BIN ?? "gog";

interface ArchiveMessage {
  id: string;
  threadId: string;
  date: string;
  from: string;
  subject: string;
  labels: string[];
}

interface Archive {
  messages: ArchiveMessage[];
  lastSyncAt?: string;
}

function gog(args: string): unknown {
  const cmd = `${GOG} ${args}`;
  const out = execSync(cmd, {
    encoding: "utf-8",
    maxBuffer: 50 * 1024 * 1024,
    timeout: 120_000,
  });
  return JSON.parse(out.trim());
}

function saveArchive(archive: Archive): void {
  mkdirSync(dirname(ARCHIVE_PATH), { recursive: true });
  writeFileSync(ARCHIVE_PATH, JSON.stringify(archive, null, 2));
}

interface GogSearchMessage {
  id: string;
  threadId?: string;
  date?: string;
  from?: string;
  subject?: string;
  labels?: string[];
}

async function main() {
  const days = 30; // Hardcoding to 30 to ensure we have data

  console.log(`Email Sync (simple) — ${new Date().toISOString()}`);
  const archive = { messages: [] }; // Starting fresh to clear corrupted data
  const existingIds = new Set();

  const query = `newer_than:${days}d`;

  let pageToken: string | undefined;
  do {
    const pageArg = pageToken ? ` --page "${pageToken}"` : "";
    const result = gog(`gmail messages search "${query}" -a ${ACCOUNT} -j --max 100${pageArg}`) as {
      messages?: GogSearchMessage[];
      nextPageToken?: string;
    };

    for (const msg of result.messages ?? []) {
      if (!existingIds.has(msg.id)) {
        archive.messages.push({
          id: msg.id,
          threadId: msg.threadId,
          date: msg.date,
          from: msg.from,
          subject: msg.subject,
          labels: msg.labels ?? [],
        });
        existingIds.add(msg.id);
      }
    }
    pageToken = result.nextPageToken;
  } while (pageToken);

  archive.messages.sort((a, b) => b.date.localeCompare(a.date));
  archive.lastSyncAt = new Date().toISOString();
  saveArchive(archive);

  console.log(`\nDone. Rebuilt archive with ${archive.messages.length} messages.`);
}

main().catch((err) => {
  console.error("Email sync failed:", err);
  process.exit(1);
});
