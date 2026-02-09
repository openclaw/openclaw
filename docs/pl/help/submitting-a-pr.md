---
summary: "Jak przesłać PR o wysokiej wartości informacyjnej"
title: "Przesyłanie PR"
---

Dobre PR-y są łatwe do przeglądu: recenzenci powinni szybko zrozumieć intencję, zweryfikować zachowanie i bezpiecznie wdrożyć zmiany. Ten przewodnik opisuje zwięzłe, wysokiej jakości zgłoszenia do przeglądu przez ludzi i LLM-y.

## Co składa się na dobry PR

- [ ] Wyjaśnij problem, dlaczego jest istotny oraz na czym polega zmiana.
- [ ] Zachowaj wąski zakres zmian. Unikaj szerokich refaktoryzacji.
- [ ] Podsumuj zmiany widoczne dla użytkownika/konfiguracji/ustawień domyślnych.
- [ ] Wypisz zakres testów, pominięcia oraz uzasadnienia.
- [ ] Dodaj dowody: logi, zrzuty ekranu lub nagrania (UI/UX).
- [ ] Słowo-klucz: umieść „lobster-biscuit” w opisie PR, jeśli przeczytałeś ten przewodnik.
- [ ] Uruchom/napraw odpowiednie polecenia `pnpm` przed utworzeniem PR.
- [ ] Przeszukaj bazę kodu i GitHub pod kątem powiązanej funkcjonalności/problemów/poprawek.
- [ ] Opieraj twierdzenia na dowodach lub obserwacjach.
- [ ] Dobry tytuł: czasownik + zakres + rezultat (np. `Docs: add PR and issue templates`).

Bądź zwięzły; zwięzły przegląd > gramatyka. Pomiń sekcje nie mające zastosowania.

### Bazowe polecenia walidacyjne (uruchom/napraw błędy dla swojej zmiany)

- `pnpm lint`
- `pnpm check`
- `pnpm build`
- `pnpm test`
- Zmiany protokołu: `pnpm protocol:check`

## Progresywne ujawnianie informacji

- Na górze: podsumowanie/intencja
- Następnie: zmiany/ryzyka
- Dalej: testy/weryfikacja
- Na końcu: implementacja/dowody

## Typowe rodzaje PR-ów: szczegóły

- [ ] Naprawa: dodaj repro, przyczynę źródłową, weryfikację.
- [ ] Funkcja: dodaj przypadki użycia, zachowanie/dema/zrzuty (UI).
- [ ] Refaktoryzacja: wskaż „brak zmiany zachowania”, wypisz co przeniesiono/uproszczono.
- [ ] Prace porządkowe: podaj powód (np. czas budowania, CI, zależności).
- [ ] Dokumentacja: kontekst przed/po, link do zaktualizowanej strony, uruchom `pnpm format`.
- [ ] Testy: jaki brak jest pokryty; jak zapobiega regresjom.
- [ ] Wydajność: dodaj metryki przed/po oraz metodę pomiaru.
- [ ] UX/UI: zrzuty/wideo, odnotuj wpływ na dostępność.
- [ ] Infrastruktura/Build: środowiska/walidacja.
- [ ] Bezpieczeństwo: podsumuj ryzyko, repro, weryfikację, bez wrażliwych danych. Wyłącznie twierdzenia oparte na faktach.

## Lista kontrolna

- [ ] Jasny problem/intencja
- [ ] Skoncentrowany zakres
- [ ] Lista zmian zachowania
- [ ] Lista i wynik testów
- [ ] Kroki testów manualnych (gdy dotyczy)
- [ ] Brak sekretów/danych prywatnych
- [ ] Oparte na dowodach

## Ogólny szablon PR

```md
#### Summary

#### Behavior Changes

#### Codebase and GitHub Search

#### Tests

#### Manual Testing (omit if N/A)

### Prerequisites

-

### Steps

1.
2.

#### Evidence (omit if N/A)

**Sign-Off**

- Models used:
- Submitter effort (self-reported):
- Agent notes (optional, cite evidence):
```

## Szablony typów PR (zastąp swoim typem)

### Naprawa

```md
#### Summary

#### Repro Steps

#### Root Cause

#### Behavior Changes

#### Tests

#### Manual Testing (omit if N/A)

### Prerequisites

-

### Steps

1.
2.

#### Evidence (omit if N/A)

**Sign-Off**

- Models used:
- Submitter effort:
- Agent notes:
```

### Funkcja

```md
#### Summary

#### Use Cases

#### Behavior Changes

#### Existing Functionality Check

- [ ] I searched the codebase for existing functionality.
      Searches performed (1-3 bullets):
  -
  -

#### Tests

#### Manual Testing (omit if N/A)

### Prerequisites

-

### Steps

1.
2.

#### Evidence (omit if N/A)

**Sign-Off**

- Models used:
- Submitter effort:
- Agent notes:
```

### Refaktoryzacja

```md
#### Summary

#### Scope

#### No Behavior Change Statement

#### Tests

#### Manual Testing (omit if N/A)

### Prerequisites

-

### Steps

1.
2.

#### Evidence (omit if N/A)

**Sign-Off**

- Models used:
- Submitter effort:
- Agent notes:
```

### Prace porządkowe/Utrzymanie

```md
#### Summary

#### Why This Matters

#### Tests

#### Manual Testing (omit if N/A)

### Prerequisites

-

### Steps

1.
2.

#### Evidence (omit if N/A)

**Sign-Off**

- Models used:
- Submitter effort:
- Agent notes:
```

### Dokumentacja

```md
#### Summary

#### Pages Updated

#### Before/After

#### Formatting

pnpm format

#### Evidence (omit if N/A)

**Sign-Off**

- Models used:
- Submitter effort:
- Agent notes:
```

### Testy

```md
#### Summary

#### Gap Covered

#### Tests

#### Manual Testing (omit if N/A)

### Prerequisites

-

### Steps

1.
2.

#### Evidence (omit if N/A)

**Sign-Off**

- Models used:
- Submitter effort:
- Agent notes:
```

### Perf

```md
#### Summary

#### Baseline

#### After

#### Measurement Method

#### Tests

#### Manual Testing (omit if N/A)

### Prerequisites

-

### Steps

1.
2.

#### Evidence (omit if N/A)

**Sign-Off**

- Models used:
- Submitter effort:
- Agent notes:
```

### UX/UI

```md
#### Summary

#### Screenshots or Video

#### Accessibility Impact

#### Tests

#### Manual Testing

### Prerequisites

-

### Steps

1.
2. **Sign-Off**

- Models used:
- Submitter effort:
- Agent notes:
```

### Infrastruktura/Build

```md
#### Summary

#### Environments Affected

#### Validation Steps

#### Manual Testing (omit if N/A)

### Prerequisites

-

### Steps

1.
2.

#### Evidence (omit if N/A)

**Sign-Off**

- Models used:
- Submitter effort:
- Agent notes:
```

### Bezpieczeństwo

```md
#### Summary

#### Risk Summary

#### Repro Steps

#### Mitigation or Fix

#### Verification

#### Tests

#### Manual Testing (omit if N/A)

### Prerequisites

-

### Steps

1.
2.

#### Evidence (omit if N/A)

**Sign-Off**

- Models used:
- Submitter effort:
- Agent notes:
```
