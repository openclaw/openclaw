---
summary: "SOUL Evil-hook (byt SOUL.md mot SOUL_EVIL.md)"
read_when:
  - Du vill aktivera eller justera SOUL Evil-hooken
  - Du vill ha ett rensningsfönster eller ett slumpmässigt persona-byte
title: "SOUL Evil-hook"
x-i18n:
  source_path: hooks/soul-evil.md
  source_hash: 32aba100712317d1
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T08:17:31Z
---

# SOUL Evil-hook

SOUL Evil-hooken byter ut det **injicerade** `SOUL.md`-innehållet mot `SOUL_EVIL.md` under
ett rensningsfönster eller genom slumpmässig chans. Den modifierar **inte** filer på disk.

## Hur det fungerar

När `agent:bootstrap` körs kan hooken ersätta `SOUL.md`-innehållet i minnet
innan systemprompten sätts samman. Om `SOUL_EVIL.md` saknas eller är tom,
loggar OpenClaw en varning och behåller den normala `SOUL.md`.

Körningar av underagenter inkluderar **inte** `SOUL.md` i sina bootstrap-filer, så denna hook
har ingen effekt på underagenter.

## Aktivera

```bash
openclaw hooks enable soul-evil
```

Ställ sedan in konfigen:

```json
{
  "hooks": {
    "internal": {
      "enabled": true,
      "entries": {
        "soul-evil": {
          "enabled": true,
          "file": "SOUL_EVIL.md",
          "chance": 0.1,
          "purge": { "at": "21:00", "duration": "15m" }
        }
      }
    }
  }
}
```

Skapa `SOUL_EVIL.md` i agentens arbetsyterot (bredvid `SOUL.md`).

## Alternativ

- `file` (sträng): alternativt SOUL-filnamn (standard: `SOUL_EVIL.md`)
- `chance` (tal 0–1): slumpmässig chans per körning att använda `SOUL_EVIL.md`
- `purge.at` (HH:mm): daglig rensningsstart (24-timmarsformat)
- `purge.duration` (varaktighet): fönsterlängd (t.ex. `30s`, `10m`, `1h`)

**Prioritet:** rensningsfönster har företräde framför chans.

**Tidszon:** använder `agents.defaults.userTimezone` när den är satt; annars värdens tidszon.

## Noteringar

- Inga filer skrivs eller ändras på disk.
- Om `SOUL.md` inte finns i bootstrap-listan gör hooken ingenting.

## Se även

- [Hooks](/automation/hooks)
