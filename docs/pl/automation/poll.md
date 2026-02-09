---
summary: "Wysyłanie ankiet przez gateway + CLI"
read_when:
  - Dodawanie lub modyfikowanie obsługi ankiet
  - Debugowanie wysyłania ankiet z CLI lub gateway
title: "Ankiety"
---

# Ankiety

## Obsługiwane kanały

- WhatsApp (kanał web)
- Discord
- MS Teams (Adaptive Cards)

## CLI

```bash
# WhatsApp
openclaw message poll --target +15555550123 \
  --poll-question "Lunch today?" --poll-option "Yes" --poll-option "No" --poll-option "Maybe"
openclaw message poll --target 123456789@g.us \
  --poll-question "Meeting time?" --poll-option "10am" --poll-option "2pm" --poll-option "4pm" --poll-multi

# Discord
openclaw message poll --channel discord --target channel:123456789 \
  --poll-question "Snack?" --poll-option "Pizza" --poll-option "Sushi"
openclaw message poll --channel discord --target channel:123456789 \
  --poll-question "Plan?" --poll-option "A" --poll-option "B" --poll-duration-hours 48

# MS Teams
openclaw message poll --channel msteams --target conversation:19:abc@thread.tacv2 \
  --poll-question "Lunch?" --poll-option "Pizza" --poll-option "Sushi"
```

Opcje:

- `--channel`: `whatsapp` (domyślnie), `discord` lub `msteams`
- `--poll-multi`: umożliwia wybór wielu opcji
- `--poll-duration-hours`: tylko Discord (gdy pominięte, domyślnie 24)

## Gateway RPC

Metoda: `poll`

Parametry:

- `to` (string, wymagane)
- `question` (string, wymagane)
- `options` (string[], wymagane)
- `maxSelections` (number, opcjonalne)
- `durationHours` (number, opcjonalne)
- `channel` (string, opcjonalne, domyślnie: `whatsapp`)
- `idempotencyKey` (string, wymagane)

## Różnice między kanałami

- WhatsApp: 2–12 opcji, `maxSelections` musi mieścić się w liczbie opcji, ignoruje `durationHours`.
- Discord: 2–10 opcji, `durationHours` ograniczone do 1–768 godzin (domyślnie 24). `maxSelections > 1` włącza wybór wielokrotny; Discord nie obsługuje ścisłej liczby wyborów.
- MS Teams: Ankiety jako Adaptive Cards (zarządzane przez OpenClaw). Brak natywnego API ankiet; `durationHours` jest ignorowane.

## Narzędzie agenta (Wiadomość)

Użyj narzędzia `message` z akcją `poll` (`to`, `pollQuestion`, `pollOption`, opcjonalnie `pollMulti`, `pollDurationHours`, `channel`).

Uwaga: Discord nie ma trybu „wybierz dokładnie N”; `pollMulti` mapuje się na wybór wielokrotny.
Ankiety w Teams są renderowane jako Adaptive Cards i wymagają, aby gateway pozostawał online,
aby rejestrować głosy w `~/.openclaw/msteams-polls.json`.
