#!/usr/bin/env python3
"""Generate OpenClaw architecture diagram as PNG using Pillow."""

from PIL import Image, ImageDraw, ImageFont
import os

# --- Canvas setup ---
W, H = 2400, 2000
bg = "#0d1117"
img = Image.new("RGB", (W, H), bg)
draw = ImageDraw.Draw(img)

# --- Colors ---
C = {
    "title": "#e6edf3",
    "subtitle": "#8b949e",
    "box_border": "#30363d",
    "gateway": "#1f6feb",
    "gateway_fill": "#0d1b2a",
    "agent": "#8957e5",
    "agent_fill": "#1a0d2e",
    "channel": "#238636",
    "channel_fill": "#0d1a0d",
    "memory": "#d29922",
    "memory_fill": "#1a1500",
    "plugin": "#f78166",
    "plugin_fill": "#1a0d09",
    "ui": "#39d353",
    "ui_fill": "#0d1a0d",
    "apps": "#79c0ff",
    "apps_fill": "#0d1520",
    "infra": "#8b949e",
    "infra_fill": "#161b22",
    "arrow": "#484f58",
    "arrow_hi": "#58a6ff",
    "text": "#e6edf3",
    "text_dim": "#8b949e",
    "text_dark": "#c9d1d9",
    "white": "#ffffff",
}


def try_font(size, bold=False):
    """Try to load a font, fall back to default."""
    paths = [
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf" if bold else "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf" if bold else "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
        "/usr/share/fonts/truetype/freefont/FreeSansBold.ttf" if bold else "/usr/share/fonts/truetype/freefont/FreeSans.ttf",
    ]
    for p in paths:
        if os.path.exists(p):
            return ImageFont.truetype(p, size)
    return ImageFont.load_default()


font_title = try_font(42, bold=True)
font_section = try_font(24, bold=True)
font_label = try_font(18, bold=True)
font_small = try_font(15)
font_tiny = try_font(13)


def rounded_rect(x, y, w, h, r, fill, outline, lw=2):
    """Draw a rounded rectangle."""
    draw.rounded_rectangle([x, y, x + w, y + h], radius=r, fill=fill, outline=outline, width=lw)


