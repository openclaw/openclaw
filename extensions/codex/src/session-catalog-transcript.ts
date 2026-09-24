import type { SessionCatalogTranscriptItem } from "openclaw/plugin-sdk/session-catalog";
import { sessionCatalogPaging } from "openclaw/plugin-sdk/session-catalog-paging";
import { z } from "zod";
import type { CodexThreadItem } from "./app-server/protocol.js";
import {
  readCodexThreadHistoryPage,
  readLegacyCodexHistoryPage,
} from "./app-server/thread-history-page.js";
import { MAX_TRANSCRIPT_PAGE_BYTES } from "./session-catalog-parsing.js";
import { toGenericTranscriptItem } from "./session-catalog-transcript-item.js";
import type { CodexSessionCatalogControl } from "./session-catalog-types.js";

type TranscriptRequest = { threadId: string; cursor?: string; limit: number };
type TranscriptPage = { items: SessionCatalogTranscriptItem[]; nextCursor?: string };
type ReadTurns = Parameters<typeof readLegacyCodexHistoryPage>[0];
const transcriptPageSchema = z.strictObject({
  items: z.array(
    z.strictObject({
      id: z.string(),
      type: z.enum(["userMessage", "agentMessage", "reasoning", "toolCall", "toolResult", "other"]),
      text: z.string().optional(),
      raw: z.record(z.string(), z.json()).optional(),
      truncated: z.boolean().optional(),
    }),
  ),
  nextCursor: z.string().optional(),
});

export function parseCodexCatalogTranscriptPage(value: unknown): TranscriptPage {
  return transcriptPageSchema.parse(value);
}

function projectTranscriptPage(
  items: CodexThreadItem[],
  limit: number,
): SessionCatalogTranscriptItem[] {
  const projected = items.map(toGenericTranscriptItem);
  const page = sessionCatalogPaging.boundTranscriptPage(projected.toReversed(), limit, 0).items;
  for (const [index, item] of page.entries()) {
    if (item.text !== projected[index]?.text && projected[index]?.text) {
      item.truncated = true;
    }
  }
  return page;
}

function pageFitsNodeTransport(page: TranscriptPage): boolean {
  // node.invoke carries JSON inside payloadJSON. Bound that representation before sending,
  // while retaining the full native raw item for non-UI consumers.
  return (
    Buffer.byteLength(JSON.stringify({ payloadJSON: JSON.stringify(page) }), "utf8") <=
    MAX_TRANSCRIPT_PAGE_BYTES
  );
}

/** The legacy API can anchor a turn, but cannot continue within that turn. */
export async function readLegacyCodexTranscriptPage(
  readTurns: ReadTurns,
  request: TranscriptRequest,
): Promise<TranscriptPage> {
  return readLegacyCodexHistoryPage(readTurns, request, {
    project: (entries, limit) =>
      projectTranscriptPage(
        entries.map(({ item }) => item),
        limit,
      ),
    fits: pageFitsNodeTransport,
  });
}

/** Uses the native store's item cursor whenever that store supports item history. */
export async function readCodexCatalogTranscriptPage(
  control: CodexSessionCatalogControl,
  request: TranscriptRequest,
): Promise<TranscriptPage> {
  const thread = await control.requireEligibleThread(request.threadId);
  return readCodexThreadHistoryPage(control, thread, request, {
    project: (entries, limit) =>
      projectTranscriptPage(
        entries.map(({ item }) => item),
        limit,
      ),
    fits: pageFitsNodeTransport,
  });
}
