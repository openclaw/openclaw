---
summary: "Masusing pagtalakay: session store + mga transcript, lifecycle, at mga internal ng (auto)compaction"
read_when:
  - Kailangan mong mag-debug ng mga session id, transcript JSONL, o mga field ng sessions.json
  - Binabago mo ang gawi ng auto-compaction o nagdaragdag ng “pre-compaction” housekeeping
  - Gusto mong magpatupad ng mga memory flush o silent system turn
title: "Masusing Pag-aaral sa Pamamahala ng Session"
---

# Pamamahala ng Session at Compaction (Masusing Pag-aaral)

Ipinapaliwanag ng dokumentong ito kung paano pinamamahalaan ng OpenClaw ang mga session mula simula hanggang dulo:

- **Session routing** (kung paano naimapa ang mga papasok na mensahe sa isang `sessionKey`)
- **Session store** (`sessions.json`) at kung ano ang tina-track nito
- **Transcript persistence** (`*.jsonl`) at ang istruktura nito
- **Transcript hygiene** (mga provider-specific na ayos bago tumakbo)
- **Context limits** (context window vs mga naka-track na token)
- **Compaction** (manual + auto-compaction) at kung saan ikinakabit ang pre-compaction na gawain
- **Silent housekeeping** (hal. mga memory write na hindi dapat maglabas ng output na nakikita ng user)

Kung gusto mo munang magkaroon ng mas mataas na antas na overview, magsimula sa:

- [/concepts/session](/concepts/session)
- [/concepts/compaction](/concepts/compaction)
- [/concepts/session-pruning](/concepts/session-pruning)
- [/reference/transcript-hygiene](/reference/transcript-hygiene)

---

## Pinagmumulan ng katotohanan: ang Gateway

Ang OpenClaw ay idinisenyo sa paligid ng isang **Gateway process** na may-ari ng estado ng session.

- Ang mga UI (macOS app, web Control UI, TUI) ay dapat mag-query sa Gateway para sa mga listahan ng session at bilang ng token.
- Sa remote mode, ang mga session file ay nasa remote host; ang “pag-check ng lokal mong Mac files” ay hindi magpapakita ng aktwal na ginagamit ng Gateway.

---

## Dalawang persistence layer

Ipinapersist ng OpenClaw ang mga session sa dalawang layer:

1. **Session store (`sessions.json`)**
   - Key/value map: `sessionKey -> SessionEntry`
   - Maliit, mutable, at ligtas i-edit (o mag-delete ng mga entry)
   - Tina-track ang metadata ng session (kasalukuyang session id, huling aktibidad, mga toggle, mga counter ng token, atbp.)

2. **Transcript (`<sessionId>.jsonl`)**
   - Append-only na transcript na may tree structure (ang mga entry ay may `id` + `parentId`)
   - Nagtatago ng aktwal na usapan + mga tool call + mga buod ng compaction
   - Ginagamit para buuing muli ang context ng model para sa mga susunod na turn

---

## Mga lokasyon sa disk

Bawat agent, sa host ng Gateway:

- Store: `~/.openclaw/agents/<agentId>/sessions/sessions.json`
- Mga transcript: `~/.openclaw/agents/<agentId>/sessions/<sessionId>.jsonl`
  - Mga Telegram topic session: `.../<sessionId>-topic-<threadId>.jsonl`

Nire-resolve ng OpenClaw ang mga ito sa pamamagitan ng `src/config/sessions.ts`.

---

## Mga session key (`sessionKey`)

Ang isang `sessionKey` ay tumutukoy kung _aling conversation bucket_ ka naroroon (routing + isolation).

Karaniwang mga pattern:

- Pangunahing/direktang chat (bawat agent): `agent:<agentId>:<mainKey>` (default `main`)
- Grupo: `agent:<agentId>:<channel>:group:<id>`
- Room/channel (Discord/Slack): `agent:<agentId>:<channel>:channel:<id>` o `...:room:<id>`
- Cron: `cron:<job.id>`
- Webhook: `hook:<uuid>` (maliban kung na-override)

Ang mga canonical na patakaran ay nakadokumento sa [/concepts/session](/concepts/session).

---

## Mga session id (`sessionId`)

Ang bawat `sessionKey` ay tumuturo sa isang kasalukuyang `sessionId` (ang transcript file na nagpapatuloy ng usapan).

Mga patnubay:

- **Reset** (`/new`, `/reset`) ay lumilikha ng bagong `sessionId` para sa `sessionKey` na iyon.
- **Daily reset** (default na 4:00 AM lokal na oras sa host ng Gateway) ay lumilikha ng bagong `sessionId` sa susunod na mensahe matapos ang hangganan ng reset.
- **Idle expiry** (`session.reset.idleMinutes` or legacy `session.idleMinutes`) creates a new `sessionId` when a message arrives after the idle window. When daily + idle are both configured, whichever expires first wins.

