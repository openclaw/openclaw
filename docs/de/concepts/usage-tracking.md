---
summary: "„Oberflächen zur Nutzungsverfolgung und Anforderungen an Anmeldeinformationen“"
read_when:
  - Sie verdrahten Oberflächen für Anbieter-Nutzung/Quoten
  - Sie müssen das Verhalten der Nutzungsverfolgung oder Authentifizierungsanforderungen erklären
title: "„Nutzungsverfolgung“"
---

# Nutzungsverfolgung

## Was es ist

- Ruft die Nutzung/Quote der Anbieter direkt von deren Nutzungsendpunkten ab.
- Keine geschätzten Kosten; nur die vom Anbieter gemeldeten Zeitfenster.

## Wo es angezeigt wird

- `/status` in Chats: Emoji‑reiche Statuskarte mit Sitzungstokens + geschätzten Kosten (nur API‑Schlüssel). Die Anbieter‑Nutzung wird für den **aktuellen Modellanbieter** angezeigt, sofern verfügbar.
- `/usage off|tokens|full` in Chats: Nutzungs‑Footer pro Antwort (OAuth zeigt nur Tokens).
- `/usage cost` in Chats: lokale Kostenübersicht, aggregiert aus OpenClaw‑Sitzungsprotokollen.
- CLI: `openclaw status --usage` gibt eine vollständige Aufschlüsselung pro Anbieter aus.
- CLI: `openclaw channels list` gibt denselben Nutzungsschnappschuss zusammen mit der Anbieter‑Konfiguration aus (verwenden Sie `--no-usage`, um dies zu überspringen).
- macOS‑Menüleiste: Abschnitt „Usage“ unter Context (nur falls verfügbar).

## Anbieter + Anmeldeinformationen

- **Anthropic (Claude)**: OAuth‑Tokens in Auth‑Profilen.
- **GitHub Copilot**: OAuth‑Tokens in Auth‑Profilen.
- **Gemini CLI**: OAuth‑Tokens in Auth‑Profilen.
- **Antigravity**: OAuth‑Tokens in Auth‑Profilen.
- **OpenAI Codex**: OAuth‑Tokens in Auth‑Profilen (accountId wird verwendet, falls vorhanden).
- **MiniMax**: API‑Schlüssel (Coding‑Plan‑Schlüssel; `MINIMAX_CODE_PLAN_KEY` oder `MINIMAX_API_KEY`); verwendet das 5‑Stunden‑Coding‑Plan‑Zeitfenster.
- **z.ai**: API‑Schlüssel über env/Konfiguration/Auth‑Store.

Die Nutzung wird ausgeblendet, wenn keine passenden OAuth‑/API‑Anmeldeinformationen vorhanden sind.
