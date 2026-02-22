"use client";

import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { RefreshCw, ExternalLink, ChevronDown, ChevronUp, AlertTriangle, Bot } from "lucide-react";

const CHANNEL_DISPLAY: Record<string, { emoji: string; color: string; desc: string }> = {
  telegram: { emoji: "✈️", color: "text-blue-400", desc: "Send and receive messages via Telegram bots" },
  whatsapp: { emoji: "💬", color: "text-green-400", desc: "Business messaging through WhatsApp Web" },
  discord: { emoji: "🎮", color: "text-indigo-400", desc: "Bot integration for Discord servers" },
  slack: { emoji: "💼", color: "text-purple-400", desc: "Workspace messaging via Slack apps" },
  signal: { emoji: "🔒", color: "text-sky-400", desc: "Privacy-focused encrypted messaging" },
  imessage: { emoji: "🍎", color: "text-gray-400", desc: "Apple iMessage integration (macOS only)" },
  line: { emoji: "🟢", color: "text-lime-400", desc: "LINE messaging platform integration" },
};

const GATEWAY_URL = "http://127.0.0.1:18789";

interface ChannelMeta {
  id: string;
  label: string;
  detailLabel: string;
  systemImage: string;
}

interface ChannelStatus {
  configured: boolean;
  running: boolean;
  connected?: boolean;
  linked?: boolean;
  lastError?: string | null;
  lastStartAt?: string | null;
  lastStopAt?: string | null;
  lastMessageAt?: string | null;
  lastEventAt?: string | null;
  lastProbeAt?: string | null;
  [key: string]: unknown;
}

interface ChannelAccount {
  accountId: string;
  enabled: boolean;
  configured: boolean;
  running: boolean;
  connected?: boolean;
  lastError?: string | null;
  lastInboundAt?: string | null;
  lastOutboundAt?: string | null;
  [key: string]: unknown;
}

interface ChannelsApiResponse {
  channelMeta?: ChannelMeta[];
  channels?: Record<string, ChannelStatus>;
  channelAccounts?: Record<string, ChannelAccount[]>;
  channelOrder?: string[];
  degraded?: boolean;
  warning?: string;
}

function deriveStatus(ch: ChannelStatus): "connected" | "disconnected" | "not_configured" | "error" {
  if (!ch.configured && !ch.linked) {return "not_configured";}
  if (ch.running && (ch.connected !== false)) {return "connected";}
  if (ch.lastError && ch.lastError !== "not configured" && ch.lastError !== "not linked") {return "error";}
  return "disconnected";
}

function StatusBadge({ status }: { status: ReturnType<typeof deriveStatus> }) {
  switch (status) {
    case "connected":
      return (
        <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-green-500/20 text-green-500">
          <span className="w-1.5 h-1.5 rounded-full bg-green-500" />
          Connected
        </span>
      );
    case "disconnected":
      return (
        <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-400">
          <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />
          Disconnected
        </span>
      );
    case "error":
      return (
        <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-red-500/20 text-red-500">
          <span className="w-1.5 h-1.5 rounded-full bg-red-500" />
          Error
        </span>
      );
    default:
      return (
        <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-muted text-muted-foreground">
          <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground" />
          Not Configured
        </span>
      );
  }
}

