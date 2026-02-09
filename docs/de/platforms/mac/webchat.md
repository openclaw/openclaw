---
summary: "„Wie die mac‑App das Gateway‑WebChat einbettet und wie Sie es debuggen“"
read_when:
  - Debugging der mac‑WebChat‑Ansicht oder des Loopback‑Ports
title: "„WebChat“"
---

# WebChat (macOS‑App)

Die macOS‑Menüleisten‑App bettet die WebChat‑UI als native SwiftUI‑Ansicht ein. Sie
verbindet sich mit dem Gateway und verwendet standardmäßig die **Hauptsitzung**
für den ausgewählten Agenten (mit einem Sitzungsumschalter für weitere Sitzungen).

- **Lokaler Modus**: Verbindet sich direkt mit dem lokalen Gateway‑WebSocket.
- **Remote‑Modus**: Leitet den Gateway‑Control‑Port über SSH weiter und nutzt
  diesen Tunnel als Datenebene.

## Start & Debugging

- Manuell: Lobster‑Menü → „Chat öffnen“.

- Automatisches Öffnen für Tests:

  ```bash
  dist/OpenClaw.app/Contents/MacOS/OpenClaw --webchat
  ```

- Logs: `./scripts/clawlog.sh` (Subsystem `bot.molt`, Kategorie `WebChatSwiftUI`).

## Wie ist es verkabelt

- Datenebene: Gateway‑WS‑Methoden `chat.history`, `chat.send`, `chat.abort`,
  `chat.inject` sowie Ereignisse `chat`, `agent`, `presence`, `tick`, `health`.
- Sitzung: Standardmäßig die primäre Sitzung (`main` oder `global`, wenn der Scope
  global ist). Die UI kann zwischen Sitzungen wechseln.
- Onboarding nutzt eine dedizierte Sitzung, um die Ersteinrichtung getrennt zu halten.

## Sicherheitsoberfläche

- Im Remote‑Modus wird nur der Gateway‑WebSocket‑Control‑Port über SSH weitergeleitet.

## Bekannte Einschränkungen

- Die UI ist für Chat‑Sitzungen optimiert (keine vollständige Browser‑Sandbox).
