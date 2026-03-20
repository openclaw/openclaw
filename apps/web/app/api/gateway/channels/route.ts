import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { resolveOpenClawStateDir } from "@/lib/workspace";
import { callGatewayRpc } from "@/lib/agent-runner";
import type { ChannelStatus } from "@/lib/gateway-transcript";

export const dynamic = "force-dynamic";

const KNOWN_CHANNELS = [
  "whatsapp", "telegram", "discord", "googlechat",
  "slack", "signal", "imessage", "nostr",
] as const;

function readConfiguredChannels(): Record<string, { enabled?: boolean }> {
  const configPath = join(resolveOpenClawStateDir(), "openclaw.json");
  if (!existsSync(configPath)) return {};
  try {
    const config = JSON.parse(readFileSync(configPath, "utf-8"));
    return (config.channels ?? {}) as Record<string, { enabled?: boolean }>;
  } catch {
    return {};
  }
}

export async function GET() {
  const configuredChannels = readConfiguredChannels();

  let gatewayStatus: Record<string, Record<string, unknown>> = {};
  try {
    const res = await callGatewayRpc("channels.status", { probe: false });
    if (res.ok && res.payload) {
      const payload = res.payload as Record<string, unknown>;
      const channelMeta = payload.channelMeta as Record<string, Record<string, unknown>> | undefined;
      if (channelMeta) {
        gatewayStatus = channelMeta;
      }
    }
  } catch {
    // Gateway might be unavailable; fall back to config-only status
  }

  const channels: ChannelStatus[] = [];

  for (const channelId of KNOWN_CHANNELS) {
    const channelConfig = configuredChannels[channelId];
    const gwStatus = gatewayStatus[channelId];

    const configured = !!channelConfig;
    if (!configured && !gwStatus) continue;

    const enabled = channelConfig?.enabled !== false;

    channels.push({
      id: channelId,
      configured,
      running: enabled && (gwStatus?.running as boolean ?? false),
      connected: gwStatus?.connected as boolean ?? false,
      error: gwStatus?.error as string | undefined,
      lastMessage: gwStatus?.lastMessageAt as number | undefined,
    });
  }

  return Response.json({ channels });
}
