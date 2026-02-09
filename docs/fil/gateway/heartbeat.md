---
summary: "Mga mensahe ng heartbeat polling at mga patakaran sa notification"
read_when:
  - Ina-adjust ang cadence o pagmemensahe ng heartbeat
  - Pagpapasya sa pagitan ng heartbeat at cron para sa mga naka-iskedyul na gawain
title: "Heartbeat"
---

# Heartbeat (Gateway)

> **Heartbeat vs Cron?** Tingnan ang [Cron vs Heartbeat](/automation/cron-vs-heartbeat) para sa gabay kung kailan gagamitin ang bawat isa.

Pinapatakbo ng Heartbeat ang **mga pana-panahong agent turn** sa pangunahing session para makapag-surface ang model ng anumang nangangailangan ng atensyon nang hindi ka binobombahan ng mensahe.

Pag-troubleshoot: [/automation/troubleshooting](/automation/troubleshooting)

## Mabilis na pagsisimula (baguhan)

1. Iwanang naka-enable ang heartbeats (default ay `30m`, o `1h` para sa Anthropic OAuth/setup-token) o magtakda ng sarili mong cadence.
2. Gumawa ng maliit na `HEARTBEAT.md` checklist sa agent workspace (opsyonal ngunit inirerekomenda).
3. Magpasya kung saan mapupunta ang mga heartbeat message (`target: "last"` ang default).
4. Opsyonal: i-enable ang paghahatid ng heartbeat reasoning para sa transparency.
5. Opsyonal: limitahan ang heartbeats sa mga aktibong oras (lokal na oras).

Halimbawang config:

```json5
{
  agents: {
    defaults: {
      heartbeat: {
        every: "30m",
        target: "last",
        // activeHours: { start: "08:00", end: "24:00" },
        // includeReasoning: true, // optional: send separate `Reasoning:` message too
      },
    },
  },
}
```

## Mga default

- 1. Interval: `30m` (o `1h` kapag Anthropic OAuth/setup-token ang natukoy na auth mode). Set `agents.defaults.heartbeat.every` or per-agent `agents.list[].heartbeat.every`; use `0m` to disable.
- Prompt body (configurable via `agents.defaults.heartbeat.prompt`):
  `Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. 6. Kung walang kailangang asikasuhin, sumagot ng HEARTBEAT_OK.`
- The heartbeat prompt is sent **verbatim** as the user message. The system
  prompt includes a “Heartbeat” section and the run is flagged internally.
- Active hours (`heartbeat.activeHours`) are checked in the configured timezone.
  Outside the window, heartbeats are skipped until the next tick inside the window.

## Para saan ang heartbeat prompt

Ang default na prompt ay sadyang malawak:

- **Mga background task**: Ang “Consider outstanding tasks” ay nagtutulak sa agent na suriin
  ang mga follow-up (inbox, kalendaryo, reminders, naka-queue na trabaho) at i-surface ang anumang urgent.
- **Human check-in**: Ang “Checkup sometimes on your human during day time” ay nagtutulak ng
  paminsan-minsang magaan na mensaheng “may kailangan ka ba?”, ngunit iniiwasan ang spam sa gabi
  sa pamamagitan ng paggamit ng iyong naka-configure na lokal na timezone (tingnan ang [/concepts/timezone](/concepts/timezone)).

Kung gusto mong gumawa ang heartbeat ng isang napaka-espesipikong bagay (hal. “check Gmail PubSub
stats” o “verify gateway health”), itakda ang `agents.defaults.heartbeat.prompt` (o
`agents.list[].heartbeat.prompt`) sa isang custom body (ipinapadala verbatim).

## Kontrata ng tugon

- Kung walang nangangailangan ng atensyon, mag-reply ng **`HEARTBEAT_OK`**.
- During heartbeat runs, OpenClaw treats `HEARTBEAT_OK` as an ack when it appears
  at the **start or end** of the reply. The token is stripped and the reply is
  dropped if the remaining content is **≤ `ackMaxChars`** (default: 300).
- Kung lumitaw ang `HEARTBEAT_OK` sa **gitna** ng isang reply, hindi ito tinatrato nang espesyal.
- Para sa mga alert, **huwag** isama ang `HEARTBEAT_OK`; ibalik lamang ang alert text.

