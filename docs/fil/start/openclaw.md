---
summary: "End-to-end na gabay para patakbuhin ang OpenClaw bilang personal assistant na may mga paalala sa kaligtasan"
read_when:
  - Pag-onboard ng bagong instance ng assistant
  - Pagrerepaso ng mga implikasyon sa kaligtasan/pahintulot
title: "Setup ng Personal Assistant"
---

# Pagbuo ng personal assistant gamit ang OpenClaw

Ang OpenClaw ay isang WhatsApp + Telegram + Discord + iMessage gateway para sa mga **Pi** agent. Nagdaragdag ang mga plugin ng Mattermost. Ang gabay na ito ay ang setup ng "personal assistant": isang dedikadong WhatsApp number na kumikilos bilang iyong palaging naka‑on na agent.

## ⚠️ Unahin ang kaligtasan

Naglalagay ka ng agent sa posisyong maaaring:

- magpatakbo ng mga command sa iyong machine (depende sa setup ng Pi tool)
- magbasa/magsulat ng mga file sa iyong workspace
- magpadala ng mga mensahe palabas sa pamamagitan ng WhatsApp/Telegram/Discord/Mattermost (plugin)

Magsimula nang konserbatibo:

- Palaging itakda ang `channels.whatsapp.allowFrom` (huwag kailanman patakbuhin na bukas sa buong mundo sa iyong personal na Mac).
- Gumamit ng dedikadong WhatsApp number para sa assistant.
- Ang mga heartbeat ay naka‑default na ngayon sa bawat 30 minuto. I-disable muna hanggang sa mapagkakatiwalaan mo ang setup sa pamamagitan ng pag‑set ng `agents.defaults.heartbeat.every: "0m"`.

## Mga paunang kinakailangan

- Naka-install at na-onboard na ang OpenClaw — tingnan ang [Getting Started](/start/getting-started) kung hindi mo pa ito nagagawa
- Isang pangalawang numero ng telepono (SIM/eSIM/prepaid) para sa assistant

## Ang two-phone setup (inirerekomenda)

Ito ang gusto mo:

```
Your Phone (personal)          Second Phone (assistant)
┌─────────────────┐           ┌─────────────────┐
│  Your WhatsApp  │  ──────▶  │  Assistant WA   │
│  +1-555-YOU     │  message  │  +1-555-ASSIST  │
└─────────────────┘           └────────┬────────┘
                                       │ linked via QR
                                       ▼
                              ┌─────────────────┐
                              │  Your Mac       │
                              │  (openclaw)      │
                              │    Pi agent     │
                              └─────────────────┘
```

Kung iuugnay mo ang iyong personal na WhatsApp sa OpenClaw, bawat mensahe sa iyo ay nagiging “agent input”. Bihira itong ang gusto mo.

## 5-minutong mabilis na pagsisimula

1. I-pair ang WhatsApp Web (magpapakita ng QR; i-scan gamit ang assistant phone):

```bash
openclaw channels login
```

2. Simulan ang Gateway (iwanang tumatakbo):

```bash
openclaw gateway --port 18789
```

3. Maglagay ng minimal na config sa `~/.openclaw/openclaw.json`:

```json5
{
  channels: { whatsapp: { allowFrom: ["+15555550123"] } },
}
```

Ngayon, mag-message sa assistant number mula sa allowlisted mong phone.

Kapag natapos ang onboarding, awtomatiko naming binubuksan ang dashboard at nagpi‑print ng malinis (walang token) na link. Kung humingi ito ng auth, i‑paste ang token mula sa `gateway.auth.token` sa Control UI settings. Para muling buksan sa ibang oras: `openclaw dashboard`.

## Bigyan ang agent ng workspace (AGENTS)

Binabasa ng OpenClaw ang mga operating instruction at “memory” mula sa directory ng workspace nito.

Bilang default, ginagamit ng OpenClaw ang `~/.openclaw/workspace` bilang agent workspace, at awtomatiko itong lilikhain (kasama ang panimulang `AGENTS.md`, `SOUL.md`, `TOOLS.md`, `IDENTITY.md`, `USER.md`, `HEARTBEAT.md`) sa setup/unang pagtakbo ng agent. Ang `BOOTSTRAP.md` ay nalilikha lamang kapag ang workspace ay ganap na bago (hindi ito dapat bumalik pagkatapos mo itong burahin). Opsyonal ang `MEMORY.md` (hindi awtomatikong nililikha); kapag naroon, ito ay nilo‑load para sa mga normal na session. Ang mga subagent session ay nag‑i‑inject lamang ng `AGENTS.md` at `TOOLS.md`.

Tip: ituring ang folder na ito bilang “memory” ng OpenClaw at gawin itong git repo (mas mainam kung private) upang naka‑backup ang iyong `AGENTS.md` + mga memory file. Kung naka‑install ang git, ang mga bagong workspace ay awtomatikong ini‑initialize.

```bash
openclaw setup
```

Buong layout ng workspace + gabay sa backup: [Agent workspace](/concepts/agent-workspace)  
Workflow ng memory: [Memory](/concepts/memory)

Opsyonal: pumili ng ibang workspace gamit ang `agents.defaults.workspace` (sumusuporta sa `~`).

