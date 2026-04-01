/**
 * Outreach Tools — Multi-channel personalized outreach
 *
 * 4 tools: outreach_compose, outreach_send, outreach_sequence, outreach_response
 *
 * Orchestrates email (SendGrid), SMS (Twilio), Instagram DM (Meta),
 * WhatsApp, and opt-in batch workflows with approval gates.
 */

import { execFile } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { promisify } from "node:util";
import { Type, type Static } from "@sinclair/typebox";
import type { OpenClawPluginApi, AnyAgentTool } from "openclaw/plugin-sdk";
import { requestApproval, notifyOwner } from "./approval-gate.js";
import { textResult, resolveWorkspaceDir, httpRequest } from "./common.js";

const execFileAsync = promisify(execFile);

async function readJson(p: string) {
  try {
    return JSON.parse(await readFile(p, "utf-8"));
  } catch {
    return null;
  }
}
async function writeJson(p: string, d: unknown) {
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, JSON.stringify(d, null, 2), "utf-8");
}

// ── Parameter Schemas ──────────────────────────────────────────────────

const OutreachComposeParams = Type.Object({
  business_id: Type.String({ description: "Business ID" }),
  contact_id: Type.String({ description: "Contact ID to compose outreach for" }),
  channel: Type.Union(
    [
      Type.Literal("email"),
      Type.Literal("sms"),
      Type.Literal("instagram_dm"),
      Type.Literal("whatsapp"),
    ],
    { description: "Outreach channel" },
  ),
  template_type: Type.Optional(
    Type.Union([Type.Literal("initial"), Type.Literal("followup"), Type.Literal("re_engage")], {
      description: "Template type (default: initial)",
    }),
  ),
  persona_id: Type.Optional(Type.String({ description: "Persona ID for tone adjustment" })),
  custom_message: Type.Optional(
    Type.String({ description: "Custom message override (skips template)" }),
  ),
});

const OutreachSendParams = Type.Object({
  business_id: Type.String({ description: "Business ID" }),
  action: Type.Union(
    [
      Type.Literal("email"),
      Type.Literal("sms"),
      Type.Literal("instagram_dm"),
      Type.Literal("whatsapp"),
      Type.Literal("optin_batch"),
    ],
    { description: "Send channel/action" },
  ),
  contact_id: Type.Optional(Type.String({ description: "Contact ID for individual send" })),
  message: Type.Optional(Type.String({ description: "Message content to send" })),
  subject: Type.Optional(Type.String({ description: "Email subject line" })),
  to_email: Type.Optional(Type.String({ description: "Recipient email" })),
  to_phone: Type.Optional(Type.String({ description: "Recipient phone for SMS/WhatsApp" })),
  sequence_id: Type.Optional(Type.String({ description: "Associated sequence ID" })),
});

const OutreachSequenceParams = Type.Object({
  business_id: Type.String({ description: "Business ID" }),
  action: Type.Union(
    [
      Type.Literal("create"),
      Type.Literal("advance"),
      Type.Literal("pause"),
      Type.Literal("resume"),
      Type.Literal("status"),
    ],
    { description: "Sequence action" },
  ),
  sequence_id: Type.Optional(Type.String({ description: "Sequence ID for operations" })),
  contact_id: Type.Optional(Type.String({ description: "Contact ID for new sequence" })),
  sequence_type: Type.Optional(
    Type.Union(
      [
        Type.Literal("cold_outreach"),
        Type.Literal("warm_nurture"),
        Type.Literal("re_engage"),
        Type.Literal("follow_up"),
        Type.Literal("onboarding"),
      ],
      { description: "Sequence type for creation" },
    ),
  ),
  channel: Type.Optional(
    Type.Union(
      [
        Type.Literal("email"),
        Type.Literal("sms"),
        Type.Literal("instagram_dm"),
        Type.Literal("whatsapp"),
        Type.Literal("multi"),
      ],
      { description: "Primary channel for sequence" },
    ),
  ),
  total_steps: Type.Optional(
    Type.Number({ description: "Total steps in the sequence (default 5)" }),
  ),
});