Sa labas ng heartbeats, ang mga naliligaw na `HEARTBEAT_OK` sa simula/dulo ng isang mensahe ay tinatanggal
at nilolog; ang isang mensaheng tanging `HEARTBEAT_OK` lamang ay dini-drop.

## Config

```json5
{
  agents: {
    defaults: {
      heartbeat: {
        every: "30m", // default: 30m (0m disables)
        model: "anthropic/claude-opus-4-6",
        includeReasoning: false, // default: false (deliver separate Reasoning: message when available)
        target: "last", // last | none | <channel id> (core or plugin, e.g. "bluebubbles")
        to: "+15551234567", // optional channel-specific override
        accountId: "ops-bot", // optional multi-account channel id
        prompt: "Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.",
        ackMaxChars: 300, // max chars allowed after HEARTBEAT_OK
      },
    },
  },
}
```

### Saklaw at precedence

- Itinatakda ng `agents.defaults.heartbeat` ang global na gawi ng heartbeat.
- Ang `agents.list[].heartbeat` ay nagme-merge sa ibabaw; kung may anumang agent na may `heartbeat` block, **ang mga agent na iyon lang** ang nagpapatakbo ng heartbeats.
- Itinatakda ng `channels.defaults.heartbeat` ang mga default ng visibility para sa lahat ng channel.
- `channels.<channel>.heartbeat` overrides channel defaults.
- `channels.<channel>.accounts.<id>.heartbeat` (multi-account channels) overrides per-channel settings.

### Per-agent na heartbeats

If any `agents.list[]` entry includes a `heartbeat` block, **only those agents**
run heartbeats. The per-agent block merges on top of `agents.defaults.heartbeat`
(so you can set shared defaults once and override per agent).

Halimbawa: dalawang agent, ang pangalawang agent lang ang nagpapatakbo ng heartbeats.

```json5
{
  agents: {
    defaults: {
      heartbeat: {
        every: "30m",
        target: "last",
      },
    },
    list: [
      { id: "main", default: true },
      {
        id: "ops",
        heartbeat: {
          every: "1h",
          target: "whatsapp",
          to: "+15551234567",
          prompt: "Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.",
        },
      },
    ],
  },
}
```

### Halimbawa ng active hours

Limitahan ang heartbeats sa oras ng negosyo sa isang partikular na timezone:

```json5
{
  agents: {
    defaults: {
      heartbeat: {
        every: "30m",
        target: "last",
        activeHours: {
          start: "09:00",
          end: "22:00",
          timezone: "America/New_York", // optional; uses your userTimezone if set, otherwise host tz
        },
      },
    },
  },
}
```

Outside this window (before 9am or after 10pm Eastern), heartbeats are skipped. The next scheduled tick inside the window will run normally.

### Halimbawa ng multi account

Gamitin ang `accountId` para i-target ang isang partikular na account sa mga multi-account channel tulad ng Telegram:

```json5
{
  agents: {
    list: [
      {
        id: "ops",
        heartbeat: {
          every: "1h",
          target: "telegram",
          to: "12345678",
          accountId: "ops-bot",
        },
      },
    ],
  },
  channels: {
    telegram: {
      accounts: {
        "ops-bot": { botToken: "YOUR_TELEGRAM_BOT_TOKEN" },
      },
    },
  },
}
```

### Mga tala sa field

- `every`: interval ng heartbeat (duration string; default unit = minutes).
- `model`: opsyonal na model override para sa mga heartbeat run (`provider/model`).
- `includeReasoning`: kapag naka-enable, ihahatid din ang hiwalay na `Reasoning:` na mensahe kapag available (parehong hugis ng `/reasoning on`).
- `session`: opsyonal na session key para sa mga heartbeat run.
  - `main` (default): pangunahing session ng agent.
  - Explicit na session key (kopyahin mula sa `openclaw sessions --json` o sa [sessions CLI](/cli/sessions)).
  - Mga format ng session key: tingnan ang [Sessions](/concepts/session) at [Groups](/channels/groups).
- `target`:
  - `last` (default): ihatid sa huling ginamit na external channel.
  - explicit na channel: `whatsapp` / `telegram` / `discord` / `googlechat` / `slack` / `msteams` / `signal` / `imessage`.
  - `none`: patakbuhin ang heartbeat ngunit **huwag maghatid** nang external.
