---
summary: "„Gateway-Singleton-Schutz durch Binden des WebSocket-Listeners“"
read_when:
  - Beim Ausführen oder Debuggen des Gateway-Prozesses
  - Bei der Untersuchung der Durchsetzung einer Einzelinstanz
title: "gateway/gateway-lock.md"
---

# Gateway-Sperre

Zuletzt aktualisiert: 2025-12-11

## Warum

- Sicherstellen, dass pro Basis-Port auf demselben Host nur eine Gateway-Instanz läuft; zusätzliche Gateways müssen isolierte Profile und eindeutige Ports verwenden.
- Abstürze/SIGKILL überstehen, ohne veraltete Sperrdateien zu hinterlassen.
- Schnell mit einem klaren Fehler abbrechen, wenn der Kontroll-Port bereits belegt ist.

## Mechanismus

- Das Gateway bindet den WebSocket-Listener (Standard: `ws://127.0.0.1:18789`) unmittelbar beim Start mithilfe eines exklusiven TCP-Listeners.
- Schlägt das Binden mit `EADDRINUSE` fehl, wirft der Start `GatewayLockError("another gateway instance is already listening on ws://127.0.0.1:<port>")`.
- Das Betriebssystem gibt den Listener bei jedem Prozessende automatisch frei, einschließlich Abstürzen und SIGKILL – es ist keine separate Sperrdatei oder ein Cleanup-Schritt erforderlich.
- Beim Herunterfahren schließt das Gateway den WebSocket-Server und den zugrunde liegenden HTTP-Server, um den Port umgehend freizugeben.

## Fehleroberfläche

- Hält ein anderer Prozess den Port, wirft der Start `GatewayLockError("another gateway instance is already listening on ws://127.0.0.1:<port>")`.
- Andere Bind-Fehler werden als `GatewayLockError("failed to bind gateway socket on ws://127.0.0.1:<port>: …")` angezeigt.

## Betriebliche Hinweise

- Ist der Port von einem _anderen_ Prozess belegt, ist der Fehler derselbe; geben Sie den Port frei oder wählen Sie einen anderen mit `openclaw gateway --port <port>`.
- Die macOS-App unterhält weiterhin einen eigenen, leichtgewichtigen PID-Schutz, bevor sie das Gateway startet; die Laufzeitsperre wird durch das Binden des WebSocket-Listeners durchgesetzt.
