/**
 * SendGrid Email Tools — Transactional email, templates, contacts, and stats
 *
 * Reads credentials from integrations.json → "sendgrid-main" entry.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Type, type Static } from "@sinclair/typebox";
import type { OpenClawPluginApi, AnyAgentTool } from "openclaw/plugin-sdk";
import { httpRequest, textResult, resolveWorkspaceDir } from "./common.js";

// ── Credential loader ──────────────────────────────────────────────────

interface SendGridCreds {
  apiKey: string;
  baseUrl: string;
  fromEmail: string;
}

async function loadSendGridCreds(api: OpenClawPluginApi): Promise<SendGridCreds | null> {
  const ws = resolveWorkspaceDir(api);
  const paths = [
    join(ws, "businesses", "vividwalls", "integrations.json"),
    join(ws, "integrations.json"),
  ];
  for (const p of paths) {
    try {
      const data = JSON.parse(await readFile(p, "utf-8"));
      const entry = (data.integrations || []).find(
        (i: any) => i.id === "sendgrid-main" && i.enabled,
      );
      if (entry?.api_key) {
        return {
          apiKey: entry.api_key,
          baseUrl: (entry.base_url || "https://api.sendgrid.com").replace(/\/$/, ""),
          fromEmail: entry.metadata?.from_email || "noreply@vividwalls.co",
        };
      }
    } catch {}
  }
  return null;
}

function sgHeaders(apiKey: string) {
  return { Authorization: `Bearer ${apiKey}` };
}

// ── Parameter Schemas ──────────────────────────────────────────────────

const SendEmailParams = Type.Object({
  to: Type.String({ description: "Recipient email address" }),
  template_id: Type.String({ description: "SendGrid dynamic template ID" }),
  dynamic_data: Type.Optional(
    Type.Record(Type.String(), Type.Unknown(), {
      description: "Template variable substitutions",
    }),
  ),
  from_email: Type.Optional(Type.String({ description: "Sender email (defaults to configured)" })),
  from_name: Type.Optional(Type.String({ description: "Sender display name" })),
  subject: Type.Optional(Type.String({ description: "Subject line override" })),
});

const SendRawParams = Type.Object({
  to: Type.String({ description: "Recipient email address" }),
  subject: Type.String({ description: "Email subject line" }),
  html: Type.Optional(Type.String({ description: "HTML body" })),
  text: Type.Optional(Type.String({ description: "Plain text body" })),
  from_email: Type.Optional(Type.String()),
  from_name: Type.Optional(Type.String()),
});

const ListTemplatesParams = Type.Object({
  generations: Type.Optional(
    Type.Union([Type.Literal("legacy"), Type.Literal("dynamic")], {
      description: "Template generation filter (default: dynamic)",
    }),
  ),
  page_size: Type.Optional(Type.Number({ description: "Results per page (max 200)" })),
});

const GetTemplateParams = Type.Object({
  template_id: Type.String({ description: "SendGrid template ID" }),
});

const AddContactParams = Type.Object({
  email: Type.String({ description: "Contact email" }),
  first_name: Type.Optional(Type.String()),
  last_name: Type.Optional(Type.String()),
  list_ids: Type.Optional(Type.Array(Type.String(), { description: "Contact list IDs to add to" })),
  custom_fields: Type.Optional(Type.Record(Type.String(), Type.String())),
});

const GetStatsParams = Type.Object({
  start_date: Type.String({ description: "Start date YYYY-MM-DD" }),
  end_date: Type.Optional(Type.String({ description: "End date YYYY-MM-DD" })),
  aggregated_by: Type.Optional(
    Type.Union([Type.Literal("day"), Type.Literal("week"), Type.Literal("month")]),
  ),
});

// ── Tool Factory ───────────────────────────────────────────────────────

export function createSendGridTools(api: OpenClawPluginApi): AnyAgentTool[] {
  return [
    {
      name: "sendgrid_send_email",
      label: "SendGrid Send Template Email",
      description:
        "Send a transactional email using a SendGrid dynamic template. " +
        "Provide the template_id and dynamic_data for variable substitution.",
      parameters: SendEmailParams,
      async execute(_id: string, params: Static<typeof SendEmailParams>) {
        const creds = await loadSendGridCreds(api);
        if (!creds)
          return textResult("SendGrid not configured. Add sendgrid-main to integrations.json.");

        const payload = {
          personalizations: [
            {
              to: [{ email: params.to }],
              dynamic_template_data: params.dynamic_data || {},
              ...(params.subject ? { subject: params.subject } : {}),
            },
          ],
          from: {
            email: params.from_email || creds.fromEmail,
            name: params.from_name || "VividWalls",
          },
          template_id: params.template_id,
        };

        const res = await httpRequest(
          `${creds.baseUrl}/v3/mail/send`,
          "POST",
          sgHeaders(creds.apiKey),
          payload,
          10000,
        );

        if (res.status === 202 || res.status === 200) {
          return textResult(`Email sent to ${params.to} using template ${params.template_id}`);
        }
        return textResult(`SendGrid error (${res.status}): ${JSON.stringify(res.data)}`);
      },
    },

    {
      name: "sendgrid_send_raw",
      label: "SendGrid Send Raw Email",
      description: "Send a raw HTML/text email without a template.",
      parameters: SendRawParams,
      async execute(_id: string, params: Static<typeof SendRawParams>) {
        const creds = await loadSendGridCreds(api);
        if (!creds) return textResult("SendGrid not configured.");

        const content: { type: string; value: string }[] = [];
        if (params.text) content.push({ type: "text/plain", value: params.text });
        if (params.html) content.push({ type: "text/html", value: params.html });
        if (content.length === 0) return textResult("Provide html or text body.");

        const payload = {
          personalizations: [{ to: [{ email: params.to }] }],
          from: {
            email: params.from_email || creds.fromEmail,
            name: params.from_name || "VividWalls",
          },
          subject: params.subject,
          content,
        };

        const res = await httpRequest(
          `${creds.baseUrl}/v3/mail/send`,
          "POST",
          sgHeaders(creds.apiKey),
          payload,
          10000,
        );

        if (res.status === 202 || res.status === 200) {
          return textResult(`Raw email sent to ${params.to}: "${params.subject}"`);
        }
        return textResult(`SendGrid error (${res.status}): ${JSON.stringify(res.data)}`);
      },
    },

    {
      name: "sendgrid_list_templates",
      label: "SendGrid List Templates",
      description: "List available SendGrid dynamic email templates.",
      parameters: ListTemplatesParams,
      async execute(_id: string, params: Static<typeof ListTemplatesParams>) {
        const creds = await loadSendGridCreds(api);
        if (!creds) return textResult("SendGrid not configured.");

        const gen = params.generations || "dynamic";
        const size = params.page_size || 50;
        const res = await httpRequest(
          `${creds.baseUrl}/v3/templates?generations=${gen}&page_size=${size}`,
          "GET",
          sgHeaders(creds.apiKey),
          undefined,
          10000,
        );

        if (res.status !== 200) {
          return textResult(`SendGrid error (${res.status}): ${JSON.stringify(res.data)}`);
        }

        const templates = (res.data as any)?.result || (res.data as any)?.templates || [];
        if (templates.length === 0) return textResult("No templates found.");

        const list = templates
          .map(
            (t: any, i: number) =>
              `${i + 1}. **${t.name}** — ID: \`${t.id}\` (${t.versions?.length || 0} versions)`,
          )
          .join("\n");
        return textResult(`## SendGrid Templates (${templates.length})\n\n${list}`);
      },
    },

    {
      name: "sendgrid_get_template",
      label: "SendGrid Get Template",
      description: "Get details and versions of a specific SendGrid template.",
      parameters: GetTemplateParams,
      async execute(_id: string, params: Static<typeof GetTemplateParams>) {
        const creds = await loadSendGridCreds(api);
        if (!creds) return textResult("SendGrid not configured.");

        const res = await httpRequest(
          `${creds.baseUrl}/v3/templates/${encodeURIComponent(params.template_id)}`,
          "GET",
          sgHeaders(creds.apiKey),
          undefined,
          10000,
        );

        if (res.status !== 200) {
          return textResult(`SendGrid error (${res.status}): ${JSON.stringify(res.data)}`);
        }

        const t = res.data as any;
        const versions = (t.versions || [])
          .map(
            (v: any) =>
              `- **${v.name}** (${v.active ? "active" : "inactive"}) — updated ${v.updated_at}`,
          )
          .join("\n");
        return textResult(
          `## Template: ${t.name}\n\nID: \`${t.id}\`\nGeneration: ${t.generation}\n\n### Versions\n${versions || "No versions"}`,
        );
      },
    },

    {
      name: "sendgrid_add_contact",
      label: "SendGrid Add Contact",
      description:
        "Add or update a contact in SendGrid Marketing. Optionally add to specific lists.",
      parameters: AddContactParams,
      async execute(_id: string, params: Static<typeof AddContactParams>) {
        const creds = await loadSendGridCreds(api);
        if (!creds) return textResult("SendGrid not configured.");

        const contact: Record<string, unknown> = { email: params.email };
        if (params.first_name) contact.first_name = params.first_name;
        if (params.last_name) contact.last_name = params.last_name;
        if (params.custom_fields) contact.custom_fields = params.custom_fields;

        const payload: Record<string, unknown> = { contacts: [contact] };
        if (params.list_ids?.length) payload.list_ids = params.list_ids;

        const res = await httpRequest(
          `${creds.baseUrl}/v3/marketing/contacts`,
          "PUT",
          sgHeaders(creds.apiKey),
          payload,
          10000,
        );

        if (res.status === 202 || res.status === 200) {
          return textResult(
            `Contact ${params.email} added/updated${params.list_ids?.length ? ` to ${params.list_ids.length} list(s)` : ""}.`,
          );
        }
        return textResult(`SendGrid error (${res.status}): ${JSON.stringify(res.data)}`);
      },
    },

    {
      name: "sendgrid_get_stats",
      label: "SendGrid Email Stats",
      description: "Get email delivery, open, click, bounce, and spam report statistics.",
      parameters: GetStatsParams,
      async execute(_id: string, params: Static<typeof GetStatsParams>) {
        const creds = await loadSendGridCreds(api);
        if (!creds) return textResult("SendGrid not configured.");

        let url = `${creds.baseUrl}/v3/stats?start_date=${params.start_date}`;
        if (params.end_date) url += `&end_date=${params.end_date}`;
        if (params.aggregated_by) url += `&aggregated_by=${params.aggregated_by}`;

        const res = await httpRequest(url, "GET", sgHeaders(creds.apiKey), undefined, 10000);

        if (res.status !== 200) {
          return textResult(`SendGrid error (${res.status}): ${JSON.stringify(res.data)}`);
        }

        const stats = res.data as any[];
        if (!stats?.length) return textResult("No stats for the given period.");

        let totalRequests = 0,
          totalDelivered = 0,
          totalOpens = 0,
          totalClicks = 0,
          totalBounces = 0;
        for (const day of stats) {
          for (const m of day.stats || []) {
            const met = m.metrics || {};
            totalRequests += met.requests || 0;
            totalDelivered += met.delivered || 0;
            totalOpens += met.opens || 0;
            totalClicks += met.clicks || 0;
            totalBounces += met.bounces || 0;
          }
        }

        return textResult(
          `## Email Stats (${params.start_date} to ${params.end_date || "today"})\n\n- **Requests:** ${totalRequests}\n- **Delivered:** ${totalDelivered} (${totalRequests > 0 ? Math.round((totalDelivered / totalRequests) * 100) : 0}%)\n- **Opens:** ${totalOpens} (${totalDelivered > 0 ? Math.round((totalOpens / totalDelivered) * 100) : 0}%)\n- **Clicks:** ${totalClicks} (${totalDelivered > 0 ? Math.round((totalClicks / totalDelivered) * 100) : 0}%)\n- **Bounces:** ${totalBounces}\n- **Days covered:** ${stats.length}`,
        );
      },
    },
  ];
}
