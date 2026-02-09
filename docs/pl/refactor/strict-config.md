---
summary: "Ścisła walidacja konfiguracji + migracje wyłącznie przez Doctor"
read_when:
  - Projektowanie lub implementacja zachowania walidacji konfiguracji
  - Praca nad migracjami konfiguracji lub przepływami Doctor
  - Obsługa schematów konfiguracji wtyczek lub bramkowanie ładowania wtyczek
title: "Ścisła walidacja konfiguracji"
---

# Ścisła walidacja konfiguracji (migracje wyłącznie przez Doctor)

## Cele

- **Odrzucanie nieznanych kluczy konfiguracji wszędzie** (korzeń + zagnieżdżenia).
- **Odrzuć konfigurację wtyczki bez schematu**; nie załaduj tej wtyczki.
- **Usunięcie legacy auto-migracji przy ładowaniu**; migracje uruchamiane wyłącznie przez Doctor.
- **Automatyczne uruchamianie Doctor (tryb dry-run) przy starcie**; jeśli konfiguracja jest nieprawidłowa, blokowanie poleceń niediagnostycznych.

## Inne cele

- Zgodność wsteczna przy ładowaniu (starsze klucze nie są automatycznie migrowane).
- Ciche usuwanie nierozpoznanych kluczy.

## Zasady ścisłej walidacji

- Konfiguracja musi dokładnie odpowiadać schematowi na każdym poziomie.
- Nieznane klucze są błędami walidacji (brak przepuszczania na poziomie korzenia i w zagnieżdżeniach).
- `plugins.entries.<id>.config` musi być walidowane przez schemat wtyczki.
  - Jeśli wtyczka nie ma schematu, **odrzuć ładowanie wtyczki** i pokaż jednoznaczny błąd.
- Nieznane klucze `channels.<id>` są błędami, chyba że manifest wtyczki deklaruje identyfikator kanału.
- Manifesty wtyczek (`openclaw.plugin.json`) są wymagane dla wszystkich wtyczek.

## Wymuszanie schematów wtyczek

- Każda wtyczka dostarcza ścisły schemat JSON dla swojej konfiguracji (osadzony w manifeście).
- Przepływ ładowania wtyczki:
  1. Rozwiązanie manifestu wtyczki + schematu (`openclaw.plugin.json`).
  2. Walidacja konfiguracji względem schematu.
  3. W przypadku braku schematu lub nieprawidłowej konfiguracji: zablokuj ładowanie wtyczki i zarejestruj błąd.
- Komunikat błędu zawiera:
  - Identyfikator wtyczki
  - Powód (brak schematu / nieprawidłowa konfiguracja)
  - Ścieżka(y), które nie sprawdziły się
- Wyłączone wtyczki zachowują swoją konfigurację, ale Doctor + logi prezentują ostrzeżenie.

## Przepływ Doctor

- Doctor uruchamia się **za każdym razem**, gdy konfiguracja jest ładowana (domyślnie dry-run).
- Jeśli konfiguracja jest nieprawidłowa:
  - Wydrukuj podsumowanie + błędy możliwe do podjęcia działań.
  - Instrukcja: `openclaw doctor --fix`.
- `openclaw doctor --fix`:
  - Stosuje migracje.
  - Usuwa nieznane klucze.
  - Zapisuje zaktualizowaną konfigurację.

## Bramkowanie poleceń (gdy konfiguracja jest nieprawidłowa)

Dozwolone (wyłącznie diagnostyczne):

- `openclaw doctor`
- `openclaw logs`
- `openclaw health`
- `openclaw help`
- `openclaw status`
- `openclaw gateway status`

Wszystkie pozostałe muszą zakończyć się twardą porażką z komunikatem: „Konfiguracja jest nieprawidłowa. Uruchom `openclaw doctor --fix`.”

## Format UX błędów

- Jeden nagłówek podsumowania.
- Sekcje pogrupowane:
  - Nieznane klucze (pełne ścieżki)
  - Klucze legacy / wymagane migracje
  - Błędy ładowania wtyczek (id wtyczki + powód + ścieżka)

## Punkty styku implementacji

- `src/config/zod-schema.ts`: usuń przepuszczanie na poziomie korzenia; ścisłe obiekty wszędzie.
- `src/config/zod-schema.providers.ts`: zapewnij ścisłe schematy kanałów.
- `src/config/validation.ts`: kończ błędem przy nieznanych kluczach; nie stosuj migracji legacy.
- `src/config/io.ts`: usuń legacy auto-migracje; zawsze uruchamiaj Doctor w trybie dry-run.
- `src/config/legacy*.ts`: przenieś użycie wyłącznie do Doctor.
- `src/plugins/*`: dodaj rejestr schematów + bramkowanie.
- Bramkowanie poleceń CLI w `src/cli`.

## Testy

- Odrzucanie nieznanych kluczy (korzeń + zagnieżdżenia).
- Brak schematu wtyczki → ładowanie wtyczki zablokowane z jednoznacznym błędem.
- Nieprawidłowa konfiguracja → uruchomienie Gateway zablokowane poza poleceniami diagnostycznymi.
- Doctor uruchamiany automatycznie w trybie dry-run; `doctor --fix` zapisuje poprawioną konfigurację.
