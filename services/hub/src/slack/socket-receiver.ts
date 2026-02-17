import { SocketModeClient } from "@slack/socket-mode";
import { createHmac } from "node:crypto";
import type { Env } from "../env.js";
import {
  getConnectionByProviderAndExternalId,
  getInstance,
  insertEventLog,
} from "../db/queries.js";

let client: SocketModeClient | null = null;

/** Force IPv4 to avoid macOS resolving localhost to ::1 while Docker only binds IPv4. */
function forceIPv4(url: string): string {
  return url.replace("://localhost", "://127.0.0.1");
}

/** Forge a Slack-compatible HMAC-SHA256 signature so the gateway's Bolt HTTPReceiver accepts the request. */
function forgeSignature(signingSecret: string, timestamp: string, rawBody: string): string {
  const basestring = `v0:${timestamp}:${rawBody}`;
  return "v0=" + createHmac("sha256", signingSecret).update(basestring).digest("hex");
}

export async function startSocketReceiver(env: Env): Promise<void> {
  if (!env.SLACK_APP_TOKEN) {
    console.warn("[socket-receiver] SLACK_APP_TOKEN not set — Socket Mode disabled");
    return;
  }

  client = new SocketModeClient({ appToken: env.SLACK_APP_TOKEN });

  client.on("slack_event", async ({ body, ack }) => {
    // Acknowledge immediately so Slack doesn't retry
    await ack();

    const rawBody = JSON.stringify(body);

    // Determine event type for logging
    const bodyObj = body as Record<string, unknown>;
    const eventObj = bodyObj.event as Record<string, unknown> | undefined;
    const eventType =
      bodyObj.type === "event_callback"
        ? String(typeof eventObj?.type === "string" ? eventObj.type : "event_callback")
        : String(typeof bodyObj.type === "string" ? bodyObj.type : "unknown");

    // Extract team_id — can be at top level or inside event
    const teamId =
      ((body as Record<string, unknown>).team_id as string) ??
      ((body as Record<string, unknown>).event as Record<string, unknown> | undefined)?.team;

    if (!teamId || typeof teamId !== "string") {
      console.warn("[socket-receiver] Event missing team_id, skipping");
      insertEventLog({
        provider: "slack",
        eventType,
        status: "no_team",
      });
      return;
    }

    // Look up connection → instance
    const connection = getConnectionByProviderAndExternalId("slack", teamId);
    if (!connection) {
      insertEventLog({
        provider: "slack",
        externalId: teamId,
        eventType,
        status: "no_route",
      });
      return;
    }

    const instance = getInstance(connection.instanceId);
    if (!instance) {
      insertEventLog({
        provider: "slack",
        externalId: teamId,
        connectionId: connection.id,
        eventType,
        status: "no_route",
      });
      return;
    }

    // Forge Slack signature and forward as HTTP POST to the bridge
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = forgeSignature(env.SLACK_SIGNING_SECRET, timestamp, rawBody);
    const targetUrl = forceIPv4(`${instance.gatewayUrl.replace(/^ws/, "http")}/slack/events`);

    console.log(`[socket-receiver] ${eventType} from ${teamId} → ${targetUrl}`);
    console.log(`[socket-receiver] body: ${rawBody.slice(0, 800)}`);

    const startMs = Date.now();
    try {
      const res = await fetch(targetUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-slack-signature": signature,
          "x-slack-request-timestamp": timestamp,
        },
        body: rawBody,
      });

      const latencyMs = Date.now() - startMs;
      const statusLabel = res.ok ? "delivered" : "rejected";
      const respBody = await res.text().catch(() => "");
      console.log(
        `[socket-receiver] ${eventType} → ${res.status} ${res.statusText} (${latencyMs}ms)`,
        respBody.slice(0, 500) || "(empty body)",
      );
      insertEventLog({
        instanceId: instance.id,
        connectionId: connection.id,
        provider: "slack",
        externalId: teamId,
        eventType,
        status: statusLabel,
        responseStatus: res.status,
        latencyMs,
      });
    } catch (err) {
      const latencyMs = Date.now() - startMs;
      console.error(`[socket-receiver] ${eventType} → FAILED (${latencyMs}ms):`, err);
      insertEventLog({
        instanceId: instance.id,
        connectionId: connection.id,
        provider: "slack",
        externalId: teamId,
        eventType,
        status: "failed",
        latencyMs,
      });
    }
  });

  await client.start();
  console.log("[socket-receiver] Connected to Slack via Socket Mode");
}

export async function stopSocketReceiver(): Promise<void> {
  if (client) {
    await client.disconnect();
    client = null;
    console.log("[socket-receiver] Disconnected from Slack");
  }
}
