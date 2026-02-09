---
summary: "Interfejs ustawień Skills w macOS oraz status oparty na Gateway"
read_when:
  - Aktualizacja interfejsu ustawień Skills w macOS
  - Zmiana zasad bramkowania lub zachowania instalacji Skills
title: "Skills"
---

# Skills (macOS)

Aplikacja macOS udostępnia Skills OpenClaw za pośrednictwem Gateway; nie parsuje Skills lokalnie.

## Źródło danych

- `skills.status` (Gateway) zwraca wszystkie Skills wraz z informacjami o kwalifikowalności i brakujących wymaganiach
  (w tym blokadami listy dozwolonych dla dołączonych Skills).
- Wymagania są wyprowadzane z `metadata.openclaw.requires` w każdym `SKILL.md`.

## Akcje instalacji

- `metadata.openclaw.install` definiuje opcje instalacji (brew/node/go/uv).
- Aplikacja wywołuje `skills.install`, aby uruchomić instalatory na hoście Gateway.
- Gateway udostępnia tylko jeden preferowany instalator, gdy podano wiele
  (brew, gdy dostępny; w przeciwnym razie menedżer node z `skills.install`; domyślnie npm).

## Zmienne środowiskowe / klucze API

- Aplikacja przechowuje klucze w `~/.openclaw/openclaw.json` w ramach `skills.entries.<skillKey>`.
- `skills.update` aktualizuje `enabled`, `apiKey` oraz `env`.

## Tryb zdalny

- Instalacja oraz aktualizacje konfiguracji odbywają się na hoście Gateway (nie na lokalnym Macu).
