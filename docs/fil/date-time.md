---
summary: "Paghawak ng petsa at oras sa mga envelope, prompt, tool, at connector"
read_when:
  - Binabago mo kung paano ipinapakita ang mga timestamp sa model o mga user
  - Nagde-debug ka ng pag-format ng oras sa mga mensahe o output ng system prompt
title: "Petsa at Oras"
---

# Petsa at Oras

OpenClaw defaults to **host-local time for transport timestamps** and **user timezone only in the system prompt**.
Provider timestamps are preserved so tools keep their native semantics (current time is available via `session_status`).

## Mga message envelope (local bilang default)

Ang mga papasok na mensahe ay binabalot ng isang timestamp (precision sa minuto):

```
[Provider ... 2026-01-05 16:26 PST] message text
```

Ang timestamp ng envelope na ito ay **host-local bilang default**, anuman ang timezone ng provider.

Maaari mong i-override ang behavior na ito:

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

- Gumagamit ang `envelopeTimezone: "utc"` ng UTC.
- Gumagamit ang `envelopeTimezone: "local"` ng timezone ng host.
- Gumagamit ang `envelopeTimezone: "user"` ng `agents.defaults.userTimezone` (bumabalik sa timezone ng host).
- Gumamit ng tahasang IANA timezone (hal., `"America/Chicago"`) para sa isang fixed na zone.
- Inaalis ng `envelopeTimestamp: "off"` ang mga absolute timestamp mula sa mga header ng envelope.
- Inaalis ng `envelopeElapsed: "off"` ang mga suffix ng lumipas na oras (ang istilong `+2m`).

### Mga halimbawa

**Local (default):**

```
[WhatsApp +1555 2026-01-18 00:19 PST] hello
```

**Timezone ng user:**

```
[WhatsApp +1555 2026-01-18 00:19 CST] hello
```

**Naka-enable ang lumipas na oras:**

```
[WhatsApp +1555 +30s 2026-01-18T05:19Z] follow-up
```

## System prompt: Kasalukuyang Petsa at Oras

Kung alam ang timezone ng user, ang system prompt ay may kasamang nakalaang seksyong
**Kasalukuyang Petsa at Oras** na may **timezone lamang** (walang clock/time format)
upang panatilihing stable ang prompt caching:

```
Time zone: America/Chicago
```

Kapag kailangan ng agent ang kasalukuyang oras, gamitin ang tool na `session_status`; ang status
card ay may kasamang linya ng timestamp.

## Mga linya ng system event (local bilang default)

Ang mga naka-queue na system event na isinisingit sa context ng agent ay may prefix na timestamp gamit ang
kaparehong pagpili ng timezone tulad ng sa mga message envelope (default: host-local).

```
System: [2026-01-12 12:19:17 PST] Model switched.
```

### I-configure ang timezone + format ng user

```json5
{
  agents: {
    defaults: {
      userTimezone: "America/Chicago",
      timeFormat: "auto", // auto | 12 | 24
    },
  },
}
```

- Itinatakda ng `userTimezone` ang **user-local timezone** para sa prompt context.
- `timeFormat` controls **12h/24h display** in the prompt. `auto` follows OS prefs.

## Time format detection (auto)

When `timeFormat: "auto"`, OpenClaw inspects the OS preference (macOS/Windows)
and falls back to locale formatting. The detected value is **cached per process**
to avoid repeated system calls.

## Mga tool payload + connector (raw na oras ng provider + mga normalized na field)

Ang mga channel tool ay nagbabalik ng **provider-native na mga timestamp** at nagdaragdag ng mga normalized na field para sa consistency:

- `timestampMs`: epoch milliseconds (UTC)
- `timestampUtc`: ISO 8601 UTC string

Pinapanatili ang mga raw na field ng provider upang walang mawala.

- Slack: mga epoch-like na string mula sa API
- Discord: mga UTC ISO timestamp
- Telegram/WhatsApp: mga provider-specific na numeric/ISO timestamp

Kung kailangan mo ng local na oras, i-convert ito downstream gamit ang kilalang timezone.

## Kaugnay na docs

- [System Prompt](/concepts/system-prompt)
- [Timezones](/concepts/timezone)
- [Messages](/concepts/messages)