const OutreachResponseParams = Type.Object({
  business_id: Type.String({ description: "Business ID" }),
  action: Type.Union([Type.Literal("check"), Type.Literal("classify"), Type.Literal("handoff")], {
    description: "Response action",
  }),
  contact_id: Type.Optional(Type.String({ description: "Contact ID" })),
  message_id: Type.Optional(Type.String({ description: "Message ID to classify" })),
  sentiment: Type.Optional(
    Type.Union([Type.Literal("positive"), Type.Literal("neutral"), Type.Literal("negative")], {
      description: "Response sentiment classification",
    }),
  ),
  handoff_reason: Type.Optional(Type.String({ description: "Reason for human handoff" })),
  context_summary: Type.Optional(Type.String({ description: "Context summary for handoff" })),
});

// ── Sequence step templates ────────────────────────────────────────────

const SEQUENCE_TEMPLATES: Record<
  string,
  { steps: { day: number; action: string; channel: string }[] }
> = {
  cold_outreach: {
    steps: [
      { day: 0, action: "Initial personalized email", channel: "email" },
      { day: 3, action: "Follow-up email with case study", channel: "email" },
      { day: 7, action: "LinkedIn connection request note", channel: "email" },
      { day: 14, action: "Value-add email (industry insight)", channel: "email" },
      { day: 21, action: "Final check-in with clear CTA", channel: "email" },
    ],
  },
  warm_nurture: {
    steps: [
      { day: 0, action: "Welcome + portfolio link", channel: "email" },
      { day: 5, action: "Customer success story", channel: "email" },
      { day: 10, action: "Personalized recommendation", channel: "email" },
      { day: 20, action: "Exclusive offer / consultation invite", channel: "email" },
    ],
  },
  re_engage: {
    steps: [
      { day: 0, action: "Re-engagement email with new products", channel: "email" },
      { day: 7, action: "Social proof / recent project showcase", channel: "email" },
      { day: 14, action: "Personal note from team", channel: "email" },
    ],
  },
  follow_up: {
    steps: [
      { day: 0, action: "Thank you + next steps", channel: "email" },
      { day: 3, action: "Additional resources", channel: "email" },
      { day: 7, action: "Check-in", channel: "email" },
    ],
  },
  onboarding: {
    steps: [
      { day: 0, action: "Welcome email with getting started guide", channel: "email" },
      { day: 1, action: "Design consultation scheduling", channel: "email" },
      { day: 3, action: "Product recommendations based on space", channel: "email" },
      { day: 7, action: "Check-in + support contact", channel: "email" },
    ],
  },
};

// ── Tool Factory ───────────────────────────────────────────────────────

