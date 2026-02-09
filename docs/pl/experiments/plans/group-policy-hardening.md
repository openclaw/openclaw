---
summary: "Utwardzanie listy dozwolonych Telegrama: normalizacja prefiksów i białych znaków"
read_when:
  - Przeglądanie historycznych zmian listy dozwolonych Telegrama
title: "Utwardzanie listy dozwolonych Telegrama"
---

# Utwardzanie listy dozwolonych Telegrama

**Data**: 2026-01-05  
**Status**: Zakończone  
**PR**: #216

## Podsumowanie

Listy dozwolonych Telegrama akceptują teraz prefiksy `telegram:` i `tg:` bez rozróżniania wielkości liter oraz tolerują
przypadkowe białe znaki. Ujednolica to sprawdzanie listy dozwolonych dla przychodzących wiadomości z normalizacją wysyłania wychodzącego.

## Co się zmieniło

- Prefiksy `telegram:` i `tg:` są traktowane identycznie (bez rozróżniania wielkości liter).
- Wpisy listy dozwolonych są przycinane; puste wpisy są ignorowane.

## Przykłady

Wszystkie poniższe są akceptowane dla tego samego identyfikatora:

- `telegram:123456`
- `TG:123456`
- `tg:123456`

## Dlaczego to ważne

Kopiowanie/wklejanie z logów lub identyfikatorów czatów często zawiera prefiksy i białe znaki. Normalizacja pozwala
uniknąć fałszywych negatywów przy decydowaniu, czy odpowiadać w DM-ach lub grupach.

## Powiązana dokumentacja

- [Czaty grupowe](/channels/groups)
- [Dostawca Telegram](/channels/telegram)
