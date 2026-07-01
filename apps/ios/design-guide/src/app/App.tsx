import { useState } from "react";

const MASCOT_URL = "https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/png/openclaw-dark.png";

// Brand colors derived from mascot
const BRAND = {
  red: "#E8302A",
  redLight: "#F04540",
  redGhost: "rgba(232,48,42,0.12)",
  teal: "#00C4B0",
  tealGhost: "rgba(0,196,176,0.12)",
};

// ─── Mascot Component ────────────────────────────────────────────────────────

function Mascot({ size = 40, className = "" }: { size?: number; className?: string }) {
  return (
    <img
      src={MASCOT_URL}
      alt="OpenClaw mascot"
      width={size}
      height={size}
      className={`object-contain ${className}`}
      style={{ imageRendering: "auto" }}
    />
  );
}

// ─── Mascot Badge Variants (mascot + overlay badges) ─────────────────────────

function MascotBadge({
  badgeColor,
  badgeContent,
  size = 52,
  label,
  note,
}: {
  badgeColor: string;
  badgeContent: React.ReactNode;
  size?: number;
  label: string;
  note: string;
}) {
  return (
    <div className="bg-card border border-border rounded-2xl p-5 flex flex-col items-center gap-3">
      <div className="relative inline-flex">
        <div
          className="rounded-[18px] flex items-center justify-center"
          style={{ width: size, height: size, background: "#1C1F2B" }}
        >
          <Mascot size={size * 0.72} />
        </div>
        <div
          className="absolute -bottom-1 -right-1 w-6 h-6 rounded-full flex items-center justify-center text-white text-[11px] font-bold shadow-lg"
          style={{ background: badgeColor, boxShadow: `0 2px 8px ${badgeColor}60` }}
        >
          {badgeContent}
        </div>
      </div>
      <div className="text-center">
        <p className="text-[13px] font-semibold text-foreground">{label}</p>
        <p className="text-[11px] text-muted-foreground mt-0.5">{note}</p>
      </div>
    </div>
  );
}

// ─── Section Components ──────────────────────────────────────────────────────

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="font-mono text-[10px] font-medium tracking-[0.2em] uppercase text-muted-foreground mb-5">
      {children}
    </p>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h2
      className="text-2xl font-bold text-foreground mb-1"
      style={{ fontFamily: "'Plus Jakarta Sans', sans-serif" }}
    >
      {children}
    </h2>
  );
}

function Card({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`bg-card border border-border rounded-2xl p-6 ${className}`}>
      {children}
    </div>
  );
}

// ─── Color Swatch ─────────────────────────────────────────────────────────────

function Swatch({ hex, name, role, h = 14 }: { hex: string; name: string; role: string; h?: number }) {
  return (
    <div className="flex flex-col gap-2">
      <div
        className="rounded-xl border border-border"
        style={{ backgroundColor: hex, height: h * 4 }}
      />
      <div>
        <p className="text-[13px] font-semibold text-foreground">{name}</p>
        <p className="font-mono text-[11px] text-muted-foreground">{hex}</p>
        <p className="text-[11px] text-muted-foreground">{role}</p>
      </div>
    </div>
  );
}

// ─── iPhone Shell ─────────────────────────────────────────────────────────────

function IPhoneShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative mx-auto" style={{ width: 290 }}>
      <div
        className="relative rounded-[44px] overflow-hidden border-2 border-white/10"
        style={{
          background: "linear-gradient(160deg, #1e2030 0%, #0B0C11 100%)",
          boxShadow: "0 32px 80px rgba(0,0,0,0.6), inset 0 0 0 1px rgba(255,255,255,0.06)",
          height: 580,
        }}
      >
        {/* Status bar */}
        <div className="flex items-center justify-between px-6 pt-4 pb-1">
          <span className="font-sans text-[11px] font-semibold text-foreground">9:41</span>
          <div className="w-24 h-5 rounded-full bg-black absolute top-3 left-1/2 -translate-x-1/2" style={{ width: 100, height: 26, borderRadius: 20 }} />
          <div className="flex gap-1 items-center">
            <div className="w-3.5 h-2 rounded-sm bg-foreground/70" />
            <div className="w-2 h-2 rounded-full bg-foreground/70" />
          </div>
        </div>
        <div className="px-4 pb-4 h-full overflow-hidden">
          {children}
        </div>
      </div>
    </div>
  );
}

// ─── Nav ─────────────────────────────────────────────────────────────────────

const NAV_ITEMS = [
  { id: "colors", label: "Colors" },
  { id: "type", label: "Typography" },
  { id: "icons", label: "Icons" },
  { id: "components", label: "Components" },
  { id: "screens", label: "Screens" },
  { id: "spacing", label: "Tokens" },
];

// ─── App ─────────────────────────────────────────────────────────────────────

