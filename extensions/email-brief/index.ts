import type { OpenClawPluginApi } from "../../src/plugins/types.js";
import type { EmailMessage } from "./types.js";
import { chunkMarkdownText } from "../../src/auto-reply/chunk.js";
import { extractBody, extractMetadata } from "./gmail-body.js";
import { GmailClient, resolveGmailConfig } from "./gmail-client.js";
import { buildGmailQuery } from "./gmail-query.js";
import { parseArgs } from "./parse-args.js";
import { summarizeEmails, formatFallback } from "./summarize.js";

/** Maximum response length before chunking for Telegram. */
const MAX_RESPONSE_CHARS = 3900;

// ---------------------------------------------------------------------------
// Error sanitization
// ---------------------------------------------------------------------------

/** Strip private key material and tokens from error messages. */
function sanitizeErrorMessage(msg: string): string {
  let s = msg;
  // Strip PEM private key blocks
  s = s.replace(/-----BEGIN[\s\S]*?-----END[^\n]*/g, "[REDACTED]");
  if (s.includes("-----BEGIN")) {
    s = s.replace(/-----BEGIN[\s\S]*/g, "[REDACTED]");
  }
  // Strip Bearer tokens
  s = s.replace(/Bearer\s+\S+/g, "Bearer [REDACTED]");
  return s;
}

// ---------------------------------------------------------------------------
// Plugin registration
// ---------------------------------------------------------------------------

export default function register(api: OpenClawPluginApi) {
  api.registerCommand({
    name: "email_brief",
    description:
      "Gmail inbox summary. Usage: /email_brief [filters...] [period]\n" +
      "Examples: /email_brief, /email_brief 7d, /email_brief from:user@company.com 3d, /email_brief urgent",
    acceptsArgs: true,
    requireAuth: true,
    handler: async (ctx) => {
      // 1. Resolve Gmail config
      let gmailConfig;
      try {
        gmailConfig = resolveGmailConfig(
          api.pluginConfig as { userEmail?: string; maxEmails?: number } | undefined,
        );
      } catch (err) {
        return { text: sanitizeErrorMessage((err as Error).message) };
      }

      // 2. Parse arguments
      const args = parseArgs(ctx.args ?? "");

      // 3. Build Gmail search query
      const query = buildGmailQuery(args);

      // 4. Fetch emails from Gmail
      const client = new GmailClient(gmailConfig);
      let messageIds: string[];
      try {
        messageIds = await client.listMessages(query, gmailConfig.maxEmails);
      } catch (err) {
        return { text: sanitizeErrorMessage(`Failed to list emails: ${(err as Error).message}`) };
      }

      // 5. Handle empty inbox
      if (messageIds.length === 0) {
        return {
          text:
            `No emails found matching your query (${args.period} period).` +
            "\n\nTry widening the period: /email_brief 7d",
        };
      }

      // 6. Fetch message details
      let messages;
      try {
        const rawMessages = await client.getMessages(messageIds);

        // Extract metadata and body from each message
        messages = rawMessages.map((raw): EmailMessage => {
          const meta = extractMetadata(raw);
          const body = extractBody(raw);
          return {
            id: raw.id,
            from: meta.from,
            subject: meta.subject,
            date: meta.date,
            snippet: raw.snippet ?? "",
            body,
          };
        });
      } catch (err) {
        return {
          text: sanitizeErrorMessage(`Failed to fetch email details: ${(err as Error).message}`),
        };
      }

      // 7. Summarize via LLM
      let summary: string;
      try {
        summary = await summarizeEmails(messages, {
          urgent: args.filters.urgent ?? false,
          config: api.config,
          model: (api.pluginConfig as Record<string, unknown>)?.model as string | undefined,
        });
      } catch {
        // LLM failed — use fallback
        summary = formatFallback(messages);
      }

      // 8. Chunk for Telegram if needed
      if (summary.length > MAX_RESPONSE_CHARS) {
        const chunks = chunkMarkdownText(summary, MAX_RESPONSE_CHARS);
        const totalParts = chunks.length;
        return {
          text: `${chunks[0]}\n\n(Part 1/${totalParts})`,
        };
      }

      return { text: summary };
    },
  });
}
