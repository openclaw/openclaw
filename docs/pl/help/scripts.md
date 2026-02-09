---
summary: "Skrypty repozytorium: cel, zakres i uwagi dotyczące bezpieczeństwa"
read_when:
  - Uruchamianie skryptów z repozytorium
  - Dodawanie lub zmienianie skryptów w katalogu ./scripts
title: "Skrypty"
---

# Skrypty

Katalog `scripts/` zawiera skrypty pomocnicze do lokalnych przepływów pracy oraz zadań operacyjnych.
Używaj ich, gdy zadanie jest jednoznacznie powiązane ze skryptem; w przeciwnym razie preferuj CLI.

## Konwencje

- Skrypty są **opcjonalne**, chyba że są przywołane w dokumentacji lub listach kontrolnych wydań.
- Preferuj interfejsy CLI, gdy istnieją (przykład: monitorowanie uwierzytelniania używa `openclaw models status --check`).
- Zakładaj, że skrypty są specyficzne dla hosta; przed uruchomieniem na nowej maszynie zapoznaj się z ich treścią.

## Skrypty monitorowania uwierzytelniania

Skrypty monitorowania uwierzytelniania są opisane tutaj:
[/automation/auth-monitoring](/automation/auth-monitoring)

## Podczas dodawania skryptów

- Utrzymuj skrypty w wąskim zakresie i dokumentuj je.
- Dodaj krótki wpis w odpowiedniej dokumentacji (lub utwórz ją, jeśli jej brakuje).
