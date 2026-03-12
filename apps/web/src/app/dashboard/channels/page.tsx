"use client";

import { useState, useEffect, FormEvent } from "react";
import Link from "next/link";
import Navbar from "@/components/Navbar";

// ── Types ──────────────────────────────────────────────────────────────────────

interface ChannelField {
  key: string;
  label: string;
  placeholder: string;
  type?: "text" | "password";
  hint?: string;
}

interface ChannelDef {
  id: string;
  label: string;
  icon: string;
  configKey: string; // key under channels.*
  fields: ChannelField[];
  docsUrl?: string;
}

const CHANNELS: ChannelDef[] = [
  {
    id: "telegram",
    label: "Telegram",
    icon: "✈️",
    configKey: "telegram",
    docsUrl: "https://docs.openclaw.ai/channels/telegram",
    fields: [
      {
        key: "botToken",
        label: "Bot token",
        placeholder: "123456:ABC-DEF...",
        type: "password",
        hint: "Get from @BotFather on Telegram",
      },
    ],
  },
  {
    id: "discord",
    label: "Discord",
    icon: "🎮",
    configKey: "discord",
    docsUrl: "https://docs.openclaw.ai/channels/discord",
    fields: [
      {
        key: "token",
        label: "Bot token",
        placeholder: "MTI3...",
        type: "password",
        hint: "From Discord Developer Portal → Bot → Token",
      },
    ],
  },
  {
    id: "slack",
    label: "Slack",
    icon: "🟣",
    configKey: "slack",
    docsUrl: "https://docs.openclaw.ai/channels/slack",
    fields: [
      {
        key: "botToken",
        label: "Bot token",
        placeholder: "xoxb-...",
        type: "password",
        hint: "OAuth & Permissions → Bot User OAuth Token",
      },
      {
        key: "appToken",
        label: "App token",
        placeholder: "xapp-...",
        type: "password",
        hint: "Basic Information → App-Level Tokens",
      },
      {
        key: "signingSecret",
        label: "Signing secret",
        placeholder: "abc123...",
        type: "password",
        hint: "Basic Information → App Credentials → Signing Secret",
      },
    ],
  },
  {
    id: "whatsapp",
    label: "WhatsApp",
    icon: "💬",
    configKey: "whatsapp",
    docsUrl: "https://docs.openclaw.ai/channels/whatsapp",
    fields: [
      {
        key: "apiKey",
        label: "API key / token",
        placeholder: "EAAG...",
        type: "password",
        hint: "Meta for Developers → WhatsApp → API setup",
      },
    ],
  },
  {
    id: "signal",
    label: "Signal",
    icon: "🔒",
    configKey: "signal",
    docsUrl: "https://docs.openclaw.ai/channels/signal",
    fields: [
      {
        key: "phoneNumber",
        label: "Phone number",
        placeholder: "+12025551234",
        hint: "The number registered with signal-cli",
      },
    ],
  },
];

// ── Helpers ────────────────────────────────────────────────────────────────────

