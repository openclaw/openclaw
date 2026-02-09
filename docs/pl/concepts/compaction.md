---
summary: "„Okno kontekstu + kompakcja: jak OpenClaw utrzymuje sesje w limitach modelu”"
read_when:
  - Chcesz zrozumieć automatyczną kompakcję i /compact
  - Debugujesz długie sesje trafiające na limity kontekstu
title: "Kompakcja a przycinanie"
---

# Okno kontekstu i kompakcja

Każdy model ma **okno kontekstu** (maksymalną liczbę tokenów, które może „widzieć”). Długotrwałe czaty gromadzą wiadomości i wyniki narzędzi; gdy okno się zapełnia, OpenClaw **kompaktuje** starszą historię, aby pozostać w limitach.

## Czym jest kompakcja

Kompakcja **streszcza starszą rozmowę** do zwartego wpisu podsumowującego i pozostawia nowsze wiadomości bez zmian. Podsumowanie jest zapisywane w historii sesji, więc kolejne żądania wykorzystują:

- podsumowanie kompakcji
- nowsze wiadomości po punkcie kompakcji

Kompakcja **utrzymuje się** w historii JSONL sesji.

## Konfiguracja

Zobacz [Konfiguracja i tryby kompakcji](/concepts/compaction) dla ustawień `agents.defaults.compaction`.

## Automatyczna kompakcja (domyślnie włączona)

Gdy sesja zbliża się do limitu okna kontekstu modelu lub go przekracza, OpenClaw uruchamia automatyczną kompakcję i może ponowić pierwotne żądanie, używając skompaktowanego kontekstu.

Zobaczysz:

- `🧹 Auto-compaction complete` w trybie verbose
- `/status` pokazujące `🧹 Compactions: <count>`

Przed kompakcją OpenClaw może wykonać **ciche opróżnienie pamięci**, aby zapisać trwałe notatki na dysku. Szczegóły i konfigurację znajdziesz w [Memory](/concepts/memory).

## Ręczna kompakcja

Użyj `/compact` (opcjonalnie z instrukcjami), aby wymusić przebieg kompakcji:

```
/compact Focus on decisions and open questions
```

## Źródło okna kontekstu

Okno kontekstu jest specyficzne dla modelu. OpenClaw korzysta z definicji modelu z katalogu dostawcy skonfigurowanego w systemie, aby określić limity.

## Kompresja vs pruning

- **Kompakcja**: streszcza i **utrzymuje** w JSONL.
- **Przycinanie sesji**: usuwa tylko stare **wyniki narzędzi**, **w pamięci**, na potrzeby pojedynczego żądania.

Szczegóły przycinania znajdziesz w [/concepts/session-pruning](/concepts/session-pruning).

## Wskazówki

- Użyj `/compact`, gdy sesje wydają się „zastałe” lub kontekst jest nadmiernie rozdmuchany.
- Duże wyjścia narzędzi są już obcinane; przycinanie może dodatkowo zmniejszyć narastanie wyników narzędzi.
- Jeśli potrzebujesz czystej karty, `/new` lub `/reset` rozpoczyna nowy identyfikator sesji.