Detalye ng implementasyon: ang desisyon ay nangyayari sa `initSessionState()` sa `src/auto-reply/reply/session.ts`.

---

## Schema ng session store (`sessions.json`)

Ang value type ng store ay `SessionEntry` sa `src/config/sessions.ts`.

Mahahalagang field (hindi kumpleto):

- `sessionId`: kasalukuyang transcript id (ang filename ay hinango rito maliban kung naka-set ang `sessionFile`)
- `updatedAt`: timestamp ng huling aktibidad
- `sessionFile`: opsyonal na tahasang override ng transcript path
- `chatType`: `direct | group | room` (tumutulong sa mga UI at send policy)
- `provider`, `subject`, `room`, `space`, `displayName`: metadata para sa pag-label ng group/channel
- Mga toggle:
  - `thinkingLevel`, `verboseLevel`, `reasoningLevel`, `elevatedLevel`
  - `sendPolicy` (per-session override)
- Pagpili ng model:
  - `providerOverride`, `modelOverride`, `authProfileOverride`
- Mga counter ng token (best-effort / provider-dependent):
  - `inputTokens`, `outputTokens`, `totalTokens`, `contextTokens`
- `compactionCount`: gaano kadalas nakumpleto ang auto-compaction para sa session key na ito
- `memoryFlushAt`: timestamp ng huling pre-compaction memory flush
- `memoryFlushCompactionCount`: bilang ng compaction noong huling tumakbo ang flush

Ligtas i-edit ang store, ngunit ang Gateway ang may awtoridad: maaari nitong muling isulat o i-rehydrate ang mga entry habang tumatakbo ang mga session.

---

## Istruktura ng transcript (`*.jsonl`)

Ang mga transcript ay pinamamahalaan ng `@mariozechner/pi-coding-agent` na `SessionManager`.

Ang file ay JSONL:

- Unang linya: session header (`type: "session"`, kasama ang `id`, `cwd`, `timestamp`, opsyonal na `parentSession`)
- Pagkatapos: mga entry ng session na may `id` + `parentId` (tree)

Mga kapansin-pansing uri ng entry:

- `message`: mga mensahe ng user/assistant/toolResult
- `custom_message`: mga mensaheng in-inject ng extension na _pumapasok_ sa model context (maaaring itago sa UI)
- `custom`: estado ng extension na _hindi_ pumapasok sa model context
- `compaction`: persisted na buod ng compaction na may `firstKeptEntryId` at `tokensBefore`
- `branch_summary`: persisted na buod kapag nagna-navigate ng isang tree branch

Sinasadya ng OpenClaw na **huwag** “ayusin” ang mga transcript; ginagamit ng Gateway ang `SessionManager` para basahin/isulat ang mga ito.

---

## Mga context window vs mga naka-track na token

Dalawang magkaibang konsepto ang mahalaga:

1. **Model context window**: hard cap bawat model (mga token na nakikita ng model)
2. **Mga counter ng session store**: rolling stats na isinusulat sa `sessions.json` (ginagamit para sa /status at mga dashboard)

Kung nagtu-tune ka ng mga limit:

- Ang context window ay nagmumula sa model catalog (at maaaring i-override sa pamamagitan ng config).
- Ang `contextTokens` sa store ay isang runtime estimate/reporting value; huwag itong ituring na mahigpit na garantiya.

Para sa higit pa, tingnan ang [/token-use](/reference/token-use).

---

## Compaction: ano ito

Ang compaction ay nagbubuod ng mas matatandang usapan sa isang persisted na `compaction` entry sa transcript at pinananatiling buo ang mga kamakailang mensahe.

Pagkatapos ng compaction, makikita ng mga susunod na turn ang:

- Ang buod ng compaction
- Mga mensahe pagkatapos ng `firstKeptEntryId`

Compaction is **persistent** (unlike session pruning). See [/concepts/session-pruning](/concepts/session-pruning).

---

## Kailan nangyayari ang auto-compaction (Pi runtime)

Sa embedded Pi agent, nagti-trigger ang auto-compaction sa dalawang kaso:

1. **Overflow recovery**: nagbalik ang model ng context overflow error → compact → retry.
2. **Threshold maintenance**: matapos ang isang matagumpay na turn, kapag:

`contextTokens > contextWindow - reserveTokens`

Kung saan:

- Ang `contextWindow` ay ang context window ng model
- Ang `reserveTokens` ay headroom na nakareserba para sa mga prompt + susunod na output ng model

Ito ay mga semantics ng Pi runtime (kinokonsumo ng OpenClaw ang mga event, ngunit ang Pi ang nagdedesisyon kung kailan magko-compact).

