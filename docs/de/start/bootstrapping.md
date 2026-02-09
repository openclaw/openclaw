---
summary: "„Agent-Bootstrapping-Ritual, das den Workspace und die Identitätsdateien initialisiert“"
read_when:
  - „Verstehen, was beim ersten Agentenlauf passiert“
  - „Erklären, wo Bootstrapping-Dateien abgelegt sind“
  - „Debugging der Onboarding-Identitätseinrichtung“
title: "„Agent-Bootstrapping“"
sidebarTitle: "„Bootstrapping“"
---

# Agent-Bootstrapping

Bootstrapping ist das **Erststart**‑Ritual, das einen Agent-Workspace vorbereitet
und Identitätsdetails erfasst. Es findet nach dem Onboarding statt, wenn der
Agent zum ersten Mal startet.

## Was Bootstrapping tut

Beim ersten Agentenlauf bootstrapped OpenClaw den Workspace (Standard:
`~/.openclaw/workspace`):

- Initialisiert `AGENTS.md`, `BOOTSTRAP.md`, `IDENTITY.md`, `USER.md`.
- Führt ein kurzes Q&A Ritual aus (jeweils eine Frage).
- Schreibt Identität und Präferenzen in `IDENTITY.md`, `USER.md`, `SOUL.md`.
- Entfernt `BOOTSTRAP.md` nach Abschluss, sodass es nur einmal ausgeführt wird.

## Wo es ausgeführt wird

Bootstrapping wird immer auf dem **Gateway-Host** ausgeführt. Wenn sich die
macOS‑App mit einem entfernten Gateway verbindet, befinden sich der Workspace
und die Bootstrapping-Dateien auf diesem entfernten Rechner.

<Note>
Wenn das Gateway auf einem anderen Rechner läuft, bearbeiten Sie Workspace-
Dateien auf dem Gateway-Host (zum Beispiel `user@gateway-host:~/.openclaw/workspace`).
</Note>

## Verwandte Dokumente

- macOS‑App‑Onboarding: [Onboarding](/start/onboarding)
- Workspace‑Layout: [Agent-Workspace](/concepts/agent-workspace)
