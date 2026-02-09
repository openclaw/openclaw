---
summary: "SOUL Evil-hook (verwisselt SOUL.md met SOUL_EVIL.md)"
read_when:
  - Je wilt de SOUL Evil-hook inschakelen of afstellen
  - Je wilt een purge-venster of een persona-wissel met willekeurige kans
title: "SOUL Evil Hook"
---

# SOUL Evil Hook

De SOUL Evil-hook verwisselt de **geïnjecteerde** `SOUL.md`-inhoud met `SOUL_EVIL.md` tijdens
een purge-venster of op basis van willekeurige kans. Er worden **geen** bestanden op schijf aangepast.

## Hoe het werkt

Wanneer `agent:bootstrap` wordt uitgevoerd, kan de hook de `SOUL.md`-inhoud in het geheugen vervangen
voordat de systeemprompt wordt samengesteld. Als `SOUL_EVIL.md` ontbreekt of leeg is,
logt OpenClaw een waarschuwing en behoudt het de normale `SOUL.md`.

Uitvoeringen van sub-agents bevatten **geen** `SOUL.md` in hun bootstrapbestanden, dus deze hook
heeft geen effect op sub-agents.

## Inschakelen

```bash
openclaw hooks enable soul-evil
```

Stel vervolgens de config in:

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

Maak `SOUL_EVIL.md` aan in de root van de agent-werkruimte (naast `SOUL.md`).

## Opties

- `file` (string): alternatieve SOUL-bestandsnaam (standaard: `SOUL_EVIL.md`)
- `chance` (nummer 0–1): willekeurige kans per run om `SOUL_EVIL.md` te gebruiken
- `purge.at` (HH:mm): dagelijkse purge-start (24-uursklok)
- `purge.duration` (duur): lengte van het venster (bijv. `30s`, `10m`, `1h`)

**Prioriteit:** het purge-venster heeft voorrang boven kans.

**Tijdzone:** gebruikt `agents.defaults.userTimezone` indien ingesteld; anders de host-tijdzone.

## Notities

- Er worden geen bestanden op schijf geschreven of aangepast.
- Als `SOUL.md` niet in de bootstraplijst staat, doet de hook niets.

## Zie ook

- [Hooks](/automation/hooks)
