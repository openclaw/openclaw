---
summary: "CLI-Referenz für `openclaw configure` (interaktive Konfigurationsabfragen)"
read_when:
  - Sie möchten Anmeldedaten, Geräte oder Agent-Standards interaktiv anpassen
title: "Konfigurieren"
x-i18n:
  source_path: cli/configure.md
  source_hash: 9cb2bb5237b02b3a
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:35:35Z
---

# `openclaw configure`

Interaktive Abfrage zum Einrichten von Anmeldedaten, Geräten und Agent-Standards.

Hinweis: Der Abschnitt **Modell** enthält jetzt eine Mehrfachauswahl für die
`agents.defaults.models` Allowlist (was in `/model` und im Modellauswahldialog angezeigt wird).

Tipp: `openclaw config` ohne Unterbefehl öffnet denselben Assistenten. Verwenden Sie
`openclaw config get|set|unset` für nicht-interaktive Bearbeitungen.

Verwandt:

- Gateway-Konfigurationsreferenz: [Configuration](/gateway/configuration)
- Konfigurations-CLI: [Config](/cli/config)

Hinweise:

- Die Auswahl, wo das Gateway ausgeführt wird, aktualisiert immer `gateway.mode`. Sie können „Weiter“ wählen, ohne andere Abschnitte auszufüllen, wenn das alles ist, was Sie benötigen.
- Kanalorientierte Dienste (Slack/Discord/Matrix/Microsoft Teams) fragen während der Einrichtung nach Channel-/Raum-Allowlists. Sie können Namen oder IDs eingeben; der Assistent löst Namen, wenn möglich, in IDs auf.

## Beispiele

```bash
openclaw configure
openclaw configure --section models --section channels
```
