---
summary: "CLI آن بورڈنگ وزارڈ: گیٹ وے، ورک اسپیس، چینلز، اور Skills کے لیے رہنمائی کے ساتھ سیٹ اپ"
read_when:
  - آن بورڈنگ وزارڈ چلانا یا کنفیگر کرنا
  - نئی مشین سیٹ اپ کرنا
title: "آن بورڈنگ وزارڈ (CLI)"
sidebarTitle: "آن بورڈنگ: CLI"
---

# آن بورڈنگ وزارڈ (CLI)

The onboarding wizard is the **recommended** way to set up OpenClaw on macOS,
Linux, or Windows (via WSL2; strongly recommended).
It configures a local Gateway or a remote Gateway connection, plus channels, skills,
and workspace defaults in one guided flow.

```bash
openclaw onboard
```

<Info>
Fastest first chat: open the Control UI (no channel setup needed). Run
`openclaw dashboard` and chat in the browser. Docs: [Dashboard](/web/dashboard).
</Info>

بعد میں دوبارہ کنفیگر کرنے کے لیے:

```bash
openclaw configure
openclaw agents add <name>
```

<Note>
`--json` does not imply non-interactive mode. For scripts, use `--non-interactive`.
</Note>

<Tip>
Recommended: set up a Brave Search API key so the agent can use `web_search`
(`web_fetch` works without a key). Easiest path: `openclaw configure --section web`
which stores `tools.web.search.apiKey`. Docs: [Web tools](/tools/web).
</Tip>

## QuickStart بمقابلہ Advanced

وزارڈ **QuickStart** (ڈیفالٹس) بمقابلہ **Advanced** (مکمل کنٹرول) سے شروع ہوتا ہے۔

<Tabs>
  <Tab title="QuickStart (defaults)">
    - مقامی gateway (loopback)
    - ورک اسپیس ڈیفالٹ (یا موجودہ ورک اسپیس)
    - Gateway پورٹ **18789**
    - Gateway تصدیق **Token** (خودکار طور پر تیار شدہ، حتیٰ کہ loopback پر بھی)
    - Tailscale ایکسپوژر **Off**
    - Telegram + WhatsApp DMs بطورِ ڈیفالٹ **allowlist** پر (آپ سے فون نمبر پوچھا جائے گا)
  </Tab>
  <Tab title="Advanced (full control)">
    - ہر مرحلہ ظاہر کرتا ہے (موڈ، ورک اسپیس، گیٹ وے، چینلز، ڈیمون، Skills)۔
  </Tab>
</Tabs>

## وزارڈ کیا کنفیگر کرتا ہے

**Local mode (default)** آپ کو ان مراحل سے گزارتا ہے:

1. **Model/Auth** — Anthropic API key (recommended), OAuth, OpenAI, or other providers. Pick a default model.
2. **Workspace** — Location for agent files (default `~/.openclaw/workspace`). Seeds bootstrap files.
3. **Gateway** — پورٹ، بائنڈ ایڈریس، تصدیقی موڈ، Tailscale ایکسپوژر۔
4. **Channels** — WhatsApp، Telegram، Discord، Google Chat، Mattermost، Signal، BlueBubbles، یا iMessage۔
5. **Daemon** — LaunchAgent (macOS) یا systemd یوزر یونٹ (Linux/WSL2) انسٹال کرتا ہے۔
6. **Health check** — Gateway شروع کرتا ہے اور تصدیق کرتا ہے کہ یہ چل رہا ہے۔
7. **Skills** — سفارش کردہ Skills اور اختیاری dependencies انسٹال کرتا ہے۔

<Note>
Re-running the wizard does **not** wipe anything unless you explicitly choose **Reset** (or pass `--reset`).
If the config is invalid or contains legacy keys, the wizard asks you to run `openclaw doctor` first.
</Note>

**Remote mode** only configures the local client to connect to a Gateway elsewhere.
It does **not** install or change anything on the remote host.

## ایک اور ایجنٹ شامل کریں

Use `openclaw agents add <name>` to create a separate agent with its own workspace,
sessions, and auth profiles. Running without `--workspace` launches the wizard.

یہ کیا سیٹ کرتا ہے:

- `agents.list[].name`
- `agents.list[].workspace`
- `agents.list[].agentDir`

نوٹس:

- ڈیفالٹ ورک اسپیسز `~/.openclaw/workspace-<agentId>` کی پیروی کرتی ہیں۔
- آنے والے پیغامات روٹ کرنے کے لیے `bindings` شامل کریں (وزارڈ یہ کر سکتا ہے)۔
- غیر تعاملی فلیگز: `--model`, `--agent-dir`, `--bind`, `--non-interactive`۔

## مکمل حوالہ

تفصیلی مرحلہ وار وضاحتوں، غیر تعاملی اسکرپٹنگ، Signal سیٹ اپ،
RPC API، اور ان تمام کنفیگ فیلڈز کی مکمل فہرست کے لیے جو وزارڈ لکھتا ہے، ملاحظہ کریں
[Wizard Reference](/reference/wizard)۔

## متعلقہ دستاویزات

- CLI کمانڈ حوالہ: [`openclaw onboard`](/cli/onboard)
- macOS ایپ آن بورڈنگ: [Onboarding](/start/onboarding)
- ایجنٹ فرسٹ رن رسم: [Agent Bootstrapping](/start/bootstrapping)
