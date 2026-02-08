---
summary: "Reposkript: syfte, omfattning och säkerhetsnoteringar"
read_when:
  - När du kör skript från repot
  - När du lägger till eller ändrar skript under ./scripts
title: "Skript"
x-i18n:
  source_path: help/scripts.md
  source_hash: efd220df28f20b33
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T08:17:27Z
---

# Skript

Katalogen `scripts/` innehåller hjälpskript för lokala arbetsflöden och driftuppgifter.
Använd dessa när en uppgift tydligt är kopplad till ett skript; annars bör du föredra CLI.

## Konventioner

- Skript är **valfria** om de inte refereras i dokumentation eller checklistor för releaser.
- Föredra CLI‑gränssnitt när de finns (exempel: autentiseringsövervakning använder `openclaw models status --check`).
- Anta att skript är värdspecifika; läs dem innan du kör på en ny maskin.

## Skript för autentiseringsövervakning

Skript för autentiseringsövervakning dokumenteras här:
[/automation/auth-monitoring](/automation/auth-monitoring)

## När du lägger till skript

- Håll skript fokuserade och dokumenterade.
- Lägg till en kort post i relevant dokumentation (eller skapa en om den saknas).