export function ChannelsView() {
  const [data, setData] = useState<ChannelsApiResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showGuide, setShowGuide] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const fetchChannels = async () => {
    try {
      setError(null);
      const response = await fetch("/api/openclaw/channels");
      if (!response.ok) {throw new Error(`Failed to fetch channels: ${response.statusText}`);}
      const json: ChannelsApiResponse = await response.json();
      setData(json);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch channels");
      setData(null);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  const handleRefresh = () => {
    setRefreshing(true);
    fetchChannels();
  };

  useEffect(() => {
    fetchChannels();
    const interval = setInterval(fetchChannels, 30000);
    return () => clearInterval(interval);
  }, []);

  // Build channel list from API response
  const channelOrder = data?.channelOrder ?? [];
  const channelMeta = data?.channelMeta ?? [];
  const channels = data?.channels ?? {};
  const accounts = data?.channelAccounts ?? {};

  // Use channelMeta for display, fall back to channelOrder
  const channelList = channelMeta.length > 0
    ? channelMeta
    : channelOrder.map((id) => ({ id, label: id, detailLabel: id, systemImage: "" }));

  const connectedCount = channelList.filter((ch) => {
    const status = channels[ch.id];
    return status && deriveStatus(status) === "connected";
  }).length;

  const configuredCount = channelList.filter((ch) => {
    const status = channels[ch.id];
    return status?.configured || status?.linked;
  }).length;

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-muted-foreground">Loading channels...</div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div className="space-y-1">
          <h2 className="text-xl font-bold flex items-center gap-2">
            <span>📡</span>
            Channels Dashboard
          </h2>
          <p className="text-sm text-muted-foreground max-w-3xl">
            Messaging channels managed by the OpenClaw gateway. Configure accounts in the{" "}
            <a href={GATEWAY_URL} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
              built-in dashboard
            </a>
            , then use them to send and receive messages from your agents.
          </p>
        </div>
        <Button
          onClick={handleRefresh}
          disabled={refreshing}
          variant="outline"
          size="sm"
          aria-label="Refresh channels status"
        >
          <RefreshCw className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`} />
        </Button>
      </div>

      {/* Error State */}
      {error && (
        <div className="glass-panel rounded-xl p-5 border-amber-500/50 bg-amber-500/10">
          <div className="flex items-center gap-3">
            <AlertTriangle className="h-5 w-5 text-amber-500" />
            <div>
              <p className="font-medium text-amber-500">Failed to load channels</p>
              <p className="text-sm text-muted-foreground">{error}</p>
            </div>
          </div>
        </div>
      )}

      {/* Degraded State Banner */}
      {data?.degraded && (
        <div className="glass-panel rounded-xl p-5 border-amber-500/50 bg-amber-500/10">
          <div className="flex items-center gap-3">
            <AlertTriangle className="h-5 w-5 text-amber-500" />
            <div>
              <p className="font-medium text-amber-500">Gateway Offline</p>
              <p className="text-sm text-muted-foreground">
                {data.warning || "The OpenClaw gateway is not responding. Channels may be unavailable."}
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Stats Ribbon */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="glass-panel rounded-xl p-5">
          <div className="text-2xl font-bold text-primary">{channelList.length}</div>
          <div className="text-sm text-muted-foreground">Total Channels</div>
        </div>
        <div className="glass-panel rounded-xl p-5">
          <div className="text-2xl font-bold text-green-500">{connectedCount}</div>
          <div className="text-sm text-muted-foreground">Connected</div>
        </div>
        <div className="glass-panel rounded-xl p-5">
          <div className="text-2xl font-bold text-muted-foreground">{configuredCount}</div>
          <div className="text-sm text-muted-foreground">Configured</div>
        </div>
        <div className="glass-panel rounded-xl p-5 flex flex-col justify-center">
          <a
            href={GATEWAY_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm text-primary hover:underline flex items-center gap-1"
          >
            Open Gateway
            <ExternalLink className="h-3 w-3" />
          </a>
        </div>
      </div>

      {/* Channel Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {channelList.map((meta) => {
          const chStatus = channels[meta.id];
          const status = chStatus ? deriveStatus(chStatus) : "not_configured";
          const display = CHANNEL_DISPLAY[meta.id];
          const chAccounts = accounts[meta.id] ?? [];
          const activeAccounts = chAccounts.filter((a) => a.enabled);

          return (
            <div key={meta.id} className="glass-panel rounded-xl p-5">
              <div className="flex items-start justify-between mb-3">
                <div className="flex items-center gap-3">
                  <span className="text-2xl">{display?.emoji ?? "📨"}</span>
                  <div>
                    <h3 className={`font-semibold ${display?.color ?? "text-foreground"}`}>
                      {meta.label}
                    </h3>
                    <p className="text-xs text-muted-foreground">{meta.detailLabel}</p>
                    <div className="mt-1">
                      <StatusBadge status={status} />
                    </div>
                  </div>
                </div>
              </div>

              <p className="text-sm text-muted-foreground mb-3">
                {display?.desc ?? `${meta.label} messaging integration`}
              </p>

              {/* Account info */}
              {activeAccounts.length > 0 && (
                <div className="text-xs text-muted-foreground mb-2">
                  {activeAccounts.length} account{activeAccounts.length > 1 ? "s" : ""} configured
                </div>
              )}

              {/* Error display */}
              {chStatus?.lastError && chStatus.lastError !== "not configured" && chStatus.lastError !== "not linked" && (
                <p className="text-xs text-red-400 mb-3">{chStatus.lastError}</p>
              )}

              <div className="flex items-center gap-4">
                <a
                  href={GATEWAY_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm text-primary hover:underline flex items-center gap-1"
                >
                  Configure in Gateway
                  <ExternalLink className="h-3 w-3" />
                </a>
                <button
                  onClick={() => { window.location.hash = "agents"; }}
                  className="text-sm text-muted-foreground hover:text-foreground hover:underline flex items-center gap-1 transition-colors"
                >
                  <Bot className="h-3 w-3" />
                  Assign to Agent
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {/* Setup Guide */}
      <div className="glass-panel rounded-xl p-5">
        <button
          onClick={() => setShowGuide(!showGuide)}
          className="w-full flex items-center justify-between text-left"
        >
          <h3 className="font-semibold flex items-center gap-2">
            <span>💡</span>
            How to set up channels
          </h3>
          {showGuide ? (
            <ChevronUp className="h-4 w-4 text-muted-foreground" />
          ) : (
            <ChevronDown className="h-4 w-4 text-muted-foreground" />
          )}
        </button>

        {showGuide && (
          <div className="mt-4 space-y-3 text-sm">
            <div className="flex gap-3">
              <div className="flex-shrink-0 w-6 h-6 rounded-full bg-primary/20 text-primary flex items-center justify-center text-xs font-bold">
                1
              </div>
              <div>
                <p className="font-medium">Open the gateway dashboard</p>
                <a
                  href={GATEWAY_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary hover:underline flex items-center gap-1 mt-1"
                >
                  {GATEWAY_URL}
                  <ExternalLink className="h-3 w-3" />
                </a>
              </div>
            </div>

            <div className="flex gap-3">
              <div className="flex-shrink-0 w-6 h-6 rounded-full bg-primary/20 text-primary flex items-center justify-center text-xs font-bold">
                2
              </div>
              <div>
                <p className="font-medium">Add your messaging account credentials</p>
                <p className="text-muted-foreground mt-1">
                  Each channel requires different authentication (API keys, bot tokens, OAuth, etc.)
                </p>
              </div>
            </div>

            <div className="flex gap-3">
              <div className="flex-shrink-0 w-6 h-6 rounded-full bg-primary/20 text-primary flex items-center justify-center text-xs font-bold">
                3
              </div>
              <div>
                <p className="font-medium">Channels will appear here automatically</p>
                <p className="text-muted-foreground mt-1">
                  Once configured in the gateway, channels will be detected and shown on this dashboard with real-time status
                </p>
              </div>
            </div>

            <div className="flex gap-3">
              <div className="flex-shrink-0 w-6 h-6 rounded-full bg-primary/20 text-primary flex items-center justify-center text-xs font-bold">
                4
              </div>
              <div>
                <p className="font-medium">Your agents can then send and receive messages</p>
                <p className="text-muted-foreground mt-1">
                  Connected channels become available to all agents for notifications and conversations
                </p>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
