---
summary: "Utwierdzenie obsługi danych wejściowych cron.add, wyrównanie schematów oraz usprawnienie narzędzi UI/agenta dla crona"
owner: "openclaw"
status: "complete"
last_updated: "2026-01-05"
title: "Utwierdzenie dodawania cron"
---

# Utwardzanie dodawania Crona i wyrównanie schematów

## Kontekst

Najnowsze logi Gateway pokazują powtarzające się awarie `cron.add` z nieprawidłowymi parametrami (brak `sessionTarget`, `wakeMode`, `payload` oraz nieprawidłowy `schedule`). Wskazuje to, że co najmniej jeden klient (prawdopodobnie ścieżka wywołań narzędzia agenta) wysyła opakowane lub częściowo określone ładunki zadań. Niezależnie od tego występuje rozjazd między enumeracjami dostawców cron w TypeScript, schemacie Gateway, flagach CLI i typach formularzy UI, a także niezgodność UI dla `cron.status` (oczekuje `jobCount`, podczas gdy Gateway zwraca `jobs`).

## Cele

- Zatrzymać spam `cron.add` INVALID_REQUEST poprzez normalizację typowych opakowanych ładunków i wnioskowanie brakujących pól `kind`.
- Wyrównać listy dostawców cron w schemacie Gateway, typach cron, dokumentacji CLI i formularzach UI.
- Uczynić schemat narzędzia cron agenta jednoznacznym, aby LLM generował poprawne ładunki zadań.
- Naprawić wyświetlanie liczby zadań statusu cron w Control UI.
- Dodać testy obejmujące normalizację i zachowanie narzędzia.

## Inne cele

- Zmiana semantyki harmonogramu cron lub zachowania wykonywania zadań.
- Dodanie nowych rodzajów harmonogramów lub parsowania wyrażeń cron.
- Przebudowa UI/UX dla cron poza niezbędnymi poprawkami pól.

## Ustalenia (obecne luki)

- `CronPayloadSchema` w Gateway wyklucza `signal` + `imessage`, podczas gdy typy TS je zawierają.
- CronStatus w Control UI oczekuje `jobCount`, ale Gateway zwraca `jobs`.
- Schemat narzędzia cron agenta dopuszcza dowolne obiekty `job`, umożliwiając nieprawidłowe dane wejściowe.
- Gateway rygorystycznie waliduje `cron.add` bez normalizacji, przez co opakowane ładunki zawodzą.

## Co się zmieniło

- `cron.add` i `cron.update` teraz normalizują typowe kształty opakowań i wnioskują brakujące pola `kind`.
- Schemat narzędzia cron agenta odpowiada schematowi Gateway, co ogranicza nieprawidłowe ładunki.
- Enumeracje dostawców są wyrównane w Gateway, CLI, UI oraz selektorze macOS.
- Control UI używa pola licznika `jobs` zwracanego przez Gateway dla statusu.

## Bieżące zachowanie

- **Normalizacja:** opakowane ładunki `data`/`job` są rozpakowywane; `schedule.kind` i `payload.kind` są wnioskowane, gdy jest to bezpieczne.
- **Domyślne wartości:** bezpieczne wartości domyślne są stosowane dla `wakeMode` i `sessionTarget`, gdy ich brakuje.
- **Dostawcy:** Discord/Slack/Signal/iMessage są teraz spójnie prezentowane w CLI/UI.

Zobacz [Zadania cron](/automation/cron-jobs), aby poznać znormalizowany kształt i przykłady.

## Weryfikacja

- Obserwuj logi Gateway pod kątem zmniejszenia liczby błędów `cron.add` INVALID_REQUEST.
- Potwierdź, że status cron w Control UI po odświeżeniu pokazuje liczbę zadań.

## Opcjonalne działania następcze

- Ręczny smoke test Control UI: dodaj zadanie cron dla każdego dostawcy + zweryfikuj liczbę zadań w statusie.

## Otwarte pytania

- Czy `cron.add` powinno akceptować jawne `state` od klientów (obecnie zabronione przez schemat)?
- Czy powinniśmy dopuścić `webchat` jako jawnego dostawcę dostarczania (obecnie filtrowany w rozstrzyganiu dostarczania)?
