---
summary: "SOUL Evil-hook (byt SOUL.md med SOUL_EVIL.md)"
read_when:
  - Du vil aktivere eller finjustere SOUL Evil-hooken
  - Du vil have et purge-vindue eller et persona-byt med tilfældig sandsynlighed
title: "SOUL Evil Hook"
---

# SOUL Evil Hook

SOUL Evil hook svinger indholdet **injicerede** `SOUL.md` med `SOUL_EVIL.md` under
et udrensningsvindue eller ved tilfældige tilfældigheder. Det ændrer **ikke** filer på disken.

## Sådan virker det

Når `agent:bootstrap` kører, kan krogen erstatte `SOUL.md` indhold i hukommelse
før systemprompten er samlet. Hvis `SOUL_EVIL.md` mangler eller er tom, logger
OpenClaw en advarsel og beholder den normale `SOUL.md`.

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
- `purge.duration` (varighed): vinduelængde (f.eks. `30s`, `10m`, `1h`)

**Forrang:** purge-vinduet har forrang over tilfældighed.

**Tidszone:** bruger `agents.defaults.userTimezone`, når den er sat; ellers værtens tidszone.

## Noter

- Ingen filer skrives eller ændres på disk.
- Hvis `SOUL.md` ikke er på bootstrap-listen, gør hooken ingenting.

## Se også

- [Hooks](/automation/hooks)