```json5
{
  agent: {
    workspace: "~/.openclaw/workspace",
  },
}
```

Kung ikaw ay may sarili nang workspace files mula sa isang repo, maaari mong i-disable nang buo ang paggawa ng bootstrap file:

```json5
{
  agent: {
    skipBootstrap: true,
  },
}
```

## Ang config na ginagawang “assistant” ito

May magandang default assistant setup ang OpenClaw, pero karaniwan mong gugustuhing i-tune ang:

- persona/mga instruction sa `SOUL.md`
- mga default sa pag-iisip (kung nais)
- mga heartbeat (kapag mapagkakatiwalaan mo na ito)

Halimbawa:

```json5
{
  logging: { level: "info" },
  agent: {
    model: "anthropic/claude-opus-4-6",
    workspace: "~/.openclaw/workspace",
    thinkingDefault: "high",
    timeoutSeconds: 1800,
    // Start with 0; enable later.
    heartbeat: { every: "0m" },
  },
  channels: {
    whatsapp: {
      allowFrom: ["+15555550123"],
      groups: {
        "*": { requireMention: true },
      },
    },
  },
  routing: {
    groupChat: {
      mentionPatterns: ["@openclaw", "openclaw"],
    },
  },
  session: {
    scope: "per-sender",
    resetTriggers: ["/new", "/reset"],
    reset: {
      mode: "daily",
      atHour: 4,
      idleMinutes: 10080,
    },
  },
}
```

## Mga session at memory

- Mga file ng session: `~/.openclaw/agents/<agentId>/sessions/{{SessionId}}.jsonl`
- Metadata ng session (paggamit ng token, huling route, atbp): `~/.openclaw/agents/<agentId>/sessions/sessions.json` (legacy: `~/.openclaw/sessions/sessions.json`)
- Ang `/new` o `/reset` ay nagsisimula ng sariwang session para sa chat na iyon (na iko‑configure sa `resetTriggers`). Kapag ipinadala nang mag‑isa, sasagot ang agent ng isang maikling hello upang kumpirmahin ang reset.
- Kinokompak ng `/compact [instructions]` ang session context at iniuulat ang natitirang budget ng context.

## Mga heartbeat (proactive mode)

Bilang default, nagpapatakbo ang OpenClaw ng heartbeat bawat 30 minuto na may prompt:
`Read HEARTBEAT.md if it exists (workspace context). Sundin ito nang mahigpit. Huwag mag‑infer o ulitin ang mga lumang gawain mula sa mga naunang chat. Kung walang kailangang asikasuhin, sumagot ng HEARTBEAT_OK.`
I‑set ang `agents.defaults.heartbeat.every: "0m"` upang i‑disable.

- Kung umiiral ang `HEARTBEAT.md` pero epektibong walang laman (mga blankong linya at markdown headers lang gaya ng `# Heading`), nilalaktawan ng OpenClaw ang heartbeat run para makatipid ng API calls.
- Kung nawawala ang file, tatakbo pa rin ang heartbeat at ang model ang magpapasya kung ano ang gagawin.
- Kung sumagot ang agent ng `HEARTBEAT_OK` (opsyonal na may maikling padding; tingnan ang `agents.defaults.heartbeat.ackMaxChars`), pinipigilan ng OpenClaw ang outbound delivery para sa heartbeat na iyon.
- Ang mga heartbeat ay buong agent turns — mas maiikling interval ang mas maraming token ang nauubos.

```json5
{
  agent: {
    heartbeat: { every: "30m" },
  },
}
```

## Media papasok at palabas

Maaaring i-surface ang mga inbound attachment (images/audio/docs) sa iyong command sa pamamagitan ng mga template:

- `{{MediaPath}}` (local temp file path)
- `{{MediaUrl}}` (pseudo-URL)
- `{{Transcript}}` (kung naka-enable ang audio transcription)

Mga outbound attachment mula sa agent: isama ang `MEDIA:<path-or-url>` sa sarili nitong linya (walang espasyo). Halimbawa:

```
Here’s the screenshot.
MEDIA:https://example.com/screenshot.png
```

Kinukuha ng OpenClaw ang mga ito at ipinapadala bilang media kasama ng teksto.

## Checklist sa operasyon

```bash
openclaw status          # local status (creds, sessions, queued events)
openclaw status --all    # full diagnosis (read-only, pasteable)
openclaw status --deep   # adds gateway health probes (Telegram + Discord)
openclaw health --json   # gateway health snapshot (WS)
```

Ang mga log ay nasa `/tmp/openclaw/` (default: `openclaw-YYYY-MM-DD.log`).

## Mga susunod na hakbang

- WebChat: [WebChat](/web/webchat)
- Gateway ops: [Gateway runbook](/gateway)
- Cron + wakeups: [Cron jobs](/automation/cron-jobs)
- macOS menu bar companion: [OpenClaw macOS app](/platforms/macos)
- iOS node app: [iOS app](/platforms/ios)
- Android node app: [Android app](/platforms/android)
- Windows status: [Windows (WSL2)](/platforms/windows)
- Linux status: [Linux app](/platforms/linux)
- Seguridad: [Security](/gateway/security)
