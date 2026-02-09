---
summary: "„Verwenden Sie Qwen OAuth (Free-Tier) in OpenClaw“"
read_when:
  - Sie möchten Qwen mit OpenClaw verwenden
  - Sie möchten Free-Tier-OAuth-Zugriff auf Qwen Coder
title: "Qwen"
---

# Qwen

Qwen bietet einen Free-Tier-OAuth-Flow für die Modelle Qwen Coder und Qwen Vision
(2.000 Anfragen/Tag, vorbehaltlich der Qwen-Ratenlimits).

## Plugin aktivieren

```bash
openclaw plugins enable qwen-portal-auth
```

Starten Sie das Gateway nach der Aktivierung neu.

## Authentifizieren

```bash
openclaw models auth login --provider qwen-portal --set-default
```

Dies führt den Qwen-Device-Code-OAuth-Flow aus und schreibt einen Anbieter-Eintrag
in Ihre `models.json` (zusätzlich mit einem `qwen`-Alias für schnelles Umschalten).

## Modell-IDs

- `qwen-portal/coder-model`
- `qwen-portal/vision-model`

Modelle wechseln mit:

```bash
openclaw models set qwen-portal/coder-model
```

## Qwen-Code-CLI-Login wiederverwenden

Wenn Sie sich bereits mit der Qwen Code CLI angemeldet haben, synchronisiert OpenClaw
die Anmeldedaten aus `~/.qwen/oauth_creds.json`, wenn der Auth-Store geladen wird. Sie benötigen
dennoch einen `models.providers.qwen-portal`-Eintrag (verwenden Sie den obigen Login-Befehl, um einen zu erstellen).

## Hinweise

- Tokens werden automatisch aktualisiert; führen Sie den Login-Befehl erneut aus, wenn die Aktualisierung fehlschlägt oder der Zugriff widerrufen wird.
- Standard-Basis-URL: `https://portal.qwen.ai/v1` (überschreiben Sie diese mit
  `models.providers.qwen-portal.baseUrl`, falls Qwen einen anderen Endpunkt bereitstellt).
- Siehe [Model providers](/concepts/model-providers) für anbieterweite Regeln.
