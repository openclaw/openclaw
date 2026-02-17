import { Hono } from "hono";
import type { Env } from "../env.js";
import {
  getConnectionByProviderAndExternalId,
  getInstance,
  insertEventLog,
} from "../db/queries.js";
import { forwardTobridge } from "../proxy/forward.js";
import { verifySlackSignature } from "../proxy/verify.js";

export function createEventsRoute(env: Env) {
  const events = new Hono();

  events.post("/slack/events", async (c) => {
    const rawBody = await c.req.text();

    // Verify Slack signature
    const valid = verifySlackSignature({
      signingSecret: env.SLACK_SIGNING_SECRET,
      signature: c.req.header("x-slack-signature"),
      timestamp: c.req.header("x-slack-request-timestamp"),
      rawBody,
    });

    if (!valid) {
      return c.json({ error: "Invalid signature" }, 401);
    }

    // Parse body
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(rawBody) as Record<string, unknown>;
    } catch {
      return c.json({ error: "Invalid JSON" }, 400);
    }

    // Determine event type
    const eventType =
      (body.type as string) ??
      (body.event as Record<string, unknown> | undefined)?.type ??
      "unknown";

    // Handle url_verification challenge directly
    if (body.type === "url_verification") {
      insertEventLog({
        provider: "slack",
        eventType: "url_verification",
        status: "challenge",
      });
      return c.json({ challenge: body.challenge });
    }

    // Extract team_id — can be at top level or inside event
    const teamId =
      (body.team_id as string) ?? (body.event as Record<string, unknown> | undefined)?.team;
    if (!teamId || typeof teamId !== "string") {
      return c.json({ error: "Missing team_id" }, 400);
    }

    // Look up connection → instance → bridge_url
    const connection = getConnectionByProviderAndExternalId("slack", teamId);
    if (!connection) {
      insertEventLog({
        provider: "slack",
        externalId: teamId,
        eventType: String(eventType),
        status: "no_route",
      });
      return c.json({ error: "Unknown team" }, 404);
    }

    const instance = getInstance(connection.instanceId);
    if (!instance) {
      insertEventLog({
        provider: "slack",
        externalId: teamId,
        connectionId: connection.id,
        eventType: String(eventType),
        status: "no_route",
      });
      return c.json({ error: "Instance not found" }, 404);
    }

    // Forward raw request to the gateway's HTTP receiver
    const gatewayHttpUrl = instance.gatewayUrl.replace(/^ws(s?):\/\//, "http$1://");
    const headersToForward: Record<string, string> = {
      "content-type": c.req.header("content-type") ?? "application/json",
    };
    const slackSig = c.req.header("x-slack-signature");
    if (slackSig) {
      headersToForward["x-slack-signature"] = slackSig;
    }
    const slackTs = c.req.header("x-slack-request-timestamp");
    if (slackTs) {
      headersToForward["x-slack-request-timestamp"] = slackTs;
    }

    const startMs = Date.now();
    try {
      const upstream = await forwardTobridge({
        bridgeUrl: gatewayHttpUrl,
        path: "/slack/events",
        rawBody,
        headers: headersToForward,
      });

      const latencyMs = Date.now() - startMs;
      insertEventLog({
        instanceId: instance.id,
        connectionId: connection.id,
        provider: "slack",
        externalId: teamId,
        eventType: String(eventType),
        status: "delivered",
        responseStatus: upstream.status,
        latencyMs,
      });

      // Pipe upstream response back to Slack
      return new Response(upstream.body, {
        status: upstream.status,
        headers: { "content-type": upstream.headers.get("content-type") ?? "application/json" },
      });
    } catch (err) {
      const latencyMs = Date.now() - startMs;
      console.error(`Failed to forward event to instance ${instance.id}:`, err);

      insertEventLog({
        instanceId: instance.id,
        connectionId: connection.id,
        provider: "slack",
        externalId: teamId,
        eventType: String(eventType),
        status: "failed",
        latencyMs,
      });

      return c.json({ error: "Upstream unavailable" }, 502);
    }
  });

  return events;
}
