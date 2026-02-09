---
summary: "Reposkript: syfte, omfattning och säkerhetsnoteringar"
read_when:
  - När du kör skript från repot
  - När du lägger till eller ändrar skript under ./scripts
title: "Skript"
---

# Skript

Katalogen `scripts/` innehåller hjälpskript för lokala arbetsflöden och ops-uppgifter.
Använd dessa när en uppgift är tydligt knuten till ett skript; annars föredrar CLI.

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