def draw_box(x, y, w, h, title, items, color, fill_color, icon=""):
    """Draw a labeled box with items."""
    rounded_rect(x, y, w, h, 12, fill_color, color, 2)
    # Title bar
    draw.rounded_rectangle([x, y, x + w, y + 36], radius=12, fill=color, outline=color, width=0)
    # Fix bottom corners of title bar
    draw.rectangle([x + 1, y + 24, x + w - 1, y + 36], fill=color)
    label = f"{icon}  {title}" if icon else title
    bbox = draw.textbbox((0, 0), label, font=font_label)
    tw = bbox[2] - bbox[0]
    draw.text((x + (w - tw) // 2, y + 8), label, fill=C["white"], font=font_label)
    # Items
    for i, item in enumerate(items):
        draw.text((x + 14, y + 46 + i * 22), item, fill=C["text_dark"], font=font_small)


def draw_arrow(x1, y1, x2, y2, color=None, dashed=False):
    """Draw an arrow from (x1,y1) to (x2,y2)."""
    c = color or C["arrow_hi"]
    draw.line([(x1, y1), (x2, y2)], fill=c, width=2)
    # Arrowhead
    import math
    angle = math.atan2(y2 - y1, x2 - x1)
    size = 10
    draw.polygon([
        (x2, y2),
        (x2 - size * math.cos(angle - 0.4), y2 - size * math.sin(angle - 0.4)),
        (x2 - size * math.cos(angle + 0.4), y2 - size * math.sin(angle + 0.4)),
    ], fill=c)


def draw_double_arrow(x1, y1, x2, y2, color=None):
    """Draw a double-headed arrow."""
    c = color or C["arrow_hi"]
    draw.line([(x1, y1), (x2, y2)], fill=c, width=2)
    import math
    angle = math.atan2(y2 - y1, x2 - x1)
    size = 10
    draw.polygon([
        (x2, y2),
        (x2 - size * math.cos(angle - 0.4), y2 - size * math.sin(angle - 0.4)),
        (x2 - size * math.cos(angle + 0.4), y2 - size * math.sin(angle + 0.4)),
    ], fill=c)
    angle2 = math.atan2(y1 - y2, x1 - x2)
    draw.polygon([
        (x1, y1),
        (x1 - size * math.cos(angle2 - 0.4), y1 - size * math.sin(angle2 - 0.4)),
        (x1 - size * math.cos(angle2 + 0.4), y1 - size * math.sin(angle2 + 0.4)),
    ], fill=c)


# ============================================================
# Title
# ============================================================
title = "OpenClaw Architecture"
bbox = draw.textbbox((0, 0), title, font=font_title)
tw = bbox[2] - bbox[0]
draw.text(((W - tw) // 2, 24), title, fill=C["title"], font=font_title)

subtitle = "Multi-Channel AI Gateway & Personal Assistant Platform"
bbox2 = draw.textbbox((0, 0), subtitle, font=font_small)
tw2 = bbox2[2] - bbox2[0]
draw.text(((W - tw2) // 2, 74), subtitle, fill=C["subtitle"], font=font_small)

# ============================================================
# Layer 1: Clients / Companion Apps (top)
# ============================================================
y_clients = 110
draw.text((60, y_clients), "CLIENTS & COMPANION APPS", fill=C["subtitle"], font=font_section)

# macOS App
draw_box(60, y_clients + 36, 280, 130,
         "macOS App", [
             "Swift / SwiftUI",
             "Menubar gateway host",
             "Voice wake, Talk mode",
             "apps/macos/",
         ], C["apps"], C["apps_fill"], icon="\u25A3")

# iOS App
draw_box(370, y_clients + 36, 280, 130,
         "iOS App", [
             "Swift / SwiftUI",
             "OpenClawKit shared",
             "Device node bridge",
             "apps/ios/",
         ], C["apps"], C["apps_fill"], icon="\u25A3")

# Android App
draw_box(680, y_clients + 36, 280, 130,
         "Android App", [
             "Kotlin / Gradle",
             "Device node bridge",
             "WebSocket to gateway",
             "apps/android/",
         ], C["apps"], C["apps_fill"], icon="\u25A3")

# Web UI
draw_box(990, y_clients + 36, 280, 130,
         "Web UI", [
             "Lit 3 web components",
             "Vite 7 build",
             "Served at / and /ui/",
             "ui/",
         ], C["ui"], C["ui_fill"], icon="\u25C9")

# CLI
draw_box(1300, y_clients + 36, 280, 130,
         "CLI", [
             "Commander v14",
             "openclaw.mjs entry",
             "TUI (terminal UI)",
             "src/cli/, src/commands/",
         ], C["infra"], C["infra_fill"], icon=">_")

# WebChat
draw_box(1610, y_clients + 36, 280, 130,
         "WebChat", [
             "Browser-based chat",
             "WebSocket client",
             "src/webchat/",
         ], C["ui"], C["ui_fill"], icon="\u25CB")

# Arrows from clients down to gateway
for cx in [200, 510, 820, 1130, 1440, 1750]:
    draw_arrow(cx, y_clients + 170, cx, y_clients + 210, C["arrow_hi"])

# ============================================================
# Layer 2: Gateway (control plane)
# ============================================================
y_gw = y_clients + 210
# Big gateway box
rounded_rect(40, y_gw, W - 80, 260, 14, C["gateway_fill"], C["gateway"], 3)
draw.rounded_rectangle([40, y_gw, W - 80, y_gw + 42], radius=14, fill=C["gateway"], outline=C["gateway"], width=0)
draw.rectangle([41, y_gw + 30, W - 81, y_gw + 42], fill=C["gateway"])
gw_title = "GATEWAY  —  WebSocket Control Plane (src/gateway/)  —  default port 18789"
bbox = draw.textbbox((0, 0), gw_title, font=font_label)
tw = bbox[2] - bbox[0]
draw.text(((W - tw) // 2, y_gw + 10), gw_title, fill=C["white"], font=font_label)

# Sub-boxes inside gateway
gw_y = y_gw + 54
draw_box(70, gw_y, 320, 120,
         "Server & Protocol", [
             "Express 5 + Hono HTTP",
             "WebSocket (ws) connections",
             "Bridge protocol (device nodes)",
             "Auth, CORS, Tailscale",
         ], "#30363d", "#161b22")

draw_box(420, gw_y, 320, 120,
         "Config & Sessions", [
             "~/.openclaw/config.yaml (Zod)",
             "Session model (main + group)",
             "src/config/, src/sessions/",
         ], "#30363d", "#161b22")

draw_box(770, gw_y, 320, 120,
         "Routing & Channels", [
             "Message routing logic",
             "Channel adapter dispatch",
             "Allowlists, pairing, gating",
             "src/routing/, src/channels/",
         ], "#30363d", "#161b22")

draw_box(1120, gw_y, 320, 120,
         "Control UI Server", [
             "Serves Web UI (Lit/Vite)",
             "Status, diagnostics, wizard",
             "Gateway server methods",
         ], "#30363d", "#161b22")

draw_box(1470, gw_y, 310, 120,
         "Hooks & Cron", [
             "Hook system (bundled handlers)",
             "Cron scheduling (croner)",
             "src/hooks/, src/cron/",
         ], "#30363d", "#161b22")

# Small labels
draw.text((1810, gw_y + 20), "Gateway also manages:", fill=C["text_dim"], font=font_tiny)
draw.text((1810, gw_y + 40), "- Tool registration", fill=C["text_dim"], font=font_tiny)
draw.text((1810, gw_y + 56), "- Agent lifecycle", fill=C["text_dim"], font=font_tiny)
draw.text((1810, gw_y + 72), "- Plugin loading", fill=C["text_dim"], font=font_tiny)
draw.text((1810, gw_y + 88), "- Media pipeline", fill=C["text_dim"], font=font_tiny)

# ============================================================
# Layer 3: Agent Runtime + Channels + Memory (middle)
# ============================================================
y_mid = y_gw + 280

# Arrows from gateway down
draw_arrow(400, y_gw + 260, 400, y_mid + 10, C["arrow_hi"])
draw_arrow(1000, y_gw + 260, 1000, y_mid + 10, C["arrow_hi"])
draw_arrow(1700, y_gw + 260, 1700, y_mid + 10, C["arrow_hi"])

draw.text((60, y_mid), "CORE RUNTIME", fill=C["subtitle"], font=font_section)

y_rt = y_mid + 36

# Agent Runtime
draw_box(60, y_rt, 460, 200,
         "Agent Runtime (src/agents/)", [
             "Pi agent framework (@mariozechner/pi-*)",
             "Embedded runner (RPC mode)",
             "Tool definitions + streaming",
             "Identity & provider selection",
             "Sandbox paths & approvals",
             "Model scan & failover",
             "Coding agent integration",
         ], C["agent"], C["agent_fill"], icon="\u2699")

# Channels
draw_box(550, y_rt, 550, 200,
         "Messaging Channels", [
             "CORE (src/):  WhatsApp | Telegram | Slack | Discord",
             "               Signal | iMessage | Google Chat | LINE",
             "",
             "EXTENSIONS (extensions/):  MS Teams | Matrix | Zalo",
             "  Mattermost | Nextcloud | Nostr | Twitch | Feishu",
             "  BlueBubbles | Voice Call | Talk Voice",
             "  34 extension packages total",
         ], C["channel"], C["channel_fill"], icon="\u260E")

# Memory
draw_box(1130, y_rt, 440, 200,
         "Memory System (src/memory/)", [
             "SQLite + SQLite-VEC vectors",
             "QMD fast in-memory indexing",
             "Embeddings: OpenAI, Gemini, Voyage",
             "Optional: node-llama-cpp (local)",
             "Async batch indexing + dedup",
             "memory-core & memory-lancedb exts",
         ], C["memory"], C["memory_fill"], icon="\u26A1")

# Plugins & Skills
draw_box(1600, y_rt, 380, 200,
         "Plugins & Skills", [
             "Plugin SDK (openclaw/plugin-sdk)",
             "Runtime loading via jiti alias",
             "52 pre-built skills:",
             "  GitHub, Notion, Obsidian, Canvas,",
             "  1Password, coding-agent, TTS...",
             "Bundled + Managed + Workspace",
         ], C["plugin"], C["plugin_fill"], icon="\u2B22")

# Arrows between runtime boxes
draw_double_arrow(520, y_rt + 100, 550, y_rt + 100, C["arrow_hi"])
draw_double_arrow(1100, y_rt + 100, 1130, y_rt + 100, C["arrow_hi"])
draw_double_arrow(1570, y_rt + 100, 1600, y_rt + 100, C["arrow_hi"])

# ============================================================
# Layer 4: Infrastructure & Support Systems
# ============================================================
y_infra = y_rt + 230
draw.text((60, y_infra), "INFRASTRUCTURE & SUPPORT", fill=C["subtitle"], font=font_section)

y_inf = y_infra + 36

draw_box(60, y_inf, 300, 160,
         "Media Pipeline", [
             "Transcription (Whisper)",
             "Image/video understanding",
             "Sharp image processing",
             "PDF parsing (pdfjs-dist)",
             "src/media/, src/media-understanding/",
         ], C["infra"], C["infra_fill"])

draw_box(390, y_inf, 300, 160,
         "Browser Control", [
             "Playwright CDP integration",
             "A2UI Canvas rendering",
             "Link understanding",
             "src/browser/, src/canvas-host/",
             "vendor/ (A2UI spec)",
         ], C["infra"], C["infra_fill"])

draw_box(720, y_inf, 300, 160,
         "Infra & Config", [
             "Paths, env, dotenv, ports",
             "Error handling framework",
             "Logging (tslog)",
             "Terminal table + palette",
             "src/infra/, src/logging/",
         ], C["infra"], C["infra_fill"])

draw_box(1050, y_inf, 300, 160,
         "Security & Auth", [
             "Credentials (~/.openclaw/creds)",
             "PAM authentication",
             "Gateway token/password",
             "Approval system",
             "src/security/",
         ], C["infra"], C["infra_fill"])

draw_box(1380, y_inf, 300, 160,
         "TTS & Voice", [
             "Text-to-speech (src/tts/)",
             "Voice wake forwarding",
             "Talk mode integration",
             "sherpa-onnx-tts skill",
         ], C["infra"], C["infra_fill"])

draw_box(1710, y_inf, 290, 160,
         "Device & Pairing", [
             "Device node bridge",
             "mDNS discovery (ciao)",
             "Phone control extension",
             "src/pairing/",
         ], C["infra"], C["infra_fill"])

# ============================================================
# Layer 5: Build & Deployment
# ============================================================
y_build = y_inf + 190
draw.text((60, y_build), "BUILD, TEST & DEPLOYMENT", fill=C["subtitle"], font=font_section)

y_b = y_build + 36

draw_box(60, y_b, 380, 180,
         "Build Pipeline", [
             "pnpm install  (deps)",
             "pnpm build    (tsdown bundle)",
             "  1. canvas:a2ui:bundle",
             "  2. tsdown (TS -> dist/)",
             "  3. Plugin SDK DTS generation",
             "  4. Post-build scripts",
             "Output: dist/index.js",
         ], "#da3633", "#1a0d0d")

draw_box(470, y_b, 380, 180,
         "Testing (Vitest 4)", [
             "pnpm test         (unit+integration)",
             "pnpm test:e2e     (end-to-end)",
             "pnpm test:live    (real API keys)",
             "pnpm test:coverage (V8, 70% thresh)",
             "Pool: forks, CI: 3 workers",
             "6 vitest config files",
             "Docker test suites available",
         ], "#da3633", "#1a0d0d")

draw_box(880, y_b, 380, 180,
         "Code Quality", [
             "pnpm check  (type + lint + format)",
             "pnpm tsgo   (TypeScript check)",
             "Oxlint: no-any, curly, strict",
             "Oxfmt: sort imports/scripts",
             "markdownlint-cli2 for docs",
             "swiftlint + swiftformat",
             "Pre-commit hooks via git-hooks/",
         ], "#da3633", "#1a0d0d")

draw_box(1290, y_b, 380, 180,
         "CI/CD (GitHub Actions)", [
             "Scope detection (docs-only skip)",
             "Format -> Lint -> Type -> Test",
             "Build verification",
             "Docker image build & push",
             "Platform builds (macOS, Android)",
             "Install smoke tests",
             "Live model tests (optional)",
         ], "#da3633", "#1a0d0d")

draw_box(1700, y_b, 300, 180,
         "Deployment", [
             "Docker (node:22-bookworm)",
             "  non-root, Bun for builds",
             "docker-compose (gw + cli)",
             "Fly.io (fly.toml)",
             "Render (render.yaml)",
             "npm publish (openclaw)",
             "macOS app notarization",
         ], "#da3633", "#1a0d0d")

# ============================================================
# Bottom: Data model note
# ============================================================
y_bottom = y_b + 200
draw.line([(40, y_bottom), (W - 40, y_bottom)], fill=C["box_border"], width=1)
draw.text((60, y_bottom + 10),
          "DATA MODEL:  local-first, file-based  |  Config: ~/.openclaw/config.yaml  |  Sessions: ~/.openclaw/sessions/  |  "
          "Credentials: ~/.openclaw/credentials/  |  Memory: SQLite-VEC",
          fill=C["text_dim"], font=font_small)

draw.text((60, y_bottom + 34),
          "TECH:  TypeScript ESM  |  Node 22+ / Bun  |  pnpm 10.23+  |  tsdown  |  Vitest 4  |  Oxlint + Oxfmt  |  "
          "Lit 3 + Vite 7  |  Swift/SwiftUI  |  Kotlin/Gradle",
          fill=C["text_dim"], font=font_small)

# ============================================================
# Save
# ============================================================
out_path = "/home/user/openclaw/docs/architecture.png"
img.save(out_path, "PNG", dpi=(144, 144))
print(f"Saved: {out_path} ({os.path.getsize(out_path)} bytes)")
