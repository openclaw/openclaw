/**
 * LE Waitlist Tools — Limited Edition waitlist management, drip email advancement, launch triggers
 *
 * Manages waitlist signups, advances drip email sequences, and fires launch-phase emails
 * for Limited Edition art drops. Emails sent via SendGrid API.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { Type, type Static } from "@sinclair/typebox";
import type { OpenClawPluginApi, AnyAgentTool } from "openclaw/plugin-sdk";
import { textResult, resolveWorkspaceDir, httpRequest } from "./common.js";

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

// ── SendGrid credential loader ─────────────────────────────────────────

interface SendGridCreds {
  apiKey: string;
  fromEmail: string;
  fromName: string;
}

async function loadSendGridCreds(ws: string): Promise<SendGridCreds | null> {
  for (const p of [
    join(ws, "businesses", "vividwalls", "integrations.json"),
    join(ws, "integrations.json"),
  ]) {
    const data = await readJson(p);
    const entry = (data?.integrations || []).find(
      (i: any) => i.id === "sendgrid-main" && i.enabled,
    );
    if (entry?.api_key) {
      return {
        apiKey: entry.api_key,
        fromEmail: entry.metadata?.from_email || "noreply@vividwalls.co",
        fromName: entry.metadata?.from_name || "VividWalls",
      };
    }
  }
  return null;
}

// ── Email helper ───────────────────────────────────────────────────────

async function sendEmail(creds: SendGridCreds, to: string, subject: string, htmlContent: string) {
  return httpRequest(
    "https://api.sendgrid.com/v3/mail/send",
    "POST",
    {
      Authorization: `Bearer ${creds.apiKey}`,
      "Content-Type": "application/json",
    },
    {
      personalizations: [{ to: [{ email: to }] }],
      from: { email: creds.fromEmail, name: creds.fromName },
      subject,
      content: [{ type: "text/html", value: htmlContent }],
    },
  );
}

async function sendBatch(
  creds: SendGridCreds,
  recipients: string[],
  subject: string,
  htmlContent: string,
): Promise<{ sent: number; failed: number; errors: string[] }> {
  let sent = 0;
  let failed = 0;
  const errors: string[] = [];

  // SendGrid personalizations batch (max 1000 per call)
  const batchSize = 1000;
  for (let i = 0; i < recipients.length; i += batchSize) {
    const batch = recipients.slice(i, i + batchSize);
    const resp = await httpRequest(
      "https://api.sendgrid.com/v3/mail/send",
      "POST",
      {
        Authorization: `Bearer ${creds.apiKey}`,
        "Content-Type": "application/json",
      },
      {
        personalizations: batch.map((email) => ({ to: [{ email }] })),
        from: { email: creds.fromEmail, name: creds.fromName },
        subject,
        content: [{ type: "text/html", value: htmlContent }],
      },
    );

    if (resp.status >= 200 && resp.status < 300) {
      sent += batch.length;
    } else {
      failed += batch.length;
      errors.push(`Batch starting at ${i}: status ${resp.status}`);
    }
  }

  return { sent, failed, errors };
}

// ── Parameter Schemas ──────────────────────────────────────────────────

const WaitlistParams = Type.Object({
  action: Type.Union(
    [Type.Literal("add"), Type.Literal("remove"), Type.Literal("list"), Type.Literal("stats")],
    { description: "Waitlist action" },
  ),
  edition_id: Type.String({ description: "Edition identifier (e.g. chromatic-visions-2026)" }),
  email: Type.Optional(Type.String({ description: "Email address (required for add/remove)" })),
  name: Type.Optional(Type.String({ description: "Subscriber name" })),
  source: Type.Optional(Type.String({ description: "Signup source (website, instagram, etc.)" })),
});

const DripAdvanceParams = Type.Object({
  edition_id: Type.String({ description: "Edition identifier" }),
  dry_run: Type.Optional(
    Type.Boolean({ description: "If true, preview what would be sent without sending" }),
  ),
});

const EmailTriggerParams = Type.Object({
  edition_id: Type.String({ description: "Edition identifier" }),
  trigger: Type.Union(
    [Type.Literal("early_access"), Type.Literal("public_launch"), Type.Literal("scarcity_alert")],
    { description: "Launch-phase email trigger type" },
  ),
  threshold: Type.Optional(
    Type.Number({ description: "For scarcity_alert: percent remaining that triggers alert" }),
  ),
});

// ── Drip stage config ──────────────────────────────────────────────────

const DRIP_STAGES = [
  { stage: 1, delayHours: 0, subject: "You're on the list!", type: "confirmation" },
  { stage: 2, delayHours: 24, subject: "The Artist Behind the Collection", type: "artist_story" },
  {
    stage: 3,
    delayHours: 72,
    subject: "Launch countdown — your exclusive access awaits",
    type: "countdown",
  },
];

function dripHtml(type: string, editionId: string): string {
  const templates: Record<string, string> = {
    confirmation: `<h2>Welcome to the Waitlist!</h2><p>You've secured your spot for the <strong>${editionId}</strong> Limited Edition drop. We'll notify you before anyone else when it's time to shop.</p><p>— The VividWalls Team</p>`,
    artist_story: `<h2>Meet the Artist</h2><p>Every piece in the <strong>${editionId}</strong> collection tells a story. Stay tuned for an exclusive behind-the-scenes look at the creative process.</p><p>— The VividWalls Team</p>`,
    countdown: `<h2>The Countdown is On</h2><p>The <strong>${editionId}</strong> drop is almost here. As a waitlist member, you'll get early access before the public launch.</p><p>Get ready — The VividWalls Team</p>`,
  };
  return templates[type] || `<p>Update for ${editionId}</p>`;
}

// ── Tool Factory ───────────────────────────────────────────────────────

export function createLeWaitlistTools(api: OpenClawPluginApi): AnyAgentTool[] {
  const ws = resolveWorkspaceDir(api);
  const bizDir = join(ws, "businesses", "vividwalls");
  const waitlistPath = join(bizDir, "le-waitlist-state.json");
  const triggerLogPath = join(bizDir, "le-trigger-log.json");

  async function loadWaitlist() {
    return (await readJson(waitlistPath)) || { editions: {} };
  }

  async function loadTriggerLog() {
    return (await readJson(triggerLogPath)) || { triggers: [] };
  }

  function ensureEdition(state: any, editionId: string) {
    if (!state.editions[editionId]) {
      state.editions[editionId] = {
        waitlist: [],
        drip_stage: {},
        stats: { total_signups: 0, emails_sent: 0 },
      };
    }
    return state.editions[editionId];
  }

  return [
    // ── le_waitlist ────────────────────────────────────────────────
    {
      name: "le_waitlist",
      label: "LE Waitlist Management",
      description:
        "Manage Limited Edition waitlist signups. Add/remove subscribers, list current waitlist, or get signup stats.",
      parameters: WaitlistParams,
      async execute(_id: string, params: Static<typeof WaitlistParams>) {
        const state = await loadWaitlist();
        const ed = ensureEdition(state, params.edition_id);

        switch (params.action) {
          case "add": {
            if (!params.email) return textResult("**Error:** email is required for add action.");
            const exists = ed.waitlist.some(
              (w: any) => w.email.toLowerCase() === params.email!.toLowerCase(),
            );
            if (exists) return textResult(`**Already on waitlist:** ${params.email}`);
            ed.waitlist.push({
              email: params.email,
              name: params.name || "",
              source: params.source || "direct",
              signed_up_at: new Date().toISOString(),
            });
            ed.drip_stage[params.email.toLowerCase()] = 0;
            ed.stats.total_signups = ed.waitlist.length;
            await writeJson(waitlistPath, state);
            return textResult(
              `**Added** ${params.email} to ${params.edition_id} waitlist (total: ${ed.waitlist.length}).`,
            );
          }

          case "remove": {
            if (!params.email) return textResult("**Error:** email is required for remove action.");
            const before = ed.waitlist.length;
            ed.waitlist = ed.waitlist.filter(
              (w: any) => w.email.toLowerCase() !== params.email!.toLowerCase(),
            );
            delete ed.drip_stage[params.email.toLowerCase()];
            ed.stats.total_signups = ed.waitlist.length;
            await writeJson(waitlistPath, state);
            const removed = before - ed.waitlist.length;
            return textResult(
              removed > 0
                ? `**Removed** ${params.email} from ${params.edition_id} waitlist.`
                : `**Not found:** ${params.email} was not on the waitlist.`,
            );
          }

          case "list": {
            if (!ed.waitlist.length)
              return textResult(`No subscribers on ${params.edition_id} waitlist.`);
            const rows = ed.waitlist.map(
              (w: any) =>
                `| ${w.email} | ${w.name || "—"} | ${w.source} | Stage ${ed.drip_stage[w.email.toLowerCase()] ?? 0} | ${w.signed_up_at} |`,
            );
            return textResult(
              `## ${params.edition_id} Waitlist (${ed.waitlist.length})\n\n` +
                `| Email | Name | Source | Drip Stage | Signed Up |\n|-------|------|--------|------------|----------|\n` +
                rows.join("\n"),
            );
          }

          case "stats": {
            const sources: Record<string, number> = {};
            const stages: Record<number, number> = {};
            for (const w of ed.waitlist) {
              sources[w.source] = (sources[w.source] || 0) + 1;
              const st = ed.drip_stage[w.email.toLowerCase()] ?? 0;
              stages[st] = (stages[st] || 0) + 1;
            }
            return textResult(
              `## ${params.edition_id} Waitlist Stats\n\n` +
                `- **Total signups:** ${ed.waitlist.length}\n` +
                `- **Emails sent:** ${ed.stats.emails_sent}\n\n` +
                `**Sources:** ${Object.entries(sources)
                  .map(([k, v]) => `${k}: ${v}`)
                  .join(", ")}\n\n` +
                `**Drip stages:** ${Object.entries(stages)
                  .map(([k, v]) => `Stage ${k}: ${v}`)
                  .join(", ")}`,
            );
          }
        }
      },
    },

    // ── le_drip_advance ────────────────────────────────────────────
    {
      name: "le_drip_advance",
      label: "LE Drip Email Advance",
      description:
        "Advance drip email sequences for LE waitlist subscribers. Checks time since signup and sends the next email in sequence. Use dry_run=true to preview without sending.",
      parameters: DripAdvanceParams,
      async execute(_id: string, params: Static<typeof DripAdvanceParams>) {
        const state = await loadWaitlist();
        const ed = state.editions[params.edition_id];
        if (!ed?.waitlist?.length) {
          return textResult(`No waitlist found for edition ${params.edition_id}.`);
        }

        const sgCreds = await loadSendGridCreds(ws);
        if (!sgCreds && !params.dry_run) {
          return textResult(
            "**Error:** SendGrid credentials not found. Add sendgrid-main to integrations.json.",
          );
        }

        const now = Date.now();
        const actions: {
          email: string;
          from: number;
          to: number;
          type: string;
          subject: string;
        }[] = [];

        for (const sub of ed.waitlist) {
          const emailKey = sub.email.toLowerCase();
          const currentStage = ed.drip_stage[emailKey] ?? 0;
          const signupTime = new Date(sub.signed_up_at).getTime();
          const hoursSinceSignup = (now - signupTime) / (1000 * 60 * 60);

          // Find next stage they qualify for
          for (const stage of DRIP_STAGES) {
            if (stage.stage > currentStage && hoursSinceSignup >= stage.delayHours) {
              actions.push({
                email: sub.email,
                from: currentStage,
                to: stage.stage,
                type: stage.type,
                subject: stage.subject,
              });
              // Only advance one stage at a time
              break;
            }
          }
        }

        if (!actions.length) {
          return textResult(
            `No drip emails pending for ${params.edition_id}. All subscribers are up to date.`,
          );
        }

        if (params.dry_run) {
          const rows = actions.map(
            (a) => `| ${a.email} | ${a.from} → ${a.to} | ${a.type} | ${a.subject} |`,
          );
          return textResult(
            `## Dry Run — ${actions.length} emails would be sent\n\n` +
              `| Email | Stage | Type | Subject |\n|-------|-------|------|---------|\n` +
              rows.join("\n"),
          );
        }

        // Send emails
        const log = await loadTriggerLog();
        let sent = 0;
        let failed = 0;

        for (const action of actions) {
          const html = dripHtml(action.type, params.edition_id);
          const resp = await sendEmail(sgCreds!, action.email, action.subject, html);

          if (resp.status >= 200 && resp.status < 300) {
            ed.drip_stage[action.email.toLowerCase()] = action.to;
            ed.stats.emails_sent++;
            sent++;
            log.triggers.push({
              type: "drip",
              edition_id: params.edition_id,
              email: action.email,
              stage: action.to,
              sent_at: new Date().toISOString(),
            });
          } else {
            failed++;
          }
        }

        await writeJson(waitlistPath, state);
        await writeJson(triggerLogPath, log);

        return textResult(
          `## Drip Advance Complete\n\n` +
            `- **Sent:** ${sent}\n- **Failed:** ${failed}\n- **Edition:** ${params.edition_id}`,
        );
      },
    },

    // ── le_email_trigger ───────────────────────────────────────────
    {
      name: "le_email_trigger",
      label: "LE Launch Email Trigger",
      description:
        "Fire launch-phase emails: early_access (24h pre-launch to waitlist), public_launch (full list), or scarcity_alert (when stock hits threshold).",
      parameters: EmailTriggerParams,
      async execute(_id: string, params: Static<typeof EmailTriggerParams>) {
        const state = await loadWaitlist();
        const ed = state.editions[params.edition_id];
        if (!ed?.waitlist?.length) {
          return textResult(`No waitlist found for edition ${params.edition_id}.`);
        }

        const sgCreds = await loadSendGridCreds(ws);
        if (!sgCreds) {
          return textResult("**Error:** SendGrid credentials not found.");
        }

        // Deduplicate: check trigger log
        const log = await loadTriggerLog();
        const alreadySent = log.triggers.some(
          (t: any) => t.type === params.trigger && t.edition_id === params.edition_id,
        );
        if (alreadySent && params.trigger !== "scarcity_alert") {
          return textResult(
            `**Already sent:** ${params.trigger} for ${params.edition_id}. Skipping to prevent duplicate sends.`,
          );
        }

        const recipients = ed.waitlist.map((w: any) => w.email);
        let subject: string;
        let html: string;

        switch (params.trigger) {
          case "early_access":
            subject = `Early Access: ${params.edition_id} — You're first in line`;
            html = `<h2>Your Early Access is Live!</h2><p>As a waitlist member, you get <strong>24 hours of exclusive access</strong> to the <strong>${params.edition_id}</strong> collection before the public launch.</p><p><a href="https://vividwalls.co/collections/${params.edition_id}">Shop Now →</a></p><p>— The VividWalls Team</p>`;
            break;
          case "public_launch":
            subject = `Now Live: ${params.edition_id} Limited Edition`;
            html = `<h2>It's Here!</h2><p>The <strong>${params.edition_id}</strong> Limited Edition collection is now available to everyone. Don't wait — once they're gone, they're gone.</p><p><a href="https://vividwalls.co/collections/${params.edition_id}">Shop the Collection →</a></p><p>— The VividWalls Team</p>`;
            break;
          case "scarcity_alert": {
            const pct = params.threshold ?? 25;
            subject = `Only ${pct}% remaining: ${params.edition_id}`;
            html = `<h2>Almost Gone</h2><p>The <strong>${params.edition_id}</strong> collection is selling fast — only <strong>${pct}%</strong> of pieces remain. Secure yours before they're gone forever.</p><p><a href="https://vividwalls.co/collections/${params.edition_id}">Shop Now →</a></p><p>— The VividWalls Team</p>`;
            // Check for duplicate scarcity at same threshold
            const scarcityDupe = log.triggers.some(
              (t: any) =>
                t.type === "scarcity_alert" &&
                t.edition_id === params.edition_id &&
                t.threshold === pct,
            );
            if (scarcityDupe) {
              return textResult(
                `**Already sent** scarcity alert at ${pct}% for ${params.edition_id}.`,
              );
            }
            break;
          }
        }

        const result = await sendBatch(sgCreds, recipients, subject!, html!);

        log.triggers.push({
          type: params.trigger,
          edition_id: params.edition_id,
          recipients_count: recipients.length,
          sent: result.sent,
          failed: result.failed,
          threshold: params.trigger === "scarcity_alert" ? (params.threshold ?? 25) : undefined,
          sent_at: new Date().toISOString(),
        });
        ed.stats.emails_sent += result.sent;

        await writeJson(waitlistPath, state);
        await writeJson(triggerLogPath, log);

        return textResult(
          `## ${params.trigger} Email Sent\n\n` +
            `- **Edition:** ${params.edition_id}\n` +
            `- **Recipients:** ${recipients.length}\n` +
            `- **Sent:** ${result.sent}\n` +
            `- **Failed:** ${result.failed}` +
            (result.errors.length ? `\n- **Errors:** ${result.errors.join("; ")}` : ""),
        );
      },
    },
  ];
}