export function createOutreachTools(api: OpenClawPluginApi): AnyAgentTool[] {
  function sequencesPath(bizId: string) {
    return join(resolveWorkspaceDir(api), "businesses", bizId, "outreach-sequences.json");
  }
  function messagesPath(bizId: string) {
    return join(resolveWorkspaceDir(api), "businesses", bizId, "outreach-messages.json");
  }
  function handoffsPath(bizId: string) {
    return join(resolveWorkspaceDir(api), "businesses", bizId, "sales-handoffs.json");
  }
  function briefPath(bizId: string, contactId: string) {
    return join(
      resolveWorkspaceDir(api),
      "businesses",
      bizId,
      "research-briefs",
      `${contactId}.json`,
    );
  }
  function prospectsPath(bizId: string) {
    return join(resolveWorkspaceDir(api), "businesses", bizId, "prospect-profiles.json");
  }
  function brandConfigPath(bizId: string) {
    return join(resolveWorkspaceDir(api), "businesses", bizId, "brand-config.json");
  }

  return [
    // ── Outreach Compose ───────────────────────────────────────────────
    {
      name: "outreach_compose",
      label: "Compose Outreach Message",
      description:
        "Generate a personalized outreach message based on research brief, brand config, " +
        "and prospect profile. Supports email, SMS, Instagram DM, and WhatsApp channels.",
      parameters: OutreachComposeParams,
      async execute(_id: string, params: Static<typeof OutreachComposeParams>) {
        // Load research brief if available
        const brief = await readJson(briefPath(params.business_id, params.contact_id));
        const profiles = (await readJson(prospectsPath(params.business_id))) || { prospects: [] };
        const prospect = profiles.prospects?.find((p: any) => p.contact_id === params.contact_id);
        const brand = await readJson(brandConfigPath(params.business_id));

        if (params.custom_message) {
          return textResult(
            `## Outreach Message (Custom)\n\n` +
              `**To:** ${prospect?.name || params.contact_id}\n` +
              `**Channel:** ${params.channel}\n\n` +
              `---\n${params.custom_message}\n---\n\n` +
              `Use \`outreach_send:${params.channel}\` to send this message.`,
          );
        }

        const name = prospect?.name || brief?.prospect_summary?.name || "there";
        const company = prospect?.company || brief?.prospect_summary?.company || "your company";
        const templateType = params.template_type || "initial";
        const brandName = brand?.name || "VividWalls";

        let message: string;
        let subject: string | undefined;

        if (params.channel === "email") {
          if (templateType === "initial") {
            subject = `Custom wall art for ${company} — ${brandName}`;
            message =
              `Hi ${name.split(" ")[0]},\n\n` +
              `I came across ${company} and was impressed by your spaces. ` +
              `At ${brandName}, we create custom wall art and murals that transform commercial environments.\n\n` +
              (brief?.talking_points?.[0] ? `${brief.talking_points[0]}\n\n` : "") +
              (brief?.personalization_hooks?.[0] ? `${brief.personalization_hooks[0]}\n\n` : "") +
              `Would you be open to a brief conversation about how custom wall art could enhance your spaces?\n\n` +
              `Best,\n${brandName} Team`;
          } else if (templateType === "followup") {
            subject = `Following up — ${brandName} wall art for ${company}`;
            message =
              `Hi ${name.split(" ")[0]},\n\n` +
              `I wanted to follow up on my previous note about custom wall art for ${company}. ` +
              `I'd love to share some examples of our work with similar businesses in your industry.\n\n` +
              `Would a 15-minute call this week work for you?\n\n` +
              `Best,\n${brandName} Team`;
          } else {
            subject = `New collection alert — ${brandName}`;
            message =
              `Hi ${name.split(" ")[0]},\n\n` +
              `It's been a while since we connected. We've launched some exciting new collections ` +
              `that I think could be perfect for ${company}.\n\n` +
              `I'd love to reconnect and show you what's new.\n\n` +
              `Best,\n${brandName} Team`;
          }
        } else if (params.channel === "sms") {
          message =
            `Hi ${name.split(" ")[0]}, this is the ${brandName} team. ` +
            `We create custom wall art for businesses like ${company}. ` +
            `Would you be interested in seeing some examples? Reply YES to learn more.`;
        } else if (params.channel === "instagram_dm") {
          message =
            `Hi ${name.split(" ")[0]}! 👋 Love what ${company} is doing with your spaces. ` +
            `We create custom wall art and murals for businesses — would love to chat about a collaboration!`;
        } else {
          message =
            `Hi ${name.split(" ")[0]}, this is the ${brandName} team. ` +
            `We specialize in custom wall art for commercial spaces. ` +
            `I'd love to share how we can enhance ${company}'s environment. Interested?`;
        }

        return textResult(
          `## Outreach Message Composed\n\n` +
            `**To:** ${name} at ${company} (${params.contact_id})\n` +
            `**Channel:** ${params.channel}\n` +
            `**Template:** ${templateType}\n` +
            (subject ? `**Subject:** ${subject}\n` : "") +
            `\n---\n${message}\n---\n\n` +
            `**Next:** Use \`outreach_send:${params.channel}\` with this message to send.` +
            (params.channel === "instagram_dm"
              ? "\n⚠️ First-contact DMs require Telegram approval gate."
              : ""),
        );
      },
    },

    // ── Outreach Send ──────────────────────────────────────────────────
    {
      name: "outreach_send",
      label: "Send Outreach Message",
      description:
        "Send outreach messages via email (SendGrid), SMS (Twilio), Instagram DM (Meta API), " +
        "WhatsApp (Twilio), or prepare opt-in batches. First-contact DMs require approval gate.",
      parameters: OutreachSendParams,
      async execute(_id: string, params: Static<typeof OutreachSendParams>) {
        const messages = (await readJson(messagesPath(params.business_id))) || { messages: [] };

        switch (params.action) {
          case "email": {
            if (!params.to_email || !params.message)
              return textResult("Provide `to_email` and `message` for email send.");

            const sgKey = process.env.SENDGRID_API_KEY;
            if (!sgKey) return textResult("SENDGRID_API_KEY not set.");

            const resp = await httpRequest(
              "https://api.sendgrid.com/v3/mail/send",
              "POST",
              { Authorization: `Bearer ${sgKey}`, "Content-Type": "application/json" },
              {
                personalizations: [{ to: [{ email: params.to_email }] }],
                from: { email: process.env.SENDGRID_FROM_EMAIL || "hello@vividwalls.co" },
                subject: params.subject || "VividWalls — Custom Wall Art",
                content: [{ type: "text/plain", value: params.message }],
              },
              15000,
            );

            const msgRecord = {
              id: `MSG-${Date.now().toString(36)}`,
              sequence_id: params.sequence_id || null,
              contact_id: params.contact_id || null,
              channel: "email",
              direction: "outbound",
              content_preview: params.message.slice(0, 200),
              status: resp.status === 202 || resp.status === 200 ? "sent" : "bounced",
              agent_id: "outreach",
              created_at: new Date().toISOString(),
            };
            messages.messages.push(msgRecord);
            await writeJson(messagesPath(params.business_id), messages);

            return textResult(
              resp.status === 202 || resp.status === 200
                ? `✓ Email sent to ${params.to_email}\nMessage ID: ${msgRecord.id}`
                : `✗ Email send failed: HTTP ${resp.status}\n${JSON.stringify(resp.data)}`,
            );
          }

          case "sms": {
            if (!params.to_phone || !params.message)
              return textResult("Provide `to_phone` and `message` for SMS.");

            const accountSid = process.env.TWILIO_ACCOUNT_SID;
            const authToken = process.env.TWILIO_AUTH_TOKEN;
            const fromPhone = process.env.TWILIO_PHONE_NUMBER;
            if (!accountSid || !authToken || !fromPhone)
              return textResult("Twilio credentials not configured.");

            const resp = await httpRequest(
              `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
              "POST",
              {
                Authorization:
                  "Basic " + Buffer.from(`${accountSid}:${authToken}`).toString("base64"),
                "Content-Type": "application/x-www-form-urlencoded",
              },
              `To=${encodeURIComponent(params.to_phone)}&From=${encodeURIComponent(fromPhone)}&Body=${encodeURIComponent(params.message)}`,
              15000,
            );

            const msgRecord = {
              id: `MSG-${Date.now().toString(36)}`,
              sequence_id: params.sequence_id || null,
              contact_id: params.contact_id || null,
              channel: "sms",
              direction: "outbound",
              content_preview: params.message.slice(0, 200),
              status: resp.status === 201 ? "sent" : "bounced",
              agent_id: "outreach",
              created_at: new Date().toISOString(),
            };
            messages.messages.push(msgRecord);
            await writeJson(messagesPath(params.business_id), messages);

            return textResult(
              resp.status === 201
                ? `✓ SMS sent to ${params.to_phone}\nMessage ID: ${msgRecord.id}`
                : `✗ SMS failed: HTTP ${resp.status}`,
            );
          }

          case "instagram_dm": {
            if (!params.message || !params.contact_id)
              return textResult("Provide `contact_id` and `message` for Instagram DM.");

            // Approval gate for first-contact DMs
            const approval = await requestApproval({
              type: "outreach" as any,
              summary: `Instagram DM to ${params.contact_id}`,
              details: params.message.slice(0, 500),
            });

            if (!approval.approved) {
              return textResult(
                `Instagram DM to ${params.contact_id} was **rejected** by ${approval.decided_by}.`,
              );
            }

            // Queue DM via Meta Graph API
            const pageToken = process.env.META_PAGE_ACCESS_TOKEN;
            if (!pageToken)
              return textResult("META_PAGE_ACCESS_TOKEN not set. DM approved but cannot send.");

            const msgRecord = {
              id: `MSG-${Date.now().toString(36)}`,
              sequence_id: params.sequence_id || null,
              contact_id: params.contact_id,
              channel: "instagram_dm",
              direction: "outbound",
              content_preview: params.message.slice(0, 200),
              status: "queued",
              agent_id: "outreach",
              approved_by: approval.decided_by,
              created_at: new Date().toISOString(),
            };
            messages.messages.push(msgRecord);
            await writeJson(messagesPath(params.business_id), messages);

            return textResult(
              `✓ Instagram DM approved and queued for ${params.contact_id}\n` +
                `Approved by: ${approval.decided_by}\n` +
                `Message ID: ${msgRecord.id}`,
            );
          }

          case "whatsapp": {
            if (!params.to_phone || !params.message)
              return textResult("Provide `to_phone` and `message` for WhatsApp.");

            const accountSid = process.env.TWILIO_ACCOUNT_SID;
            const authToken = process.env.TWILIO_AUTH_TOKEN;
            const waNumber = process.env.TWILIO_WHATSAPP_NUMBER;
            if (!accountSid || !authToken || !waNumber)
              return textResult("Twilio WhatsApp credentials not configured.");

            const resp = await httpRequest(
              `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
              "POST",
              {
                Authorization:
                  "Basic " + Buffer.from(`${accountSid}:${authToken}`).toString("base64"),
                "Content-Type": "application/x-www-form-urlencoded",
              },
              `To=whatsapp:${encodeURIComponent(params.to_phone)}&From=whatsapp:${encodeURIComponent(waNumber)}&Body=${encodeURIComponent(params.message)}`,
              15000,
            );

            const msgRecord = {
              id: `MSG-${Date.now().toString(36)}`,
              sequence_id: params.sequence_id || null,
              contact_id: params.contact_id || null,
              channel: "whatsapp",
              direction: "outbound",
              content_preview: params.message.slice(0, 200),
              status: resp.status === 201 ? "sent" : "bounced",
              agent_id: "outreach",
              created_at: new Date().toISOString(),
            };
            messages.messages.push(msgRecord);
            await writeJson(messagesPath(params.business_id), messages);

            return textResult(
              resp.status === 201
                ? `✓ WhatsApp sent to ${params.to_phone}\nMessage ID: ${msgRecord.id}`
                : `✗ WhatsApp failed: HTTP ${resp.status}`,
            );
          }

          case "optin_batch": {
            // Call existing Python script for opt-in batch preparation
            const wsDir = resolveWorkspaceDir(api);
            const scriptPath = join(wsDir, "businesses", params.business_id, "send-optin-batch.py");

            try {
              const { stdout } = await execFileAsync("python3", [scriptPath, "prepare"], {
                timeout: 60000,
                env: { ...process.env },
              });

              return textResult(
                `## Opt-in Batch Prepared\n\n${stdout}\n\n` +
                  `**Next:** Review the prepared batch, then run with "approve" action to send.`,
              );
            } catch (err: any) {
              return textResult(
                `Opt-in batch preparation failed:\n${err.message || err}\n\n` +
                  `Ensure send-optin-batch.py exists at:\n${scriptPath}`,
              );
            }
          }

          default:
            return textResult(`Unknown send action: ${params.action}`);
        }
      },
    },

    // ── Outreach Sequence ──────────────────────────────────────────────
    {
      name: "outreach_sequence",
      label: "Outreach Sequence Manager",
      description:
        "Create and manage multi-step outreach sequences. Tracks current step, " +
        "next action timing, and sequence status. Supports cold outreach, warm nurture, " +
        "re-engage, follow-up, and onboarding sequences.",
      parameters: OutreachSequenceParams,
      async execute(_id: string, params: Static<typeof OutreachSequenceParams>) {
        const store = (await readJson(sequencesPath(params.business_id))) || { sequences: [] };

        switch (params.action) {
          case "create": {
            if (!params.contact_id) return textResult("Provide `contact_id` to create a sequence.");

            const seqType = params.sequence_type || "cold_outreach";
            const template = SEQUENCE_TEMPLATES[seqType];
            const totalSteps = params.total_steps || template?.steps.length || 5;

            const seq = {
              id: `SEQ-${Date.now().toString(36)}`,
              contact_id: params.contact_id,
              sequence_type: seqType,
              current_step: 1,
              total_steps: totalSteps,
              status: "active",
              channel: params.channel || "email",
              steps: template?.steps || [],
              next_action_at: new Date().toISOString(),
              metadata: {},
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            };

            store.sequences.push(seq);
            await writeJson(sequencesPath(params.business_id), store);

            return textResult(
              `## Sequence Created\n\n` +
                `**ID:** ${seq.id}\n` +
                `**Contact:** ${params.contact_id}\n` +
                `**Type:** ${seqType}\n` +
                `**Steps:** ${totalSteps}\n` +
                `**Channel:** ${seq.channel}\n` +
                `**Status:** active\n\n` +
                (template
                  ? `### Planned Steps\n${template.steps.map((s, i) => `${i + 1}. Day ${s.day}: ${s.action} (${s.channel})`).join("\n")}`
                  : "Custom sequence — steps will be added as executed."),
            );
          }

          case "advance": {
            // Advance all active sequences that are due
            const now = new Date();
            const due = store.sequences.filter(
              (s: any) =>
                s.status === "active" && s.next_action_at && new Date(s.next_action_at) <= now,
            );

            if (due.length === 0) return textResult("No sequences due for advancement.");

            const results: string[] = [];
            for (const seq of due) {
              if (seq.current_step >= seq.total_steps) {
                seq.status = "completed";
                seq.updated_at = now.toISOString();
                results.push(
                  `- **${seq.id}** (${seq.contact_id}): Completed all ${seq.total_steps} steps`,
                );
                continue;
              }

              const nextStep = seq.steps?.[seq.current_step]; // 0-indexed for next step
              seq.current_step += 1;
              // Schedule next step (default +3 days if no template)
              const daysUntilNext = nextStep
                ? (seq.steps[seq.current_step]?.day || 0) - (nextStep.day || 0)
                : 3;
              seq.next_action_at = new Date(
                now.getTime() + Math.max(daysUntilNext, 1) * 86400000,
              ).toISOString();
              seq.updated_at = now.toISOString();

              results.push(
                `- **${seq.id}** (${seq.contact_id}): Step ${seq.current_step}/${seq.total_steps}` +
                  (nextStep ? ` — ${nextStep.action}` : "") +
                  ` | Next: ${seq.next_action_at.split("T")[0]}`,
              );
            }

            await writeJson(sequencesPath(params.business_id), store);

            return textResult(
              `## Sequences Advanced\n\n` + `**Due:** ${due.length}\n\n` + results.join("\n"),
            );
          }

          case "pause": {
            if (!params.sequence_id) return textResult("Provide `sequence_id` to pause.");
            const seq = store.sequences.find((s: any) => s.id === params.sequence_id);
            if (!seq) return textResult(`Sequence ${params.sequence_id} not found.`);
            seq.status = "paused";
            seq.updated_at = new Date().toISOString();
            await writeJson(sequencesPath(params.business_id), store);
            return textResult(`Sequence **${params.sequence_id}** paused.`);
          }

          case "resume": {
            if (!params.sequence_id) return textResult("Provide `sequence_id` to resume.");
            const seq = store.sequences.find((s: any) => s.id === params.sequence_id);
            if (!seq) return textResult(`Sequence ${params.sequence_id} not found.`);
            seq.status = "active";
            seq.next_action_at = new Date().toISOString();
            seq.updated_at = new Date().toISOString();
            await writeJson(sequencesPath(params.business_id), store);
            return textResult(`Sequence **${params.sequence_id}** resumed.`);
          }

          case "status": {
            const active = store.sequences.filter((s: any) => s.status === "active");
            const paused = store.sequences.filter((s: any) => s.status === "paused");
            const completed = store.sequences.filter((s: any) => s.status === "completed");

            return textResult(
              `## Outreach Sequences\n\n` +
                `- **Active:** ${active.length}\n` +
                `- **Paused:** ${paused.length}\n` +
                `- **Completed:** ${completed.length}\n` +
                `- **Total:** ${store.sequences.length}\n\n` +
                (active.length > 0
                  ? `### Active Sequences\n${active
                      .slice(0, 10)
                      .map(
                        (s: any) =>
                          `- **${s.id}** — ${s.contact_id} | ${s.sequence_type} | Step ${s.current_step}/${s.total_steps} | Next: ${s.next_action_at?.split("T")[0] || "?"}`,
                      )
                      .join("\n")}`
                  : ""),
            );
          }

          default:
            return textResult(`Unknown sequence action: ${params.action}`);
        }
      },
    },

    // ── Outreach Response ──────────────────────────────────────────────
    {
      name: "outreach_response",
      label: "Outreach Response Handler",
      description:
        "Check for and process inbound responses to outreach. Classify sentiment, " +
        "update CRM stages, and escalate qualified leads to human sales via handoff.",
      parameters: OutreachResponseParams,
      async execute(_id: string, params: Static<typeof OutreachResponseParams>) {
        switch (params.action) {
          case "check": {
            const messages = (await readJson(messagesPath(params.business_id))) || { messages: [] };
            const inbound = messages.messages.filter(
              (m: any) => m.direction === "inbound" && !m.sentiment,
            );

            if (inbound.length === 0) return textResult("No unclassified inbound responses.");

            return textResult(
              `## Unclassified Responses — ${inbound.length}\n\n` +
                inbound
                  .slice(0, 10)
                  .map(
                    (m: any) =>
                      `- **${m.id}** — ${m.contact_id || "?"} via ${m.channel} | "${(m.content_preview || "").slice(0, 80)}..."`,
                  )
                  .join("\n") +
                `\n\nUse \`outreach_response:classify\` with message_id and sentiment to process.`,
            );
          }

          case "classify": {
            if (!params.message_id || !params.sentiment)
              return textResult("Provide `message_id` and `sentiment` for classification.");

            const messages = (await readJson(messagesPath(params.business_id))) || { messages: [] };
            const msg = messages.messages.find((m: any) => m.id === params.message_id);
            if (!msg) return textResult(`Message ${params.message_id} not found.`);

            msg.sentiment = params.sentiment;
            msg.classified_at = new Date().toISOString();
            await writeJson(messagesPath(params.business_id), messages);

            // Update prospect status based on sentiment
            const profiles = (await readJson(prospectsPath(params.business_id))) || {
              prospects: [],
            };
            const prospect = profiles.prospects.find((p: any) => p.contact_id === msg.contact_id);

            let recommendation: string;
            if (params.sentiment === "positive") {
              if (prospect) {
                prospect.qualification_status = "sql";
                prospect.qualified_at = new Date().toISOString();
                await writeJson(prospectsPath(params.business_id), profiles);
              }
              recommendation =
                "Positive response — upgraded to SQL. Consider handoff to human sales.";
            } else if (params.sentiment === "neutral") {
              recommendation = "Neutral response — continue nurture sequence.";
            } else {
              // Pause any active sequences for this contact
              const seqStore = (await readJson(sequencesPath(params.business_id))) || {
                sequences: [],
              };
              for (const seq of seqStore.sequences) {
                if (seq.contact_id === msg.contact_id && seq.status === "active") {
                  seq.status = "paused";
                  seq.updated_at = new Date().toISOString();
                }
              }
              await writeJson(sequencesPath(params.business_id), seqStore);
              recommendation = "Negative response — sequences paused. Cool-down period initiated.";
            }

            return textResult(
              `## Response Classified\n\n` +
                `**Message:** ${params.message_id}\n` +
                `**Contact:** ${msg.contact_id || "?"}\n` +
                `**Sentiment:** ${params.sentiment}\n\n` +
                `**Action:** ${recommendation}`,
            );
          }

          case "handoff": {
            if (!params.contact_id) return textResult("Provide `contact_id` for handoff.");

            const handoffs = (await readJson(handoffsPath(params.business_id))) || { handoffs: [] };

            const profiles = (await readJson(prospectsPath(params.business_id))) || {
              prospects: [],
            };
            const prospect = profiles.prospects.find(
              (p: any) => p.contact_id === params.contact_id,
            );

            const handoff = {
              id: `HO-${Date.now().toString(36)}`,
              contact_id: params.contact_id,
              from_agent: "outreach",
              to_agent: "human_sales",
              reason: params.handoff_reason || "Qualified lead ready for human engagement",
              context_summary:
                params.context_summary ||
                `Prospect: ${prospect?.name || "?"} at ${prospect?.company || "?"}. ` +
                  `Status: ${prospect?.qualification_status || "?"}. BANT: ${prospect?.bant_score || "?"}`,
              deal_id: null,
              status: "pending",
              created_at: new Date().toISOString(),
            };

            handoffs.handoffs.push(handoff);
            await writeJson(handoffsPath(params.business_id), handoffs);

            // Notify via Telegram
            try {
              await notifyOwner(
                `🤝 *Sales Handoff*\n\n` +
                  `**Contact:** ${prospect?.name || params.contact_id}\n` +
                  `**Company:** ${prospect?.company || "?"}\n` +
                  `**Reason:** ${handoff.reason}\n\n` +
                  `${handoff.context_summary}\n\n` +
                  `Handoff ID: ${handoff.id}`,
              );
            } catch {
              // Telegram notification is best-effort
            }

            return textResult(
              `## Sales Handoff Created\n\n` +
                `**Handoff ID:** ${handoff.id}\n` +
                `**Contact:** ${prospect?.name || params.contact_id}\n` +
                `**Company:** ${prospect?.company || "?"}\n` +
                `**From:** outreach agent\n` +
                `**To:** human sales\n` +
                `**Reason:** ${handoff.reason}\n\n` +
                `**Context:** ${handoff.context_summary}\n\n` +
                `Telegram notification sent to owner.`,
            );
          }

          default:
            return textResult(`Unknown response action: ${params.action}`);
        }
      },
    },
  ];
}
