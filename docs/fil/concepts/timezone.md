---
summary: "Paghawak ng timezone para sa mga agent, envelope, at prompt"
read_when:
  - Kailangan mong maunawaan kung paano ni-normalize ang mga timestamp para sa model
  - Pagko-configure ng timezone ng user para sa mga system prompt
title: "Mga Timezone"
x-i18n:
  source_path: concepts/timezone.md
  source_hash: 9ee809c96897db11
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:45:22Z
---

# Mga Timezone

Ini-standardize ng OpenClaw ang mga timestamp upang makita ng model ang **iisang reference time**.

## Mga message envelope (local bilang default)

Ang mga papasok na mensahe ay binalot sa isang envelope tulad ng:

```
[Provider ... 2026-01-05 16:26 PST] message text
```

Ang timestamp sa envelope ay **host-local bilang default**, na may minutong precision.

Maaari mo itong i-override gamit ang:

```json5
{
  agents: {
    defaults: {
      envelopeTimezone: "local", // "utc" | "local" | "user" | IANA timezone
      envelopeTimestamp: "on", // "on" | "off"
      envelopeElapsed: "on", // "on" | "off"
    },
  },
}
```

- Ang `envelopeTimezone: "utc"` ay gumagamit ng UTC.
- Ang `envelopeTimezone: "user"` ay gumagamit ng `agents.defaults.userTimezone` (bumabalik sa timezone ng host).
- Gumamit ng isang tahasang IANA timezone (hal., `"Europe/Vienna"`) para sa fixed offset.
- Inaalis ng `envelopeTimestamp: "off"` ang mga absolute timestamp mula sa mga header ng envelope.
- Inaalis ng `envelopeElapsed: "off"` ang mga suffix ng elapsed time (ang istilong `+2m`).

### Mga halimbawa

**Local (default):**

```
[Signal Alice +1555 2026-01-18 00:19 PST] hello
```

**Fixed timezone:**

```
[Signal Alice +1555 2026-01-18 06:19 GMT+1] hello
```

**Elapsed time:**

```
[Signal Alice +1555 +2m 2026-01-18T05:19Z] follow-up
```

## Mga tool payload (raw provider data + mga normalized na field)

Ang mga tool call (`channels.discord.readMessages`, `channels.slack.readMessages`, atbp.) ay nagbabalik ng **raw provider timestamps**.
Naglalakip din kami ng mga normalized na field para sa konsistensi:

- `timestampMs` (UTC epoch milliseconds)
- `timestampUtc` (ISO 8601 UTC string)

Pinananatili ang mga raw provider field.

## Timezone ng user para sa system prompt

Itakda ang `agents.defaults.userTimezone` upang ipaalam sa model ang lokal na time zone ng user. Kapag ito ay
hindi nakatakda, nireresolba ng OpenClaw ang **timezone ng host sa runtime** (walang isinusulat na config).

```json5
{
  agents: { defaults: { userTimezone: "America/Chicago" } },
}
```

Kasama sa system prompt ang:

- seksyong `Current Date & Time` na may lokal na oras at timezone
- `Time format: 12-hour` o `24-hour`

Maaari mong kontrolin ang format ng prompt gamit ang `agents.defaults.timeFormat` (`auto` | `12` | `24`).

Tingnan ang [Date & Time](/date-time) para sa kumpletong pag-uugali at mga halimbawa.