- `to`: optional recipient override (channel-specific id, e.g. E.164 for WhatsApp or a Telegram chat id).
- 23. `accountId`: opsyonal na account id para sa mga multi-account channel. When `target: "last"`, the account id applies to the resolved last channel if it supports accounts; otherwise it is ignored. If the account id does not match a configured account for the resolved channel, delivery is skipped.
- `prompt`: nag-o-override sa default na prompt body (hindi mina-merge).
- `ackMaxChars`: max na mga char na pinapayagan pagkatapos ng `HEARTBEAT_OK` bago ang paghahatid.
- `activeHours`: restricts heartbeat runs to a time window. Object with `start` (HH:MM, inclusive), `end` (HH:MM exclusive; `24:00` allowed for end-of-day), and optional `timezone`.
  - Omitted o `"user"`: ginagamit ang iyong `agents.defaults.userTimezone` kung naka-set, kung hindi ay babalik sa timezone ng host system.
  - `"local"`: palaging ginagamit ang timezone ng host system.
  - Anumang IANA identifier (hal. `America/New_York`): direktang ginagamit; kung invalid, babalik sa gawi ng `"user"` sa itaas.
  - Sa labas ng active window, nilalaktawan ang heartbeats hanggang sa susunod na tick sa loob ng window.

## Gawi ng paghahatid

- Heartbeats run in the agent’s main session by default (`agent:<id>:<mainKey>`),
  or `global` when `session.scope = "global"`. Set `session` to override to a
  specific channel session (Discord/WhatsApp/etc.).
- Ang `session` ay nakakaapekto lamang sa run context; ang paghahatid ay kinokontrol ng `target` at `to`.
- To deliver to a specific channel/recipient, set `target` + `to`. 31. Kapag may
  `target: "last"`, ginagamit ng delivery ang huling external channel para sa session na iyon.
- Kung abala ang pangunahing queue, nilalaktawan ang heartbeat at muling susubukan sa ibang pagkakataon.
- Kung ang `target` ay nagre-resolve sa walang external na destinasyon, magaganap pa rin ang run ngunit walang
  outbound na mensaheng ipapadala.
- Ang mga heartbeat-only na reply ay **hindi** nagpapanatiling buhay ng session; ibinabalik ang huling `updatedAt`
  kaya normal ang gawi ng idle expiry.

## Mga kontrol sa visibility

32. Bilang default, ang mga pagkilala ng `HEARTBEAT_OK` ay pinipigilan habang ang alert content ay
    inihahatid. 33. Maaari mo itong isaayos per channel o per account:

```yaml
channels:
  defaults:
    heartbeat:
      showOk: false # Hide HEARTBEAT_OK (default)
      showAlerts: true # Show alert messages (default)
      useIndicator: true # Emit indicator events (default)
  telegram:
    heartbeat:
      showOk: true # Show OK acknowledgments on Telegram
  whatsapp:
    accounts:
      work:
        heartbeat:
          showAlerts: false # Suppress alert delivery for this account
```

Precedence: per-account → per-channel → mga default ng channel → built-in na mga default.

### Ano ang ginagawa ng bawat flag

- `showOk`: nagpapadala ng `HEARTBEAT_OK` acknowledgment kapag OK-only ang reply ng model.
- `showAlerts`: nagpapadala ng alert content kapag non-OK ang reply ng model.
- `useIndicator`: naglalabas ng mga indicator event para sa mga UI status surface.

Kung **lahat ng tatlo** ay false, nilalaktawan ng OpenClaw ang heartbeat run nang buo (walang model call).

### Mga halimbawa ng per-channel vs per-account

```yaml
channels:
  defaults:
    heartbeat:
      showOk: false
      showAlerts: true
      useIndicator: true
  slack:
    heartbeat:
      showOk: true # all Slack accounts
    accounts:
      ops:
        heartbeat:
          showAlerts: false # suppress alerts for the ops account only
  telegram:
    heartbeat:
      showOk: true
```

### Mga karaniwang pattern

