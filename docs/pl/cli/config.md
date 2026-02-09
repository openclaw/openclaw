---
summary: "Dokumentacja referencyjna CLI dla `openclaw config` (get/set/unset wartości konfiguracji)"
read_when:
  - Chcesz odczytać lub edytować konfigurację w trybie nieinteraktywnym
title: "Konfiguracja"
---

# `openclaw config`

Narzędzia pomocnicze konfiguracji: pobieranie/ustawianie/usuwanie wartości według ścieżki. Uruchomienie bez podkomendy otwiera kreator konfiguracji (tak samo jak `openclaw configure`).

## Przykłady

```bash
openclaw config get browser.executablePath
openclaw config set browser.executablePath "/usr/bin/google-chrome"
openclaw config set agents.defaults.heartbeat.every "2h"
openclaw config set agents.list[0].tools.exec.node "node-id-or-name"
openclaw config unset tools.web.search.apiKey
```

## Ścieżki

Ścieżki używają notacji kropkowej lub nawiasowej:

```bash
openclaw config get agents.defaults.workspace
openclaw config get agents.list[0].id
```

Użyj indeksu listy agentów, aby wskazać konkretnego agenta:

```bash
openclaw config get agents.list
openclaw config set agents.list[1].tools.exec.node "node-id-or-name"
```

## Wartości

Wartości są parsowane jako JSON5, gdy to możliwe; w przeciwnym razie są traktowane jako ciągi znaków.
Użyj `--json`, aby wymusić parsowanie JSON5.

```bash
openclaw config set agents.defaults.heartbeat.every "0m"
openclaw config set gateway.port 19001 --json
openclaw config set channels.whatsapp.groups '["*"]' --json
```

Po edycjach zrestartuj gateway.