export default function App() {
  const [activeNav, setActiveNav] = useState("colors");

  return (
    <div className="min-h-screen bg-background text-foreground" style={{ fontFamily: "'DM Sans', sans-serif" }}>

      {/* ── Header ── */}
      <header
        className="sticky top-0 z-50 border-b border-border"
        style={{ background: "rgba(11,12,17,0.90)", backdropFilter: "blur(20px)" }}
      >
        <div className="max-w-6xl mx-auto px-6 h-14 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Mascot size={30} />
            <div className="flex items-baseline gap-2">
              <span className="text-foreground font-bold text-[15px] tracking-tight" style={{ fontFamily: "'Plus Jakarta Sans', sans-serif" }}>
                OpenClaw
              </span>
              <span className="font-mono text-[10px] text-muted-foreground tracking-widest uppercase">
                iOS Style Guide
              </span>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className="font-mono text-[10px] text-muted-foreground">v1.0</span>
            <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold" style={{ background: BRAND.redGhost, color: BRAND.red }}>
              Alpha
            </span>
          </div>
        </div>

        <div className="max-w-6xl mx-auto px-6 flex border-t border-border/50 overflow-x-auto no-scrollbar">
          {NAV_ITEMS.map((n) => (
            <button
              key={n.id}
              onClick={() => setActiveNav(n.id)}
              className="px-4 py-2.5 text-[13px] font-medium whitespace-nowrap transition-colors border-b-2"
              style={{
                color: activeNav === n.id ? BRAND.red : undefined,
                borderBottomColor: activeNav === n.id ? BRAND.red : "transparent",
              }}
            >
              {activeNav !== n.id && <span className="text-muted-foreground hover:text-foreground">{n.label}</span>}
              {activeNav === n.id && n.label}
            </button>
          ))}
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-6 py-12 space-y-20">

        {/* ──────────────────── COLORS ──────────────────── */}
        {activeNav === "colors" && (
          <section>
            <SectionLabel>01 — Foundation</SectionLabel>
            <SectionTitle>Color System</SectionTitle>
            <p className="text-muted-foreground text-sm mb-10 max-w-xl">
              Extracted directly from the OpenClaw mascot. The crimson body sets the primary, the teal eyes become the accent. Everything else serves dark-mode clarity on OLED displays.
            </p>

            {/* Mascot color extraction callout */}
            <div className="flex items-center gap-6 p-5 rounded-2xl border border-border bg-card mb-10">
              <Mascot size={80} className="flex-none" />
              <div className="flex gap-4 flex-wrap">
                {[
                  { label: "Primary", hex: "#E8302A", note: "Body — Claw Red" },
                  { label: "Accent", hex: "#00C4B0", note: "Eyes — Claw Teal" },
                  { label: "Shadow", hex: "#B82220", note: "Shading — Deep Red" },
                  { label: "Surface", hex: "#0B0C11", note: "Ground — Void" },
                ].map((c) => (
                  <div key={c.label} className="flex items-center gap-2">
                    <div className="w-8 h-8 rounded-lg border border-border flex-none" style={{ background: c.hex }} />
                    <div>
                      <p className="text-[12px] font-semibold text-foreground">{c.label}</p>
                      <p className="font-mono text-[10px] text-muted-foreground">{c.hex}</p>
                    </div>
                  </div>
                ))}
              </div>
              <p className="font-mono text-[10px] text-muted-foreground ml-auto self-start flex-none">Mascot color extraction</p>
            </div>

            <div className="space-y-10">
              {/* Brand */}
              <div>
                <p className="text-[11px] font-mono uppercase tracking-widest text-muted-foreground mb-4">Brand</p>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                  <div className="flex flex-col gap-2">
                    <div className="h-20 rounded-xl" style={{ background: `linear-gradient(135deg, ${BRAND.red} 0%, ${BRAND.redLight} 100%)` }} />
                    <p className="text-[13px] font-semibold">Claw Red</p>
                    <p className="font-mono text-[11px] text-muted-foreground">#E8302A — Primary</p>
                  </div>
                  <div className="flex flex-col gap-2">
                    <div className="h-20 rounded-xl" style={{ background: "#B82220" }} />
                    <p className="text-[13px] font-semibold">Deep Red</p>
                    <p className="font-mono text-[11px] text-muted-foreground">#B82220 — Pressed / shadow</p>
                  </div>
                  <div className="flex flex-col gap-2">
                    <div className="h-20 rounded-xl border border-border" style={{ background: BRAND.redGhost }} />
                    <p className="text-[13px] font-semibold">Ghost Red</p>
                    <p className="font-mono text-[11px] text-muted-foreground">#E8302A 12% — Surface</p>
                  </div>
                  <div className="flex flex-col gap-2">
                    <div className="h-20 rounded-xl" style={{ background: BRAND.teal }} />
                    <p className="text-[13px] font-semibold">Claw Teal</p>
                    <p className="font-mono text-[11px] text-muted-foreground">#00C4B0 — Accent / eyes</p>
                  </div>
                </div>
              </div>

              {/* Surfaces */}
              <div>
                <p className="text-[11px] font-mono uppercase tracking-widest text-muted-foreground mb-4">Surfaces</p>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                  <Swatch hex="#0B0C11" name="Void" role="App background" />
                  <Swatch hex="#13151C" name="Obsidian" role="Card / sheet" />
                  <Swatch hex="#1C1F2B" name="Slate" role="Input / secondary" />
                  <Swatch hex="#252838" name="Stone" role="Elevated surface" />
                </div>
              </div>

              {/* Semantic */}
              <div>
                <p className="text-[11px] font-mono uppercase tracking-widest text-muted-foreground mb-4">Semantic</p>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                  <Swatch hex="#34D399" name="Connected" role="Success / online" />
                  <Swatch hex="#F59E0B" name="Pending" role="Warning / waiting" />
                  <Swatch hex="#FF3B3B" name="Error" role="Destructive" />
                  <Swatch hex="#60A5FA" name="Info" role="Informational" />
                </div>
              </div>

              {/* Text */}
              <div>
                <p className="text-[11px] font-mono uppercase tracking-widest text-muted-foreground mb-4">Text</p>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                  <Swatch hex="#F2EFE8" name="Primary" role="Headings / body" />
                  <Swatch hex="#A8AABF" name="Secondary" role="Subtext" />
                  <Swatch hex="#7A7F94" name="Tertiary" role="Captions / muted" />
                  <Swatch hex="#3D4157" name="Disabled" role="Inactive" />
                </div>
              </div>

              <Card>
                <p className="text-[11px] font-mono uppercase tracking-widest text-muted-foreground mb-4">Usage Rules</p>
                <div className="grid sm:grid-cols-2 gap-4">
                  {[
                    { rule: "Use Claw Red only for primary actions and active states — one per screen", ok: true },
                    { rule: "Teal (eye color) is for accent labels, links, and data callouts — not buttons", ok: true },
                    { rule: "Never place red or teal text directly on a card surface — contrast fails", ok: false },
                    { rule: "Status colors must always pair with a text label — never color-only", ok: true },
                  ].map((r, i) => (
                    <div key={i} className="flex gap-3 items-start">
                      <span className={`mt-0.5 flex-none w-5 h-5 rounded-full flex items-center justify-center text-[11px] font-bold ${r.ok ? "bg-emerald-500/15 text-emerald-400" : "bg-red-500/15 text-red-400"}`}>
                        {r.ok ? "✓" : "✗"}
                      </span>
                      <p className="text-[13px] text-foreground/80">{r.rule}</p>
                    </div>
                  ))}
                </div>
              </Card>
            </div>
          </section>
        )}

        {/* ──────────────────── TYPOGRAPHY ──────────────────── */}
        {activeNav === "type" && (
          <section>
            <SectionLabel>02 — Typography</SectionLabel>
            <SectionTitle>Type System</SectionTitle>
            <p className="text-muted-foreground text-sm mb-10 max-w-xl">
              Three-family stack. Plus Jakarta Sans for product headings and UI chrome, DM Sans for all body and descriptions, JetBrains Mono for commands, tokens, and data.
            </p>

            <div className="space-y-6">
              <Card>
                <p className="text-[11px] font-mono uppercase tracking-widest text-muted-foreground mb-6">Display — Plus Jakarta Sans</p>
                <div className="space-y-6 divide-y divide-border">
                  {[
                    { label: "Title 1 · 34pt · 800", size: "34px", weight: "800", sample: "OpenClaw Gateway" },
                    { label: "Title 2 · 28pt · 700", size: "28px", weight: "700", sample: "Agent Connected" },
                    { label: "Title 3 · 22pt · 700", size: "22px", weight: "700", sample: "Pairing Request" },
                    { label: "Headline · 17pt · 600", size: "17px", weight: "600", sample: "Pending Approval" },
                  ].map((t) => (
                    <div key={t.label} className="pt-5 first:pt-0 flex items-baseline justify-between gap-4">
                      <p style={{ fontFamily: "'Plus Jakarta Sans', sans-serif", fontSize: t.size, fontWeight: t.weight, lineHeight: 1.15 }}>
                        {t.sample}
                      </p>
                      <p className="font-mono text-[10px] text-muted-foreground flex-none text-right">{t.label}</p>
                    </div>
                  ))}
                </div>
              </Card>

              <Card>
                <p className="text-[11px] font-mono uppercase tracking-widest text-muted-foreground mb-6">Body — DM Sans</p>
                <div className="divide-y divide-border">
                  {[
                    { label: "Body · 17pt · 400", size: "17px", weight: "400", sample: "Your gateway is online and processing requests from connected agents across all registered nodes." },
                    { label: "Callout · 16pt · 400", size: "16px", weight: "400", sample: "Approve this MCP tool call to allow write access to your file system." },
                    { label: "Subhead · 15pt · 500", size: "15px", weight: "500", sample: "Local Device · macOS 14.5" },
                    { label: "Footnote · 13pt · 400", size: "13px", weight: "400", sample: "Last synced 2 minutes ago · Relay: ios-push-relay.openclaw.ai" },
                    { label: "Caption · 12pt · 400", size: "12px", weight: "400", sample: "SESSION TOKEN · EXPIRES IN 23:41" },
                  ].map((t) => (
                    <div key={t.label} className="py-4 first:pt-0 flex items-start justify-between gap-6">
                      <p className="text-foreground/85 leading-snug max-w-sm" style={{ fontSize: t.size, fontWeight: t.weight }}>
                        {t.sample}
                      </p>
                      <p className="font-mono text-[10px] text-muted-foreground flex-none text-right mt-0.5">{t.label}</p>
                    </div>
                  ))}
                </div>
              </Card>

              <Card>
                <p className="text-[11px] font-mono uppercase tracking-widest text-muted-foreground mb-6">Mono — JetBrains Mono</p>
                <div className="divide-y divide-border">
                  {[
                    { label: "Command", sample: "$ openclaw connect --gateway 192.168.1.1:8080" },
                    { label: "Node ID", sample: "node_7a3f2c91d8e04b15" },
                    { label: "Status label", sample: "CONNECTED · 12ms latency" },
                    { label: "Timestamp", sample: "2026-07-01T09:41:00Z" },
                  ].map((t) => (
                    <div key={t.label} className="flex items-baseline justify-between gap-4 py-3">
                      <p className="font-mono text-sm" style={{ color: BRAND.teal }}>{t.sample}</p>
                      <p className="font-mono text-[10px] text-muted-foreground flex-none">{t.label}</p>
                    </div>
                  ))}
                </div>
              </Card>
            </div>
          </section>
        )}

        {/* ──────────────────── ICONS ──────────────────── */}
        {activeNav === "icons" && (
          <section>
            <SectionLabel>03 — Iconography</SectionLabel>
            <SectionTitle>Icon System</SectionTitle>
            <p className="text-muted-foreground text-sm mb-10 max-w-xl">
              Two layers: the OpenClaw mascot for all branded moments, native SF Symbols for system UI. The mascot appears at app icon scale, splash, empty states, and onboarding — never inline in lists.
            </p>

            {/* Mascot at scale */}
            <div className="space-y-8">
              <Card>
                <p className="text-[11px] font-mono uppercase tracking-widest text-muted-foreground mb-6">Mascot — Size Scale</p>
                <div className="flex items-end gap-8 flex-wrap">
                  {[
                    { size: 96, label: "96pt", use: "Splash / onboarding hero" },
                    { size: 64, label: "64pt", use: "Empty state" },
                    { size: 44, label: "44pt", use: "Sheet header" },
                    { size: 32, label: "32pt", use: "Section banner" },
                    { size: 24, label: "24pt", use: "Nav bar" },
                    { size: 20, label: "20pt", use: "Inline — min size" },
                  ].map((s) => (
                    <div key={s.label} className="flex flex-col items-center gap-2">
                      <Mascot size={s.size} />
                      <p className="font-mono text-[11px] text-foreground font-semibold">{s.label}</p>
                      <p className="font-mono text-[9px] text-muted-foreground text-center max-w-[64px]">{s.use}</p>
                    </div>
                  ))}
                </div>
              </Card>

              {/* App icon variants */}
              <div>
                <p className="text-[11px] font-mono uppercase tracking-widest text-muted-foreground mb-5">App Icon Variants</p>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                  {/* Default dark */}
                  <div className="bg-card border border-border rounded-2xl p-5 flex flex-col items-center gap-3">
                    <div className="w-[60px] h-[60px] rounded-[14px] flex items-center justify-center" style={{ background: "#1C1F2B" }}>
                      <Mascot size={44} />
                    </div>
                    <div className="text-center">
                      <p className="text-[13px] font-semibold text-foreground">Dark Surface</p>
                      <p className="text-[11px] text-muted-foreground">Default app icon</p>
                    </div>
                  </div>
                  {/* Red bg */}
                  <div className="bg-card border border-border rounded-2xl p-5 flex flex-col items-center gap-3">
                    <div className="w-[60px] h-[60px] rounded-[14px] flex items-center justify-center" style={{ background: BRAND.red }}>
                      <Mascot size={44} />
                    </div>
                    <div className="text-center">
                      <p className="text-[13px] font-semibold text-foreground">Brand Red</p>
                      <p className="text-[11px] text-muted-foreground">Alternate / notification</p>
                    </div>
                  </div>
                  {/* Teal bg */}
                  <div className="bg-card border border-border rounded-2xl p-5 flex flex-col items-center gap-3">
                    <div className="w-[60px] h-[60px] rounded-[14px] flex items-center justify-center" style={{ background: BRAND.teal }}>
                      <Mascot size={44} />
                    </div>
                    <div className="text-center">
                      <p className="text-[13px] font-semibold text-foreground">Accent Teal</p>
                      <p className="text-[11px] text-muted-foreground">Connected state icon</p>
                    </div>
                  </div>
                  {/* Ghost */}
                  <div className="bg-card border border-border rounded-2xl p-5 flex flex-col items-center gap-3">
                    <div className="w-[60px] h-[60px] rounded-[14px] flex items-center justify-center border border-border" style={{ background: "#0B0C11" }}>
                      <Mascot size={44} className="opacity-30" />
                    </div>
                    <div className="text-center">
                      <p className="text-[13px] font-semibold text-foreground">Ghost / Outline</p>
                      <p className="text-[11px] text-muted-foreground">Empty states / watermark</p>
                    </div>
                  </div>
                </div>
              </div>

              {/* Mascot + status badges */}
              <div>
                <p className="text-[11px] font-mono uppercase tracking-widest text-muted-foreground mb-5">Mascot + Status Badges</p>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                  <MascotBadge badgeColor="#34D399" badgeContent="✓" label="Approved / Connected" note="Session active" />
                  <MascotBadge badgeColor="#F59E0B" badgeContent="⧗" label="Pending Approval" note="Waiting for review" />
                  <MascotBadge badgeColor="#FF3B3B" badgeContent="✗" label="Error / Denied" note="Action blocked" />
                  <MascotBadge badgeColor="#60A5FA" badgeContent="↗" label="Pairing Request" note="New device linking" />
                  <MascotBadge badgeColor={BRAND.teal} badgeContent="✦" label="Agent Active" note="AI running" />
                  <MascotBadge badgeColor="#A78BFA" badgeContent="◈" label="Skill Loaded" note="Plugin available" />
                  <MascotBadge badgeColor="#7A7F94" badgeContent="—" label="Offline" note="Node unreachable" />
                  <MascotBadge badgeColor={BRAND.red} badgeContent="!" label="Needs Attention" note="Action required" />
                </div>
              </div>

              {/* SF Symbols */}
              <div>
                <p className="text-[11px] font-mono uppercase tracking-widest text-muted-foreground mb-5">SF Symbols — Native UI Layer</p>
                <div className="grid sm:grid-cols-2 gap-2">
                  {[
                    { symbol: "checkmark.seal.fill", name: "Connected", color: "#34D399", use: "Gateway / node online" },
                    { symbol: "wifi.slash", name: "Disconnected", color: "#FF3B3B", use: "No gateway connection" },
                    { symbol: "link.badge.plus", name: "Pairing Request", color: "#60A5FA", use: "New device wants to pair" },
                    { symbol: "hourglass", name: "Pending", color: "#F59E0B", use: "Waiting for approval" },
                    { symbol: "sparkles", name: "Agent", color: "#A78BFA", use: "AI agent / active skill" },
                    { symbol: "terminal.fill", name: "Commands", color: BRAND.red, use: "Command center" },
                    { symbol: "puzzlepiece.extension.fill", name: "Skills", color: "#34D399", use: "Plugin / capability" },
                    { symbol: "lock.shield.fill", name: "Privacy", color: "#60A5FA", use: "Permissions / secure mode" },
                    { symbol: "bell.badge.fill", name: "Notifications", color: BRAND.red, use: "App alerts" },
                    { symbol: "key.fill", name: "Token", color: "#F59E0B", use: "Auth / session key" },
                    { symbol: "waveform", name: "Voice / Talk", color: "#A78BFA", use: "Voice mode" },
                    { symbol: "message.fill", name: "Chat", color: BRAND.teal, use: "Conversation view" },
                  ].map((s) => (
                    <div key={s.symbol} className="flex items-center gap-3 px-4 py-3 rounded-xl bg-secondary border border-border">
                      <div className="w-8 h-8 rounded-lg flex items-center justify-center flex-none text-sm" style={{ background: s.color + "20", color: s.color }}>
                        ◆
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-[13px] font-semibold text-foreground">{s.name}</p>
                        <p className="text-[11px] text-muted-foreground truncate">{s.use}</p>
                      </div>
                      <p className="font-mono text-[10px] text-muted-foreground flex-none">{s.symbol}</p>
                    </div>
                  ))}
                </div>
              </div>

              {/* Rules */}
              <Card>
                <p className="text-[11px] font-mono uppercase tracking-widest text-muted-foreground mb-4">Icon Rules</p>
                <div className="grid sm:grid-cols-2 gap-6 text-[13px]">
                  <div className="space-y-2">
                    <p className="font-semibold text-foreground">Mascot usage</p>
                    <ul className="space-y-1.5 text-muted-foreground">
                      <li>• Splash, empty states, onboarding, sheet headers</li>
                      <li>• Minimum rendered size: 20pt — never smaller</li>
                      <li>• Always on dark surface — no light backgrounds</li>
                      <li>• Badge overlays use semantic color tokens only</li>
                    </ul>
                  </div>
                  <div className="space-y-2">
                    <p className="font-semibold text-foreground">SF Symbols</p>
                    <ul className="space-y-1.5 text-muted-foreground">
                      <li>• Native weight — never artificially bold or stroked</li>
                      <li>• 20–24pt for navigation, 17pt for list rows</li>
                      <li>• Tint with semantic tokens only — no gradients</li>
                      <li>• Use multicolor variant only when SF provides it</li>
                    </ul>
                  </div>
                </div>
              </Card>
            </div>
          </section>
        )}

        {/* ──────────────────── COMPONENTS ──────────────────── */}
        {activeNav === "components" && (
          <section>
            <SectionLabel>04 — Components</SectionLabel>
            <SectionTitle>UI Components</SectionTitle>
            <p className="text-muted-foreground text-sm mb-10 max-w-xl">
              All components follow iOS HIG. Touch targets minimum 44×44pt. Haptic feedback on primary and destructive actions.
            </p>

            <div className="grid sm:grid-cols-2 gap-6">

              <Card>
                <p className="text-[11px] font-mono uppercase tracking-widest text-muted-foreground mb-5">Buttons</p>
                <div className="space-y-3">
                  <button className="w-full h-12 rounded-2xl text-white font-semibold text-[15px] transition-all hover:brightness-110 active:scale-[0.98]" style={{ background: BRAND.red }}>
                    Approve Request
                  </button>
                  <button className="w-full h-12 rounded-2xl bg-secondary text-foreground font-semibold text-[15px] border border-border hover:bg-muted transition-colors">
                    View Details
                  </button>
                  <button className="w-full h-12 rounded-2xl font-semibold text-[15px] border transition-all hover:brightness-110" style={{ background: BRAND.redGhost, borderColor: BRAND.red + "40", color: BRAND.red }}>
                    Connect Gateway
                  </button>
                  <button className="w-full h-12 rounded-2xl font-semibold text-[15px] border transition-colors hover:bg-red-500/20" style={{ background: "rgba(255,59,59,0.1)", borderColor: "rgba(255,59,59,0.25)", color: "#FF3B3B" }}>
                    Deny Request
                  </button>
                  <button className="w-full h-12 rounded-2xl text-muted-foreground font-semibold text-[15px] hover:text-foreground transition-colors">
                    Cancel
                  </button>
                </div>
              </Card>

              <Card>
                <p className="text-[11px] font-mono uppercase tracking-widest text-muted-foreground mb-5">Status Badges</p>
                <div className="space-y-3">
                  {[
                    { label: "Connected", color: "#34D399" },
                    { label: "Pending Approval", color: "#F59E0B" },
                    { label: "Disconnected", color: "#FF3B3B" },
                    { label: "Pairing", color: "#60A5FA" },
                    { label: "Agent Active", color: "#A78BFA" },
                    { label: "Secure Session", color: BRAND.teal },
                  ].map((s) => (
                    <div key={s.label} className="flex items-center justify-between">
                      <span
                        className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-[13px] font-semibold"
                        style={{ color: s.color, background: s.color + "18" }}
                      >
                        <span className="w-1.5 h-1.5 rounded-full" style={{ background: s.color, boxShadow: `0 0 6px ${s.color}` }} />
                        {s.label}
                      </span>
                      <span className="font-mono text-[10px] text-muted-foreground">badge</span>
                    </div>
                  ))}
                </div>
              </Card>

              <Card className="sm:col-span-2">
                <p className="text-[11px] font-mono uppercase tracking-widest text-muted-foreground mb-5">List Rows — iOS Native Style</p>
                <div className="divide-y divide-border rounded-xl overflow-hidden border border-border">
                  {[
                    { emoji: "🖥", name: "MacBook Pro (Home)", sub: "macOS 14.5 · Active 2m ago", status: "connected", color: "#34D399" },
                    { emoji: "📱", name: "iPhone 15 Pro", sub: "iOS 17.4 · This device", status: "connected", color: "#34D399" },
                    { emoji: "⚙️", name: "Home Server", sub: "Ubuntu 24.04 · Waiting", status: "pending", color: "#F59E0B" },
                    { emoji: "💻", name: "Work MacBook", sub: "Last seen 3 hours ago", status: "offline", color: "#7A7F94" },
                  ].map((r) => (
                    <div key={r.name} className="flex items-center gap-3 px-4 py-3.5 bg-secondary/40 hover:bg-secondary transition-colors cursor-pointer">
                      <span className="text-xl w-8 text-center flex-none">{r.emoji}</span>
                      <div className="flex-1 min-w-0">
                        <p className="text-[15px] font-medium text-foreground truncate">{r.name}</p>
                        <p className="text-[13px] text-muted-foreground truncate">{r.sub}</p>
                      </div>
                      <span className="text-[12px] font-semibold capitalize px-2 py-0.5 rounded-full flex-none" style={{ color: r.color, background: r.color + "18" }}>
                        {r.status}
                      </span>
                      <span className="text-muted-foreground ml-1">›</span>
                    </div>
                  ))}
                </div>
              </Card>

              <Card>
                <p className="text-[11px] font-mono uppercase tracking-widest text-muted-foreground mb-5">Text Fields</p>
                <div className="space-y-4">
                  <div>
                    <label className="text-[12px] font-medium text-muted-foreground mb-1.5 block">Gateway URL</label>
                    <div className="h-11 px-4 rounded-xl bg-secondary border border-border flex items-center">
                      <span className="font-mono text-[14px] text-muted-foreground">192.168.1.1:8080</span>
                    </div>
                  </div>
                  <div>
                    <label className="text-[12px] font-medium text-muted-foreground mb-1.5 block">Node Name</label>
                    <div className="h-11 px-4 rounded-xl bg-secondary flex items-center" style={{ border: `1px solid ${BRAND.red}70`, boxShadow: `0 0 0 3px ${BRAND.red}18` }}>
                      <span className="font-mono text-[14px] text-foreground">iPhone 15 Pro</span>
                    </div>
                    <p className="text-[11px] text-muted-foreground mt-1 ml-1">This name appears in your gateway fleet</p>
                  </div>
                  <div>
                    <label className="text-[12px] font-medium text-muted-foreground mb-1.5 block">Access Token</label>
                    <div className="h-11 px-4 rounded-xl bg-secondary border border-red-500/40 flex items-center" style={{ boxShadow: "0 0 0 3px rgba(255,59,59,0.1)" }}>
                      <span className="font-mono text-[14px] text-red-400">Invalid token format</span>
                    </div>
                    <p className="text-[11px] text-red-400 mt-1 ml-1">Token must be 32 characters</p>
                  </div>
                </div>
              </Card>

              <Card>
                <p className="text-[11px] font-mono uppercase tracking-widest text-muted-foreground mb-5">Banners</p>
                <div className="space-y-3">
                  {[
                    { color: "#34D399", icon: "✓", msg: "Gateway connected successfully" },
                    { color: "#F59E0B", icon: "!", msg: "New pairing request from macOS node" },
                    { color: "#FF3B3B", icon: "✗", msg: "Connection lost — retrying in 5s" },
                    { color: "#60A5FA", icon: "i", msg: "Agent requested camera access" },
                  ].map((b) => (
                    <div key={b.msg} className="flex items-center gap-3 px-4 py-3 rounded-xl text-[13px] font-medium" style={{ color: b.color, background: b.color + "14", border: `1px solid ${b.color}30` }}>
                      <span className="font-bold text-sm w-5 text-center flex-none">{b.icon}</span>
                      <span>{b.msg}</span>
                    </div>
                  ))}
                </div>
              </Card>

            </div>
          </section>
        )}

        {/* ──────────────────── SCREENS ──────────────────── */}
        {activeNav === "screens" && (
          <section>
            <SectionLabel>05 — Screens</SectionLabel>
            <SectionTitle>Key iOS Screens</SectionTitle>
            <p className="text-muted-foreground text-sm mb-10 max-w-xl">
              The mascot drives all branded moments. Annotated screen mockups for the three core flows.
            </p>

            <div className="grid sm:grid-cols-3 gap-8">

              {/* Pending Approval */}
              <div className="flex flex-col gap-4">
                <p className="text-[11px] font-mono uppercase tracking-widest text-muted-foreground">Pending Approval</p>
                <IPhoneShell>
                  <div className="flex flex-col h-full pt-2 pb-4">
                    <div className="flex items-center justify-between mb-5">
                      <p className="text-[16px] font-bold" style={{ fontFamily: "'Plus Jakarta Sans', sans-serif" }}>Approvals</p>
                      <span className="w-5 h-5 rounded-full text-white text-[10px] font-bold flex items-center justify-center" style={{ background: BRAND.red }}>3</span>
                    </div>
                    <div className="flex flex-col items-center py-4 mb-4">
                      <div className="relative">
                        <Mascot size={72} />
                        <div className="absolute -bottom-1 -right-1 w-7 h-7 rounded-full bg-amber-500 flex items-center justify-center text-white text-sm font-bold shadow-lg">
                          ⧗
                        </div>
                      </div>
                      <p className="text-[15px] font-bold mt-3" style={{ fontFamily: "'Plus Jakarta Sans', sans-serif" }}>Awaiting Review</p>
                      <p className="text-[12px] text-muted-foreground text-center mt-1">
                        Agent wants to run <span className="font-mono text-[11px]" style={{ color: BRAND.teal }}>exec()</span> on your Mac
                      </p>
                    </div>
                    <div className="bg-secondary rounded-xl p-3 mb-4 space-y-2 border border-border">
                      {[["Tool", "bash_exec"], ["Agent", "ClawAgent v2.1"], ["Scope", "write:shell"]].map(([k, v]) => (
                        <div key={k} className="flex justify-between">
                          <span className="text-[12px] text-muted-foreground">{k}</span>
                          <span className="font-mono text-[12px] text-foreground">{v}</span>
                        </div>
                      ))}
                    </div>
                    <div className="mt-auto space-y-2">
                      <button className="w-full h-11 rounded-2xl text-white font-semibold text-[15px]" style={{ background: BRAND.red }}>Approve</button>
                      <button className="w-full h-11 rounded-2xl border font-semibold text-[14px] text-red-400" style={{ background: "rgba(255,59,59,0.1)", borderColor: "rgba(255,59,59,0.25)" }}>Deny</button>
                    </div>
                  </div>
                </IPhoneShell>
                <p className="text-[12px] text-muted-foreground leading-relaxed">Mascot + amber badge signals pending. Full tool details before any action. Teal mono for code values.</p>
              </div>

              {/* Chat */}
              <div className="flex flex-col gap-4">
                <p className="text-[11px] font-mono uppercase tracking-widest text-muted-foreground">Agent Chat</p>
                <IPhoneShell>
                  <div className="flex flex-col h-full pt-2 pb-4">
                    <div className="flex items-center gap-2 mb-4">
                      <div className="w-8 h-8 rounded-full bg-secondary flex items-center justify-center border border-border">
                        <Mascot size={22} />
                      </div>
                      <div>
                        <p className="text-[13px] font-semibold">ClawAgent</p>
                        <p className="text-[10px] text-emerald-400 flex items-center gap-1">
                          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 inline-block" /> Online
                        </p>
                      </div>
                    </div>
                    <div className="flex-1 space-y-3 overflow-hidden">
                      <div className="flex justify-end">
                        <div className="rounded-2xl rounded-tr-sm px-3 py-2 max-w-[75%]" style={{ background: BRAND.red }}>
                          <p className="text-[13px] text-white">Check my calendar for tomorrow</p>
                        </div>
                      </div>
                      <div className="flex justify-start">
                        <div className="bg-secondary rounded-2xl rounded-tl-sm px-3 py-2 max-w-[75%] border border-border">
                          <p className="text-[13px] text-foreground">You have 3 meetings. 10am standup, 1pm design review, 4pm 1:1.</p>
                        </div>
                      </div>
                      <div className="flex justify-end">
                        <div className="rounded-2xl rounded-tr-sm px-3 py-2 max-w-[75%]" style={{ background: BRAND.red }}>
                          <p className="text-[13px] text-white">Move the 1pm to 3pm</p>
                        </div>
                      </div>
                      <div className="flex justify-start">
                        <div className="rounded-2xl rounded-tl-sm px-3 py-2 max-w-[80%] border" style={{ background: "rgba(245,158,11,0.08)", borderColor: "rgba(245,158,11,0.25)" }}>
                          <p className="text-[11px] text-amber-400 font-semibold mb-1">⚠ Approval needed</p>
                          <p className="text-[12px] text-foreground/80">Edit calendar event requires your approval.</p>
                        </div>
                      </div>
                    </div>
                    <div className="mt-3 flex gap-2 items-center">
                      <div className="flex-1 h-10 bg-secondary rounded-full border border-border px-4 flex items-center">
                        <span className="text-[13px] text-muted-foreground">Message…</span>
                      </div>
                      <button className="w-10 h-10 rounded-full flex items-center justify-center text-white" style={{ background: BRAND.red }}>↑</button>
                    </div>
                  </div>
                </IPhoneShell>
                <p className="text-[12px] text-muted-foreground leading-relaxed">User bubbles in Claw Red. Mascot avatar in nav bar. Amber inline approval — never modal unless destructive.</p>
              </div>

              {/* Fleet */}
              <div className="flex flex-col gap-4">
                <p className="text-[11px] font-mono uppercase tracking-widest text-muted-foreground">Fleet Status</p>
                <IPhoneShell>
                  <div className="flex flex-col h-full pt-2 pb-4">
                    <div className="flex items-center justify-between mb-4">
                      <p className="text-[16px] font-bold" style={{ fontFamily: "'Plus Jakarta Sans', sans-serif" }}>Nodes</p>
                      <Mascot size={22} />
                    </div>
                    <div className="rounded-2xl px-4 py-3 mb-4 flex items-center gap-3 border" style={{ background: "rgba(52,211,153,0.08)", borderColor: "rgba(52,211,153,0.2)" }}>
                      <span className="w-2 h-2 rounded-full bg-emerald-400 flex-none" style={{ boxShadow: "0 0 8px #34D399" }} />
                      <div>
                        <p className="text-[13px] font-semibold text-emerald-400">Gateway Online</p>
                        <p className="font-mono text-[10px] text-muted-foreground">192.168.1.1:8080 · 8ms</p>
                      </div>
                    </div>
                    <div className="space-y-2">
                      {[
                        { name: "MacBook Pro", type: "macOS", status: "online", color: "#34D399" },
                        { name: "iPhone 15 Pro", type: "iOS · This device", status: "online", color: "#34D399" },
                        { name: "Home Server", type: "Ubuntu", status: "pending", color: "#F59E0B" },
                        { name: "Work Mac", type: "macOS", status: "offline", color: "#7A7F94" },
                      ].map((n) => (
                        <div key={n.name} className="flex items-center gap-3 px-3 py-2.5 bg-secondary rounded-xl border border-border">
                          <span className="w-2 h-2 rounded-full flex-none" style={{ background: n.color, boxShadow: n.color !== "#7A7F94" ? `0 0 6px ${n.color}` : "none" }} />
                          <div className="flex-1 min-w-0">
                            <p className="text-[13px] font-medium text-foreground">{n.name}</p>
                            <p className="text-[11px] text-muted-foreground">{n.type}</p>
                          </div>
                          <span className="text-[11px] capitalize font-mono" style={{ color: n.color }}>{n.status}</span>
                        </div>
                      ))}
                    </div>
                    <div className="mt-auto pt-3 border-t border-border flex justify-around">
                      {["Nodes", "Chat", "Skills", "Settings"].map((t, i) => (
                        <div key={t} className="flex flex-col items-center gap-0.5" style={{ color: i === 0 ? BRAND.red : "#7A7F94" }}>
                          <div className="w-5 h-0.5 rounded bg-current opacity-60" />
                          <span className="text-[9px]">{t}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </IPhoneShell>
                <p className="text-[12px] text-muted-foreground leading-relaxed">Fleet health at a glance. Glowing dot for live nodes. Gateway status pinned top. Tab bar active in Claw Red.</p>
              </div>

            </div>
          </section>
        )}

        {/* ──────────────────── TOKENS ──────────────────── */}
        {activeNav === "spacing" && (
          <section>
            <SectionLabel>06 — Tokens</SectionLabel>
            <SectionTitle>Spacing, Radius & Motion</SectionTitle>
            <p className="text-muted-foreground text-sm mb-10 max-w-xl">
              8pt base grid throughout. All interactive touch targets minimum 44pt. Radius tokens follow iOS conventions.
            </p>

            <div className="grid sm:grid-cols-2 gap-6">
              <Card>
                <p className="text-[11px] font-mono uppercase tracking-widest text-muted-foreground mb-6">Spacing Scale</p>
                <div className="space-y-3">
                  {[
                    { name: "space-1", pt: 4, use: "Icon gap, badge inset" },
                    { name: "space-2", pt: 8, use: "Inline element gap" },
                    { name: "space-3", pt: 12, use: "Label to value" },
                    { name: "space-4", pt: 16, use: "Row padding, card inset" },
                    { name: "space-5", pt: 20, use: "Section header gap" },
                    { name: "space-6", pt: 24, use: "Card padding" },
                    { name: "space-8", pt: 32, use: "Between sections" },
                    { name: "space-10", pt: 40, use: "Safe area inset" },
                    { name: "space-12", pt: 48, use: "Nav bar height" },
                  ].map((s) => (
                    <div key={s.name} className="flex items-center gap-3">
                      <div className="flex-none w-16">
                        <span className="font-mono text-[11px] text-muted-foreground">{s.name}</span>
                      </div>
                      <div className="h-3.5 rounded flex-none" style={{ width: s.pt * 2, background: BRAND.red + "50" }} />
                      <div className="flex-1">
                        <span className="font-mono text-[12px] text-foreground">{s.pt}pt</span>
                        <span className="text-[11px] text-muted-foreground ml-2">{s.use}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </Card>

              <div className="space-y-6">
                <Card>
                  <p className="text-[11px] font-mono uppercase tracking-widest text-muted-foreground mb-6">Border Radius</p>
                  <div className="space-y-4">
                    {[
                      { name: "radius-xs", px: 6, use: "Tags, chips" },
                      { name: "radius-sm", px: 10, use: "Buttons, inputs" },
                      { name: "radius-md", px: 14, use: "Cards, groups" },
                      { name: "radius-lg", px: 20, use: "Sheets, modals" },
                      { name: "radius-xl", px: 28, use: "Hero card, icon" },
                      { name: "radius-full", px: 9999, use: "Pills, avatars, toggle" },
                    ].map((r) => (
                      <div key={r.name} className="flex items-center gap-3">
                        <div className="w-10 h-10 bg-secondary border border-border flex-none" style={{ borderRadius: Math.min(r.px, 20) }} />
                        <div>
                          <span className="font-mono text-[12px] text-foreground">{r.px === 9999 ? "∞" : r.px + "px"}</span>
                          <span className="font-mono text-[10px] text-muted-foreground ml-2">{r.name}</span>
                          <p className="text-[11px] text-muted-foreground">{r.use}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                </Card>

                <Card>
                  <p className="text-[11px] font-mono uppercase tracking-widest text-muted-foreground mb-5">Motion</p>
                  <div className="divide-y divide-border">
                    {[
                      { token: "duration-fast", val: "150ms", use: "Hover, focus rings" },
                      { token: "duration-base", val: "250ms", use: "State changes, badges" },
                      { token: "duration-slow", val: "400ms", use: "Sheet presentation" },
                      { token: "easing-spring", val: "spring(1, 80, 20)", use: "All iOS interactions" },
                      { token: "easing-ease-out", val: "cubic-bezier(0,0,.2,1)", use: "Dismiss / collapse" },
                    ].map((m) => (
                      <div key={m.token} className="flex justify-between items-start gap-2 py-2.5">
                        <span className="font-mono text-[12px]" style={{ color: BRAND.teal }}>{m.token}</span>
                        <div className="text-right">
                          <p className="font-mono text-[11px] text-foreground">{m.val}</p>
                          <p className="font-mono text-[10px] text-muted-foreground">{m.use}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                </Card>
              </div>
            </div>
          </section>
        )}

      </main>

      {/* Footer */}
      <footer className="border-t border-border mt-20 py-8">
        <div className="max-w-6xl mx-auto px-6 flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-2.5">
            <Mascot size={22} />
            <span className="font-mono text-[12px] text-muted-foreground">OpenClaw iOS Style Guide · v1.0 · July 2026</span>
          </div>
          <span className="font-mono text-[11px] text-muted-foreground">Plus Jakarta Sans · DM Sans · JetBrains Mono · SF Symbols</span>
        </div>
      </footer>

      <style>{`
        .font-display { font-family: 'Plus Jakarta Sans', sans-serif; }
        .no-scrollbar::-webkit-scrollbar { display: none; }
        .no-scrollbar { -ms-overflow-style: none; scrollbar-width: none; }
      `}</style>
    </div>
  );
}