| Layunin                                                                | Config                                                                                   |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Default na gawi (tahimik na OK, naka-on ang alerts) | _(walang kailangang config)_                                          |
| Ganap na tahimik (walang mensahe, walang indicator) | `channels.defaults.heartbeat: { showOk: false, showAlerts: false, useIndicator: false }` |
| Indicator-only (walang mensahe)                     | `channels.defaults.heartbeat: { showOk: false, showAlerts: false, useIndicator: true }`  |
| OK sa isang channel lang                                               | `channels.telegram.heartbeat: { showOk: true }`                                          |

## HEARTBEAT.md (opsyonal)

If a `HEARTBEAT.md` file exists in the workspace, the default prompt tells the
agent to read it. 1. Isipin ito bilang iyong “heartbeat checklist”: maliit, matatag, at
ligtas na isama tuwing bawat 30 minuto.

2. Kung umiiral ang `HEARTBEAT.md` ngunit epektibong walang laman (mga blangkong linya lamang at mga markdown
   header tulad ng `# Heading`), nilalaktawan ng OpenClaw ang heartbeat run upang makatipid ng API calls.
   Kung nawawala ang file, tatakbo pa rin ang heartbeat at ang model ang magpapasya kung ano ang gagawin.

Panatilihin itong maliit (maikling checklist o mga paalala) para maiwasan ang prompt bloat.

Halimbawang `HEARTBEAT.md`:

```md
# Heartbeat checklist

- Quick scan: anything urgent in inboxes?
- If it’s daytime, do a lightweight check-in if nothing else is pending.
- If a task is blocked, write down _what is missing_ and ask Peter next time.
```

### Maaari bang i-update ng agent ang HEARTBEAT.md?

Oo — kung hihilingin mo ito.

Ang `HEARTBEAT.md` ay isang normal na file lang sa agent workspace, kaya maaari mong sabihin sa
agent (sa isang normal na chat) ang tulad ng:

- “I-update ang `HEARTBEAT.md` para magdagdag ng pang-araw-araw na calendar check.”
- “Isulat muli ang `HEARTBEAT.md` para mas maikli at nakatuon sa mga follow-up sa inbox.”

Kung gusto mong mangyari ito nang proactive, maaari ka ring magsama ng isang tahasang linya sa
iyong heartbeat prompt tulad ng: “Kung luma na ang checklist, i-update ang HEARTBEAT.md
ng mas maayos.”

Paalalang pangkaligtasan: huwag maglagay ng mga lihim (API keys, phone number, private token) sa
`HEARTBEAT.md` — nagiging bahagi ito ng prompt context.

## Manual wake (on-demand)

Maaari kang mag-enqueue ng isang system event at mag-trigger ng agarang heartbeat gamit ang:

```bash
openclaw system event --text "Check for urgent follow-ups" --mode now
```

Kung maraming agent ang may naka-configure na `heartbeat`, ang manual wake ay agad na
tatakbo ang bawat isa sa mga agent heartbeat na iyon.

Gamitin ang `--mode next-heartbeat` para maghintay sa susunod na naka-iskedyul na tick.

## Paghahatid ng reasoning (opsyonal)

Bilang default, ang heartbeats ay naghahatid lamang ng huling payload na “answer”.

Kung gusto mo ng transparency, i-enable ang:

- `agents.defaults.heartbeat.includeReasoning: true`

37. Kapag naka-enable, ang mga heartbeat ay maghahatid din ng hiwalay na mensaheng may prefix na
    `Reasoning:` (kaparehong hugis ng `/reasoning on`). 3. Maaari itong maging kapaki-pakinabang kapag ang agent
    ay namamahala ng maraming session/codex at gusto mong makita kung bakit nito napiling i-ping
    ka — ngunit maaari rin itong maglabas ng mas maraming panloob na detalye kaysa sa gusto mo. 39. Mas mainam na panatilihin itong
    off sa mga group chat.

## Kamalayan sa gastos

40. Ang mga heartbeat ay nagpapatakbo ng buong agent turns. 41. Mas maiikling interval ang kumokonsumo ng mas maraming token. 4. Panatilihing maliit ang
    `HEARTBEAT.md` at isaalang-alang ang mas murang `model` o `target: "none"` kung
    panloob na state updates lamang ang gusto mo.
