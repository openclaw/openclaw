---
summary: "SOUL Evil-hook (byt SOUL.md mot SOUL_EVIL.md)"
read_when:
  - Du vill aktivera eller justera SOUL Evil-hooken
  - Du vill ha ett rensningsfönster eller ett slumpmässigt persona-byte
title: "SOUL Evil-hook"
---

# SOUL Evil-hook

SOUL Evil krok byter **injicerade** `SOUL.md`-innehållet med `SOUL_EVIL.md` under
ett rensningsfönster eller av slumpmässig slump. Det ändrar **inte** filer på disken.

## Hur det fungerar

När `agent:bootstrap` körs kan kroken ersätta innehållet `SOUL.md` i minne
innan systemprompten är monterad. Om `SOUL_EVIL.md` saknas eller är tom, loggar
OpenClaw en varning och behåller den normala `SOUL.md`.

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
