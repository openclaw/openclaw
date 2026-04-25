/**
 * @openclaw/inbox-triage
 *
 * Daily Gmail + WhatsApp triage:
 *   1. Pull unread Gmail (last N hours) and recent inbound WhatsApp
 *   2. Send to the agent for categorisation + (optional) draft replies
 *   3. Deliver the brief to a chat channel of choice (default: WhatsApp self)
 *
 * The plugin exposes a single agent-facing tool, `inbox_triage_run`, which
 * the gateway's cron system can invoke at 07:00 daily via:
 *
 *   openclaw cron add --name "Daily inbox triage" --cron "0 7 * * *" \
 *       --tz Europe/London --session isolated \
 *       --system-event "Run inbox-triage skill"
 *
 * The cron entry pulls the skill's SKILL.md into the agent's context and
 * the agent calls `inbox_triage_run`.
 */

import { Type } from "typebox";
import { definePluginEntry, type OpenClawPluginApi } from "./api.js";
import { inboxTriageConfigSchema } from "./config.js";
import { deliverBrief } from "./deliver.js";
import { GmailClient } from "./gmail-client.js";
import {
  buildTriagePrompt,
  parseTriageOutput,
  renderBrief,
  type TriageOutput,
} from "./triage-prompt.js";
import { listRecentWhatsApp } from "./whatsapp-source.js";

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export default definePluginEntry({
  id: "inbox-triage",
  name: "Inbox Triage",
  description:
    "Daily Gmail + WhatsApp triage with categorised brief and one-tap reply approval.",
  configSchema: inboxTriageConfigSchema,

  register(api: OpenClawPluginApi) {
    const cfg = inboxTriageConfigSchema.parse(api.pluginConfig);
    const gmail = new GmailClient(cfg.gmail);

    api.logger.info(
      `inbox-triage: ready (gmail=${cfg.gmail.user}, deliver=${cfg.deliver.channel}/${cfg.deliver.target}, lookback=${cfg.lookbackHours}h)`,
    );

    // -----------------------------------------------------------------------
    // The single tool the agent calls. Returns the raw triage JSON so the
    // agent can reason about it further if needed.
    // -----------------------------------------------------------------------

    api.registerTool(
      {
        name: "inbox_triage_run",
        label: "Run Inbox Triage",
        description:
          "Pull unread Gmail and recent WhatsApp, categorise, optionally draft replies, " +
          "and deliver the morning brief to the configured channel.",
        parameters: Type.Object({
          deliver: Type.Optional(
            Type.Boolean({
              description: "Whether to actually send the brief (default true).",
            }),
          ),
          lookbackHours: Type.Optional(
            Type.Number({
              description: "Override the configured look-back window for this run only.",
            }),
          ),
        }),
        async execute(_toolCallId, params) {
          const { deliver = true, lookbackHours } = params as {
            deliver?: boolean;
            lookbackHours?: number;
          };
          const window = Math.max(1, Math.min(168, lookbackHours ?? cfg.lookbackHours));
          const sinceMs = Date.now() - window * 3600 * 1000;

          const [gmailUnread, waInbound] = await Promise.all([
            gmail.listUnread(sinceMs).catch((err) => {
              api.logger.warn(`inbox-triage: gmail fetch failed: ${String(err)}`);
              return [];
            }),
            listRecentWhatsApp(api.runtime, sinceMs).catch((err) => {
              api.logger.warn(`inbox-triage: whatsapp fetch failed: ${String(err)}`);
              return [];
            }),
          ]);

          if (gmailUnread.length === 0 && waInbound.length === 0) {
            const empty: TriageOutput = {
              summary: "Inbox is clear — nothing unread in the last window.",
              items: [],
            };
            if (deliver) {
              await deliverBrief(api.runtime, {
                channel: cfg.deliver.channel,
                target: cfg.deliver.target,
                body: renderBrief(empty),
              });
            }
            return {
              content: [{ type: "text", text: empty.summary }],
              details: { delivered: deliver, ...empty },
            };
          }

          const prompt = buildTriagePrompt({
            gmail: gmailUnread,
            whatsapp: waInbound,
            draftReplies: cfg.draftReplies,
          });

          // Use the agent's own model to do the categorisation. We pass
          // through the runtime's prompt API so we don't bind to any
          // particular provider.
          const completion = await api.runtime.agent.complete({
            prompt,
            system:
              "Return STRICT JSON only. No prose, no markdown fences. " +
              "If you cannot comply, return {\"summary\":\"triage failed\",\"items\":[]}.",
            maxTokens: 4000,
            temperature: 0,
          });

          let triage: TriageOutput;
          try {
            triage = parseTriageOutput(String(completion?.text ?? ""));
          } catch (err) {
            api.logger.warn(`inbox-triage: model output unparseable: ${String(err)}`);
            triage = {
              summary: "Triage failed to parse — see gateway logs.",
              items: [],
            };
          }

          const body = renderBrief(triage);
          if (deliver) {
            await deliverBrief(api.runtime, {
              channel: cfg.deliver.channel,
              target: cfg.deliver.target,
              body,
            });
          }

          return {
            content: [{ type: "text", text: body }],
            details: {
              delivered: deliver,
              gmailCount: gmailUnread.length,
              whatsappCount: waInbound.length,
              ...triage,
            },
          };
        },
      },
      { name: "inbox_triage_run" },
    );

    // -----------------------------------------------------------------------
    // Listen for one-tap-reply approvals coming back over WhatsApp.
    //
    // Format expected from the user:
    //   Y <gmailMessageId>   → send the previously drafted reply
    //   S <gmailMessageId>   → mark as skipped (no-op, just acknowledge)
    //
    // Drafts are kept in-memory keyed by message id. They survive only
    // until the next triage run, which is fine: if you didn't act in 24h,
    // the next brief will redraft.
    // -----------------------------------------------------------------------

    const draftCache = new Map<
      string,
      { threadId: string; to: string; subject: string; body: string; inReplyTo?: string }
    >();

    // Intercept the agent's last triage to populate the draft cache.
    api.on("tool_call_end", (event) => {
      const e = asRecord(event);
      if (e?.name !== "inbox_triage_run") return;
      const details = asRecord(e.details);
      const items = Array.isArray(details?.items) ? (details!.items as unknown[]) : [];
      for (const raw of items) {
        const it = asRecord(raw);
        if (!it || typeof it.id !== "string" || typeof it.draft_reply !== "string") continue;
        if (it.channel !== "gmail") continue;
        const meta = asRecord(it.metadata) ?? {};
        draftCache.set(it.id, {
          threadId: typeof meta.threadId === "string" ? meta.threadId : it.id,
          to: typeof meta.from === "string" ? meta.from : "",
          subject:
            typeof it.subject_or_chat === "string"
              ? it.subject_or_chat
              : "(no subject)",
          body: it.draft_reply,
          inReplyTo: typeof meta.messageId === "string" ? meta.messageId : it.id,
        });
      }
    });

    api.on("message_received", async (event) => {
      const e = asRecord(event);
      if (!e || e.channel !== cfg.deliver.channel) return;
      const message = asRecord(e.message) ?? e;
      const text = typeof message.text === "string" ? message.text.trim() : "";
      const match = text.match(/^([YS])\s+(\S+)$/i);
      if (!match) return;

      const [, action, id] = match;
      const draft = draftCache.get(id);
      if (!draft) {
        await deliverBrief(api.runtime, {
          channel: cfg.deliver.channel,
          target: cfg.deliver.target,
          body: `No draft cached for \`${id}\` — re-run inbox triage.`,
        });
        return;
      }

      if (action.toUpperCase() === "S") {
        draftCache.delete(id);
        await deliverBrief(api.runtime, {
          channel: cfg.deliver.channel,
          target: cfg.deliver.target,
          body: `Skipped \`${id}\`.`,
        });
        return;
      }

      try {
        await gmail.sendReply({
          threadId: draft.threadId,
          to: draft.to,
          subject: draft.subject,
          body: draft.body,
          inReplyTo: draft.inReplyTo,
        });
        draftCache.delete(id);
        await deliverBrief(api.runtime, {
          channel: cfg.deliver.channel,
          target: cfg.deliver.target,
          body: `Sent reply to *${draft.to}* re: ${draft.subject}.`,
        });
      } catch (err) {
        api.logger.warn(`inbox-triage: send failed for ${id}: ${String(err)}`);
        await deliverBrief(api.runtime, {
          channel: cfg.deliver.channel,
          target: cfg.deliver.target,
          body: `Failed to send reply for \`${id}\`: ${String(err)}`,
        });
      }
    });

    // -----------------------------------------------------------------------
    // Service registration so the gateway lists the plugin
    // -----------------------------------------------------------------------

    api.registerService({
      id: "inbox-triage",
      start: () => {
        api.logger.info("inbox-triage: started");
      },
      stop: () => {
        api.logger.info("inbox-triage: stopped");
      },
    });
  },
});
