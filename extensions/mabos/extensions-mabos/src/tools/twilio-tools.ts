/**
 * Twilio SMS Tools — Send SMS, check delivery status, bulk messaging, delivery notifications
 *
 * Reads credentials from integrations.json → "twilio-sms" entry.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Type, type Static } from "@sinclair/typebox";
import type { OpenClawPluginApi, AnyAgentTool } from "openclaw/plugin-sdk";
import { httpRequest, textResult, resolveWorkspaceDir } from "./common.js";

// ── Credential loader ──────────────────────────────────────────────────

interface TwilioCreds {
  accountSid: string;
  authToken: string;
  phoneNumber: string;
}

async function loadTwilioCreds(api: OpenClawPluginApi): Promise<TwilioCreds | null> {
  const ws = resolveWorkspaceDir(api);
  const paths = [
    join(ws, "businesses", "vividwalls", "integrations.json"),
    join(ws, "integrations.json"),
  ];
  for (const p of paths) {
    try {
      const data = JSON.parse(await readFile(p, "utf-8"));
      const entry = (data.integrations || []).find((i: any) => i.id === "twilio-sms" && i.enabled);
      if (entry?.api_key && entry?.metadata?.account_sid) {
        return {
          accountSid: entry.metadata.account_sid,
          authToken: entry.api_key,
          phoneNumber: entry.metadata.phone_number || "+18568884216",
        };
      }
    } catch {}
  }
  return null;
}

async function twilioPost(
  creds: TwilioCreds,
  endpoint: string,
  formData: Record<string, string>,
): Promise<{ status: number; data: unknown }> {
  const url = `https://api.twilio.com/2010-04-01/Accounts/${creds.accountSid}${endpoint}`;
  const body = new URLSearchParams(formData).toString();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        Authorization:
          "Basic " + Buffer.from(`${creds.accountSid}:${creds.authToken}`).toString("base64"),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
      signal: controller.signal,
    });
    const data = await resp.json().catch(() => resp.text());
    return { status: resp.status, data };
  } catch (err) {
    return { status: 0, data: { error: String(err) } };
  } finally {
    clearTimeout(timer);
  }
}

function twilioAuth(sid: string, token: string) {
  return { Authorization: "Basic " + Buffer.from(`${sid}:${token}`).toString("base64") };
}

async function twilioGet(
  creds: TwilioCreds,
  endpoint: string,
): Promise<{ status: number; data: unknown }> {
  const url = `https://api.twilio.com/2010-04-01/Accounts/${creds.accountSid}${endpoint}`;
  return httpRequest(url, "GET", twilioAuth(creds.accountSid, creds.authToken), undefined, 10000);
}

// ── Parameter Schemas ──────────────────────────────────────────────────

const SmsSendParams = Type.Object({
  to: Type.String({ description: "Recipient phone number in E.164 format (e.g. +15551234567)" }),
  body: Type.String({ description: "SMS message body (max 1600 chars)" }),
  from: Type.Optional(Type.String({ description: "Sender phone number (defaults to configured)" })),
});

const SmsSendBulkParams = Type.Object({
  recipients: Type.Array(
    Type.Object({
      to: Type.String({ description: "Phone number in E.164 format" }),
      body: Type.String({ description: "Message body" }),
    }),
    { description: "List of recipients with messages", maxItems: 50 },
  ),
  from: Type.Optional(Type.String({ description: "Sender phone number override" })),
});

const SmsCheckStatusParams = Type.Object({
  message_sid: Type.String({ description: "Twilio message SID (starts with SM)" }),
});

const SmsListMessagesParams = Type.Object({
  limit: Type.Optional(Type.Number({ description: "Max messages to return (default 20)" })),
  to: Type.Optional(Type.String({ description: "Filter by recipient number" })),
  from: Type.Optional(Type.String({ description: "Filter by sender number" })),
  date_sent: Type.Optional(Type.String({ description: "Filter by date (YYYY-MM-DD)" })),
});

const SmsDeliveryNotifyParams = Type.Object({
  order_id: Type.String({ description: "Order ID to look up customer and compose notification" }),
  customer_phone: Type.String({ description: "Customer phone number in E.164 format" }),
  customer_name: Type.Optional(
    Type.String({ description: "Customer first name for personalization" }),
  ),
  status: Type.Union(
    [
      Type.Literal("confirmed"),
      Type.Literal("shipped"),
      Type.Literal("out_for_delivery"),
      Type.Literal("delivered"),
      Type.Literal("delayed"),
    ],
    { description: "Delivery status to notify about" },
  ),
  tracking_number: Type.Optional(Type.String({ description: "Tracking number to include" })),
  estimated_delivery: Type.Optional(Type.String({ description: "Estimated delivery date/time" })),
  custom_message: Type.Optional(
    Type.String({ description: "Override the default message template" }),
  ),
});

// ── Tool Factory ───────────────────────────────────────────────────────

export function createTwilioTools(api: OpenClawPluginApi): AnyAgentTool[] {
  return [
    {
      name: "sms_send",
      label: "Send SMS",
      description:
        "Send an SMS message to a phone number. Use for delivery updates, " +
        "order confirmations, appointment reminders, or customer notifications.",
      parameters: SmsSendParams,
      async execute(_id: string, params: Static<typeof SmsSendParams>) {
        const creds = await loadTwilioCreds(api);
        if (!creds)
          return textResult("Twilio not configured. Add twilio-sms to integrations.json.");

        if (params.body.length > 1600) {
          return textResult("Message body exceeds 1600 character limit.");
        }

        const res = await twilioPost(creds, "/Messages.json", {
          To: params.to,
          From: params.from || creds.phoneNumber,
          Body: params.body,
        });

        if (res.status === 201) {
          const msg = res.data as any;
          return textResult(
            `SMS sent to ${params.to}\nSID: ${msg.sid}\nStatus: ${msg.status}\nSegments: ${msg.num_segments || 1}`,
          );
        }
        return textResult(`Twilio error (${res.status}): ${JSON.stringify(res.data)}`);
      },
    },

    {
      name: "sms_send_bulk",
      label: "Send Bulk SMS",
      description:
        "Send SMS messages to multiple recipients (max 50). " +
        "Each recipient can have a personalized message.",
      parameters: SmsSendBulkParams,
      async execute(_id: string, params: Static<typeof SmsSendBulkParams>) {
        const creds = await loadTwilioCreds(api);
        if (!creds) return textResult("Twilio not configured.");

        if (params.recipients.length > 50) {
          return textResult("Maximum 50 recipients per bulk send.");
        }

        const results: { to: string; status: string; sid?: string; error?: string }[] = [];

        for (const r of params.recipients) {
          const res = await twilioPost(creds, "/Messages.json", {
            To: r.to,
            From: params.from || creds.phoneNumber,
            Body: r.body,
          });

          if (res.status === 201) {
            const msg = res.data as any;
            results.push({ to: r.to, status: msg.status, sid: msg.sid });
          } else {
            results.push({ to: r.to, status: "failed", error: JSON.stringify(res.data) });
          }
        }

        const sent = results.filter((r) => r.status !== "failed").length;
        const failed = results.length - sent;
        const summary = results
          .map(
            (r) =>
              `- ${r.to}: ${r.status}${r.sid ? ` (${r.sid})` : ""}${r.error ? ` -- ${r.error}` : ""}`,
          )
          .join("\n");

        return textResult(
          `## Bulk SMS Results\n\n**Sent:** ${sent} | **Failed:** ${failed}\n\n${summary}`,
        );
      },
    },

    {
      name: "sms_check_status",
      label: "Check SMS Status",
      description: "Check the delivery status of a previously sent SMS message by its SID.",
      parameters: SmsCheckStatusParams,
      async execute(_id: string, params: Static<typeof SmsCheckStatusParams>) {
        const creds = await loadTwilioCreds(api);
        if (!creds) return textResult("Twilio not configured.");

        const res = await twilioGet(
          creds,
          `/Messages/${encodeURIComponent(params.message_sid)}.json`,
        );

        if (res.status === 200) {
          const msg = res.data as any;
          return textResult(
            `## SMS Status\n\n- **SID:** ${msg.sid}\n- **To:** ${msg.to}\n- **From:** ${msg.from}\n- **Status:** ${msg.status}\n- **Direction:** ${msg.direction}\n- **Sent:** ${msg.date_sent || "pending"}\n- **Price:** ${msg.price ? `$${msg.price}` : "N/A"}\n- **Error:** ${msg.error_message || "None"}`,
          );
        }
        return textResult(`Twilio error (${res.status}): ${JSON.stringify(res.data)}`);
      },
    },

    {
      name: "sms_list_messages",
      label: "List SMS Messages",
      description: "List recent sent and received SMS messages with optional filters.",
      parameters: SmsListMessagesParams,
      async execute(_id: string, params: Static<typeof SmsListMessagesParams>) {
        const creds = await loadTwilioCreds(api);
        if (!creds) return textResult("Twilio not configured.");

        const qs = new URLSearchParams();
        qs.set("PageSize", String(params.limit || 20));
        if (params.to) qs.set("To", params.to);
        if (params.from) qs.set("From", params.from);
        if (params.date_sent) qs.set("DateSent", params.date_sent);

        const res = await twilioGet(creds, `/Messages.json?${qs.toString()}`);

        if (res.status !== 200) {
          return textResult(`Twilio error (${res.status}): ${JSON.stringify(res.data)}`);
        }

        const messages = (res.data as any)?.messages || [];
        if (messages.length === 0) return textResult("No messages found.");

        const list = messages
          .slice(0, 20)
          .map(
            (m: any, i: number) =>
              `${i + 1}. **${m.direction}** ${m.from} -> ${m.to} | ${m.status} | ${m.date_sent || "pending"}\n   "${(m.body || "").slice(0, 80)}${(m.body || "").length > 80 ? "..." : ""}"`,
          )
          .join("\n");

        return textResult(`## SMS Messages (${messages.length})\n\n${list}`);
      },
    },

    {
      name: "sms_delivery_notify",
      label: "SMS Delivery Notification",
      description:
        "Send a delivery status notification SMS to a customer. " +
        "Composes a professional message based on order status (confirmed, shipped, " +
        "out_for_delivery, delivered, delayed). Includes tracking info when available.",
      parameters: SmsDeliveryNotifyParams,
      async execute(_id: string, params: Static<typeof SmsDeliveryNotifyParams>) {
        const creds = await loadTwilioCreds(api);
        if (!creds) return textResult("Twilio not configured.");

        const name = params.customer_name || "there";
        let body: string;

        if (params.custom_message) {
          body = params.custom_message;
        } else {
          const templates: Record<string, string> = {
            confirmed: `Hi ${name}! Your VividWalls order #${params.order_id} has been confirmed. We're preparing your items!`,
            shipped: `Hi ${name}! Great news - your VividWalls order #${params.order_id} has shipped!${params.tracking_number ? ` Track it: ${params.tracking_number}` : ""}${params.estimated_delivery ? ` Est. delivery: ${params.estimated_delivery}` : ""}`,
            out_for_delivery: `Hi ${name}! Your VividWalls order #${params.order_id} is out for delivery today!`,
            delivered: `Hi ${name}! Your VividWalls order #${params.order_id} has been delivered. Enjoy your new wall art! Questions? Reply to this text.`,
            delayed: `Hi ${name}, we wanted to let you know your VividWalls order #${params.order_id} is experiencing a slight delay.${params.estimated_delivery ? ` New est. delivery: ${params.estimated_delivery}.` : ""} We apologize for the inconvenience.`,
          };
          body =
            templates[params.status] ||
            `VividWalls order #${params.order_id} update: ${params.status}`;
        }

        const res = await twilioPost(creds, "/Messages.json", {
          To: params.customer_phone,
          From: creds.phoneNumber,
          Body: body,
        });

        if (res.status === 201) {
          const msg = res.data as any;
          return textResult(
            `Delivery notification sent to ${params.customer_phone}\nOrder: #${params.order_id}\nStatus: ${params.status}\nSMS SID: ${msg.sid}`,
          );
        }
        return textResult(`Twilio error (${res.status}): ${JSON.stringify(res.data)}`);
      },
    },
  ];
}
