---
summary: "SOUL Evil-hook (byt SOUL.md med SOUL_EVIL.md)"
read_when:
  - Du vil aktivere eller finjustere SOUL Evil-hooken
  - Du vil have et purge-vindue eller et persona-byt med tilfældig sandsynlighed
title: "SOUL Evil Hook"
x-i18n:
  source_path: hooks/soul-evil.md
  source_hash: 32aba100712317d1
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:50:16Z
---

# SOUL Evil Hook

SOUL Evil-hooken bytter det **injicerede** `SOUL.md`-indhold med `SOUL_EVIL.md` under
et purge-vindue eller ved tilfældig sandsynlighed. Den ændrer **ikke** filer på disk.

## Sådan virker det

Når `agent:bootstrap` kører, kan hooken erstatte `SOUL.md`-indholdet i hukommelsen,
før systemprompten samles. Hvis `SOUL_EVIL.md` mangler eller er tom,
logger OpenClaw en advarsel og beholder den normale `SOUL.md`.

Kørsler for sub-agenter inkluderer **ikke** `SOUL.md` i deres bootstrap-filer, så denne hook
har ingen effekt på sub-agenter.

## Aktiver

```bash
openclaw hooks enable soul-evil
```

Indstil derefter konfigurationen:

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

Opret `SOUL_EVIL.md` i agentens workspace-rod (ved siden af `SOUL.md`).

## Indstillinger

- `file` (string): alternativt SOUL-filnavn (standard: `SOUL_EVIL.md`)
- `chance` (tal 0–1): tilfældig sandsynlighed pr. kørsel for at bruge `SOUL_EVIL.md`
- `purge.at` (HH:mm): daglig purge-start (24-timers ur)
- `purge.duration` (varighed): vinduets længde (f.eks. `30s`, `10m`, `1h`)

**Forrang:** purge-vinduet har forrang over tilfældighed.

**Tidszone:** bruger `agents.defaults.userTimezone`, når den er sat; ellers værtens tidszone.

## Noter

- Ingen filer skrives eller ændres på disk.
- Hvis `SOUL.md` ikke er på bootstrap-listen, gør hooken ingenting.

## Se også

- [Hooks](/automation/hooks)