function dig(obj: unknown, path: string[]): unknown {
  let cur = obj as Record<string, unknown> | null;
  for (const k of path) {
    if (!cur || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[k] as Record<string, unknown>;
  }
  return cur;
}

// ── Component ──────────────────────────────────────────────────────────────────

export default function ChannelsPage() {
  const [config, setConfig] = useState<Record<string, unknown> | null>(null);
  const [baseHash, setBaseHash] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [gatewayError, setGatewayError] = useState<string | null>(null);

  // Per-channel state: values being edited, saving flag, save result
  const [values, setValues] = useState<Record<string, Record<string, string>>>({});
  const [saving, setSaving] = useState<Record<string, boolean>>({});
  const [saved, setSaved] = useState<Record<string, string | null>>({}); // null=ok, string=error

  useEffect(() => {
    fetch("/api/gateway/config")
      .then((r) => r.json())
      .then((data) => {
        if (data.error) throw new Error(data.error);

        const cfg = data.config as Record<string, unknown>;
        setConfig(cfg);
        setBaseHash(data.hash ?? "");

        // Pre-fill form values from current gateway config
        const init: Record<string, Record<string, string>> = {};
        for (const ch of CHANNELS) {
          const chCfg = (dig(cfg, ["channels", ch.configKey]) ?? {}) as Record<string, unknown>;
          const row: Record<string, string> = {};
          for (const f of ch.fields) {
            const val = chCfg[f.key];
            // Redacted values show as empty to avoid sending sentinel back
            row[f.key] = typeof val === "string" && !val.startsWith("***") ? val : "";
          }
          init[ch.id] = row;
        }
        setValues(init);
      })
      .catch((err) => setGatewayError(String(err)))
      .finally(() => setLoading(false));
  }, []);

  async function saveChannel(e: FormEvent, ch: ChannelDef) {
    e.preventDefault();
    setSaving((s) => ({ ...s, [ch.id]: true }));
    setSaved((s) => ({ ...s, [ch.id]: undefined as unknown as null }));

    const row = values[ch.id] ?? {};
    // Only send non-empty fields; omit blanks (don't overwrite with empty)
    const fields: Record<string, string | boolean> = { enabled: true };
    for (const f of ch.fields) {
      if (row[f.key]?.trim()) fields[f.key] = row[f.key].trim();
    }

    const patch = { channels: { [ch.configKey]: fields } };

    try {
      const res = await fetch("/api/gateway/config", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ patch, baseHash }),
      });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error ?? `HTTP ${res.status}`);

      // Refresh hash after patch so next save doesn't conflict
      const fresh = await fetch("/api/gateway/config").then((r) => r.json());
      if (fresh.hash) setBaseHash(fresh.hash);

      setSaved((s) => ({ ...s, [ch.id]: null }));
      setTimeout(() => setSaved((s) => ({ ...s, [ch.id]: undefined as unknown as null })), 3000);
    } catch (err) {
      setSaved((s) => ({ ...s, [ch.id]: String(err) }));
    } finally {
      setSaving((s) => ({ ...s, [ch.id]: false }));
    }
  }

  function setField(channelId: string, fieldKey: string, val: string) {
    setValues((prev) => ({
      ...prev,
      [channelId]: { ...prev[channelId], [fieldKey]: val },
    }));
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  const inputStyle: React.CSSProperties = {
    width: "100%",
    background: "#0d0d0d",
    border: "1px solid #2a2a2a",
    borderRadius: 8,
    padding: "0.6rem 0.9rem",
    color: "#fff",
    fontSize: "0.875rem",
    fontFamily: "monospace",
    boxSizing: "border-box",
  };

  return (
    <>
      <Navbar />
      <main style={{ padding: "3rem 1.5rem" }}>
        <div className="container" style={{ maxWidth: 720 }}>
          <Link href="/dashboard/gateway" style={{ color: "#666", fontSize: "0.85rem" }}>← Gateway</Link>
          <h1 style={{ fontSize: "1.75rem", fontWeight: 700, margin: "0.75rem 0 0.4rem" }}>
            Channel connections
          </h1>
          <p style={{ color: "#666", marginBottom: "2rem", fontSize: "0.9rem" }}>
            Configure your OpenClaw gateway to receive messages from each platform.
            Tokens are saved directly into the gateway config — no restart needed.
          </p>

          {loading && <p style={{ color: "#555" }}>Loading gateway config…</p>}

          {gatewayError && (
            <div style={{ color: "#ef4444", background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.2)", borderRadius: 10, padding: "1rem 1.25rem", marginBottom: "1.5rem" }}>
              <strong>Gateway unreachable.</strong> {gatewayError}
              <br /><span style={{ fontSize: "0.82rem", color: "#f87171" }}>Make sure the gateway is running and <code>GATEWAY_URL</code> is set.</span>
            </div>
          )}

          {!loading && !gatewayError && (
            <div style={{ display: "flex", flexDirection: "column", gap: "1.25rem" }}>
              {CHANNELS.map((ch) => {
                const isEnabled = !!(dig(config, ["channels", ch.configKey, "enabled"]));
                const isSaving = saving[ch.id] ?? false;
                const saveResult = saved[ch.id]; // undefined=untouched, null=success, string=error
                const row = values[ch.id] ?? {};
                const hasValues = ch.fields.some((f) => row[f.key]?.trim());

                return (
                  <form
                    key={ch.id}
                    onSubmit={(e) => saveChannel(e, ch)}
                    style={{
                      background: "#111",
                      border: `1px solid ${isEnabled ? "rgba(224,90,43,0.35)" : "#1f1f1f"}`,
                      borderRadius: 14,
                      padding: "1.5rem",
                    }}
                  >
                    {/* Header */}
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1.25rem" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: "0.6rem" }}>
                        <span style={{ fontSize: "1.4rem" }}>{ch.icon}</span>
                        <span style={{ fontWeight: 700, fontSize: "1rem" }}>{ch.label}</span>
                        {isEnabled && (
                          <span style={{ background: "rgba(34,197,94,0.12)", color: "#22c55e", border: "1px solid rgba(34,197,94,0.3)", borderRadius: 999, padding: "0.15rem 0.55rem", fontSize: "0.72rem", fontWeight: 600 }}>
                            Active
                          </span>
                        )}
                      </div>
                      {ch.docsUrl && (
                        <a href={ch.docsUrl} target="_blank" rel="noreferrer" style={{ color: "#555", fontSize: "0.78rem", textDecoration: "none" }}>
                          Docs ↗
                        </a>
                      )}
                    </div>

                    {/* Fields */}
                    <div style={{ display: "flex", flexDirection: "column", gap: "0.9rem", marginBottom: "1.25rem" }}>
                      {ch.fields.map((f) => (
                        <div key={f.key}>
                          <label style={{ display: "block", color: "#999", fontSize: "0.78rem", marginBottom: "0.3rem" }}>
                            {f.label}
                          </label>
                          <input
                            type={f.type ?? "text"}
                            value={row[f.key] ?? ""}
                            onChange={(e) => setField(ch.id, f.key, e.target.value)}
                            placeholder={f.placeholder}
                            autoComplete="off"
                            spellCheck={false}
                            style={inputStyle}
                          />
                          {f.hint && (
                            <p style={{ color: "#555", fontSize: "0.75rem", marginTop: "0.3rem" }}>{f.hint}</p>
                          )}
                        </div>
                      ))}
                    </div>

                    {/* Save button + feedback */}
                    <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
                      <button
                        type="submit"
                        disabled={isSaving || !hasValues}
                        className="btn btn-primary"
                        style={{ fontSize: "0.875rem", opacity: isSaving || !hasValues ? 0.55 : 1 }}
                      >
                        {isSaving ? "Saving…" : isEnabled ? "Update" : "Connect"}
                      </button>
                      {saveResult === null && (
                        <span style={{ color: "#22c55e", fontSize: "0.82rem" }}>✓ Saved</span>
                      )}
                      {typeof saveResult === "string" && saveResult !== undefined && (
                        <span style={{ color: "#ef4444", fontSize: "0.82rem" }}>{saveResult}</span>
                      )}
                    </div>
                  </form>
                );
              })}
            </div>
          )}
        </div>
      </main>
    </>
  );
}
