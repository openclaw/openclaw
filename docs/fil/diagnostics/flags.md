---
summary: "Mga diagnostics flag para sa target na debug logs"
read_when:
  - Kailangan mo ng target na debug logs nang hindi itinataas ang global logging levels
  - Kailangan mong kumuha ng mga log na partikular sa subsystem para sa support
title: "Mga Diagnostics Flag"
x-i18n:
  source_path: diagnostics/flags.md
  source_hash: daf0eca0e6bd1cbc
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:45:25Z
---

# Mga Diagnostics Flag

Pinapahintulutan ka ng diagnostics flags na i-enable ang target na debug logs nang hindi binubuksan ang verbose logging sa lahat ng lugar. Opt-in ang mga flag at walang epekto maliban kung sinusuri sila ng isang subsystem.

## Paano ito gumagana

- Ang mga flag ay mga string (hindi case-sensitive).
- Maaari mong i-enable ang mga flag sa config o sa pamamagitan ng env override.
- Sinusuportahan ang mga wildcard:
  - `telegram.*` tumutugma sa `telegram.http`
  - `*` nag-e-enable ng lahat ng flag

## I-enable sa pamamagitan ng config

```json
{
  "diagnostics": {
    "flags": ["telegram.http"]
  }
}
```

Maramihang flag:

```json
{
  "diagnostics": {
    "flags": ["telegram.http", "gateway.*"]
  }
}
```

I-restart ang Gateway pagkatapos baguhin ang mga flag.

## Env override (one-off)

```bash
OPENCLAW_DIAGNOSTICS=telegram.http,telegram.payload
```

I-disable ang lahat ng flag:

```bash
OPENCLAW_DIAGNOSTICS=0
```

## Saan napupunta ang mga log

Naglalabas ang mga flag ng mga log sa standard diagnostics log file. Bilang default:

```
/tmp/openclaw/openclaw-YYYY-MM-DD.log
```

Kung itatakda mo ang `logging.file`, gamitin ang path na iyon sa halip. Ang mga log ay JSONL (isang JSON object bawat linya). Patuloy na nalalapat ang redaction batay sa `logging.redactSensitive`.

## Kunin ang mga log

Piliin ang pinakabagong log file:

```bash
ls -t /tmp/openclaw/openclaw-*.log | head -n 1
```

I-filter para sa Telegram HTTP diagnostics:

```bash
rg "telegram http error" /tmp/openclaw/openclaw-*.log
```

O mag-tail habang nire-reproduce:

```bash
tail -f /tmp/openclaw/openclaw-$(date +%F).log | rg "telegram http error"
```

Para sa mga remote gateway, maaari mo ring gamitin ang `openclaw logs --follow` (tingnan ang [/cli/logs](/cli/logs)).

## Mga tala

- Kung ang `logging.level` ay mas mataas kaysa `warn`, maaaring ma-suppress ang mga log na ito. Ayos na ang default na `info`.
- Ligtas na iwanang naka-enable ang mga flag; naaapektuhan lang nila ang dami ng log para sa partikular na subsystem.
- Gamitin ang [/logging](/logging) para baguhin ang mga destinasyon ng log, mga level, at redaction.