---

## Mga setting ng compaction (`reserveTokens`, `keepRecentTokens`)

Ang mga setting ng compaction ng Pi ay nasa mga setting ng Pi:

```json5
{
  compaction: {
    enabled: true,
    reserveTokens: 16384,
    keepRecentTokens: 20000,
  },
}
```

Nagpapatupad din ang OpenClaw ng safety floor para sa mga embedded run:

- Kung `compaction.reserveTokens < reserveTokensFloor`, itinataas ito ng OpenClaw.
- Ang default na floor ay `20000` na mga token.
- I-set ang `agents.defaults.compaction.reserveTokensFloor: 0` para i-disable ang floor.
- Kung mas mataas na ito, hinahayaan lang ito ng OpenClaw.

Bakit: mag-iwan ng sapat na headroom para sa mga multi-turn na “housekeeping” (tulad ng mga memory write) bago maging hindi maiiwasan ang compaction.

Implementasyon: `ensurePiCompactionReserveTokens()` sa `src/agents/pi-settings.ts`
(tinatawag mula sa `src/agents/pi-embedded-runner.ts`).

---

## Mga surface na nakikita ng user

Maaari mong obserbahan ang compaction at estado ng session sa pamamagitan ng:

- `/status` (sa anumang chat session)
- `openclaw status` (CLI)
- `openclaw sessions` / `sessions --json`
- Verbose mode: `🧹 Auto-compaction complete` + bilang ng compaction

---

## Silent housekeeping (`NO_REPLY`)

Sinusuportahan ng OpenClaw ang mga “silent” turn para sa mga background task kung saan hindi dapat makita ng user ang mga intermediate output.

Konbensyon:

- Sinisimulan ng assistant ang output nito sa `NO_REPLY` upang ipahiwatig na “huwag maghatid ng sagot sa user”.
- Inaalis/isinusupres ng OpenClaw ito sa delivery layer.

Simula `2026.1.10`, sinusuportahan din ng OpenClaw ang **draft/typing streaming** kapag ang isang partial chunk ay nagsisimula sa `NO_REPLY`, kaya hindi tumatagas ang partial output sa kalagitnaan ng turn para sa mga silent operation.

---

## Pre-compaction “memory flush” (ipinatupad)

Layunin: bago mangyari ang auto-compaction, magpatakbo ng isang silent na agentic turn na nagsusulat ng durable
na estado sa disk (hal. `memory/YYYY-MM-DD.md` sa workspace ng agent) upang hindi
mabura ng compaction ang kritikal na context.

Ginagamit ng OpenClaw ang **pre-threshold flush** na approach:

1. Subaybayan ang paggamit ng session context.
2. Kapag tumawid ito sa isang “soft threshold” (mas mababa kaysa sa compaction threshold ng Pi), magpatakbo ng silent
   na direktibang “isulat na ang memory” sa agent.
3. Gamitin ang `NO_REPLY` upang walang makita ang user.

Config (`agents.defaults.compaction.memoryFlush`):

- `enabled` (default: `true`)
- `softThresholdTokens` (default: `4000`)
- `prompt` (mensahe ng user para sa flush turn)
- `systemPrompt` (dagdag na system prompt na idinadagdag para sa flush turn)

Mga tala:

- Ang default na prompt/system prompt ay may kasamang `NO_REPLY` na hint upang supresahin ang delivery.
- Ang flush ay tumatakbo isang beses bawat compaction cycle (tina-track sa `sessions.json`).
- Ang flush ay tumatakbo lamang para sa mga embedded Pi session (nilalaktawan ito ng mga CLI backend).
- Nilalaktawan ang flush kapag read-only ang workspace ng session (`workspaceAccess: "ro"` o `"none"`).
- Tingnan ang [Memory](/concepts/memory) para sa layout ng workspace file at mga pattern ng pagsusulat.

Naglalantad din ang Pi ng isang `session_before_compact` hook sa extension API, ngunit ang lohika ng flush ng OpenClaw ay nasa panig ng Gateway sa ngayon.

---

## Checklist sa pag-troubleshoot

- Session key wrong? Start with [/concepts/session](/concepts/session) and confirm the `sessionKey` in `/status`.
- Store vs transcript mismatch? Confirm the Gateway host and the store path from `openclaw status`.
- Compaction spam? Check:
  - context window ng model (masyadong maliit)
  - mga setting ng compaction (`reserveTokens` na masyadong mataas para sa window ng model ay maaaring magdulot ng mas maagang compaction)
  - tool-result bloat: i-enable/i-tune ang session pruning
- Silent turns leaking? Confirm the reply starts with `NO_REPLY` (exact token) and you’re on a build that includes the streaming suppression fix.
