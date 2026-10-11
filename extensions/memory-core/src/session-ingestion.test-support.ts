import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveSessionTranscriptsDirForAgent } from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import { upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { appendSessionTranscriptMessageByIdentity } from "openclaw/plugin-sdk/session-transcript-runtime";
import { observeHostDataSql } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { expect } from "vitest";
import type { readShortTermRecallEntries } from "./short-term-promotion.js";

type TranscriptMessage = {
  role: "assistant" | "tool" | "user";
  content: string;
  timestamp: string;
  owner?: boolean;
};

export function makeMessage(role: "user" | "assistant", timestamp: string, content: unknown) {
  return { role, timestamp, content };
}

export async function writeTranscript(
  filePath: string,
  messages: TranscriptMessage[],
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const records = messages.map((message, index) => ({
    type: "message",
    id: `message-${index}`,
    timestamp: message.timestamp,
    message: {
      role: message.role,
      content: message.content,
      timestamp: message.timestamp,
      ...(message.owner ? { __openclaw: { senderIsOwner: true } } : {}),
    },
  }));
  await fs.writeFile(filePath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
}

export async function seedCanonicalTranscript(
  sessionId: string,
  messages: TranscriptMessage[],
  metadata: Partial<Parameters<typeof upsertSessionEntry>[0]["entry"]> = {},
): Promise<void> {
  const agentId = "main";
  const sessionsDir = resolveSessionTranscriptsDirForAgent(agentId);
  const storePath = path.join(sessionsDir, "sessions.json");
  const sessionKey = `agent:${agentId}:session-backfill:${sessionId}`;
  const updatedAt = Math.max(
    Date.now(),
    ...messages.map((message) => Date.parse(message.timestamp)),
  );
  await fs.mkdir(sessionsDir, { recursive: true });
  const entry = { ...metadata, sessionId, updatedAt };
  await upsertSessionEntry({ agentId, sessionKey, storePath, entry });
  for (const message of messages) {
    await appendSessionTranscriptMessageByIdentity({
      agentId,
      sessionId,
      sessionKey,
      storePath,
      message: {
        role: message.role,
        content: message.content,
        timestamp: message.timestamp,
        ...(message.owner ? { __openclaw: { senderIsOwner: true } } : {}),
      },
    });
  }
  await upsertSessionEntry({ agentId, sessionKey, storePath, entry });
}

export function hashStagedContent(
  entries: Awaited<ReturnType<typeof readShortTermRecallEntries>>,
): string {
  const content = entries
    .map((entry) => ({
      claimHash: entry.claimHash,
      provenance: entry.provenance,
      snippet: entry.snippet,
    }))
    .toSorted((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return createHash("sha256").update(JSON.stringify(content)).digest("hex");
}

export async function withSessionAdmissionReadBudget<T>(
  operation: () => Promise<T>,
  maximum: number,
): Promise<T> {
  let metadataReads = 0;
  const observation = observeHostDataSql((sql, database) => {
    if (
      !database &&
      /\bhook_external_content_source\b/iu.test(sql) &&
      /\bfrom\s+["`]?session_windows\b/iu.test(sql)
    ) {
      metadataReads++;
    }
  });
  const result = await operation().finally(observation.restore);
  expect(metadataReads).toBeLessThanOrEqual(maximum);
  if (maximum > 0) {
    expect(metadataReads).toBeGreaterThan(0);
  }
  return result;
}
