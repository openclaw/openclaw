---
summary: "„Notatki badawcze: system pamięci offline dla obszarów roboczych Clawd (Markdown jako źródło prawdy + indeks pochodny)”"
read_when:
  - Projektowanie pamięci obszaru roboczego (~/.openclaw/workspace) poza dziennymi logami Markdown
  - Deciding: "Decyzja: samodzielne CLI vs głęboka integracja z OpenClaw"
  - Dodawanie przywoływania offline + refleksji (retain/recall/reflect)
title: "„Badania nad pamięcią obszaru roboczego”"
---

# Workspace Memory v2 (offline): notatki badawcze

Cel: obszar roboczy w stylu Clawd (`agents.defaults.workspace`, domyślnie `~/.openclaw/workspace`), w którym „pamięć” jest przechowywana jako jeden plik Markdown na dzień (`memory/YYYY-MM-DD.md`) oraz niewielki zestaw plików stabilnych (np. `memory.md`, `SOUL.md`).

Ten dokument proponuje architekturę pamięci **offline-first**, która zachowuje Markdown jako kanoniczne, możliwe do przeglądu źródło prawdy, a jednocześnie dodaje **ustrukturyzowane przywoływanie** (wyszukiwanie, podsumowania encji, aktualizacje pewności) za pomocą indeksu pochodnego.

## Dlaczego zmiana?

Obecna konfiguracja (jeden plik na dzień) świetnie sprawdza się w:

- dziennikowaniu „append-only”
- edycji przez człowieka
- trwałość zabezpieczona gitem + możliwość kontroli
- niskim progu zapisu („po prostu to zapisz”)

Jest słaba w:

- wyszukiwaniu o wysokiej kompletności („co ustaliliśmy w sprawie X?”, „kiedy ostatnio próbowaliśmy Y?”)
- odpowiedziach zorientowanych na encje („opowiedz mi o Alice / The Castle / warelay”) bez ponownego czytania wielu plików
- stabilności opinii/preferencji (oraz dowodach, gdy się zmieniają)
- ograniczeniach czasowych („co było prawdą w listopadzie 2025?”) i rozwiązywaniu konfliktów

## Cele projektowe

- **Offline**: działa bez sieci; może działać na laptopie/Castle; brak zależności od chmury.
- **Wyjaśnialność**: odzyskane elementy powinny mieć atrybucję (plik + lokalizacja) i być oddzielne od wnioskowania.
- **Niska ceremonialność**: dzienne logowanie pozostaje w Markdown, bez ciężkich schematów.
- **Inkrementalność**: v1 jest użyteczne już z samym FTS; semantyka/wektory i grafy to opcjonalne rozszerzenia.
- **Przyjazność dla agentów**: ułatwia „przywoływanie w ramach budżetów tokenów” (zwracanie małych pakietów faktów).

## Model północnej gwiazdy (Hindsight × Letta)

Dwa elementy do połączenia:

1. **Pętla kontrolna w stylu Letta/MemGPT**

- utrzymuj mały „rdzeń” zawsze w kontekście (persona + kluczowe fakty o użytkowniku)
- cała reszta jest poza kontekstem i pobierana przez narzędzia
- zapisy pamięci są jawnymi wywołaniami narzędzi (append/replace/insert), utrwalane, a następnie ponownie wstrzykiwane w następnej turze

2. **Podłoże pamięci w stylu Hindsight**

- rozdzielenie tego, co zaobserwowane, od tego, w co się wierzy, i od tego, co jest podsumowane
- wsparcie dla retain/recall/reflect
- opinie z nośnikiem pewności, które mogą ewoluować wraz z dowodami
- przywoływanie świadome encji + zapytania temporalne (nawet bez pełnych grafów wiedzy)

## Proponowana architektura (Markdown jako źródło prawdy + indeks pochodny)

### Sklep kanoniczny (przyjazny dla gita)

Zachowaj `~/.openclaw/workspace` jako kanoniczną, czytelną dla człowieka pamięć.

Sugerowany układ obszaru roboczego:

```
~/.openclaw/workspace/
  memory.md                    # small: durable facts + preferences (core-ish)
  memory/
    YYYY-MM-DD.md              # daily log (append; narrative)
  bank/                        # “typed” memory pages (stable, reviewable)
    world.md                   # objective facts about the world
    experience.md              # what the agent did (first-person)
    opinions.md                # subjective prefs/judgments + confidence + evidence pointers
    entities/
      Peter.md
      The-Castle.md
      warelay.md
      ...
```

Uwagi:

- **Dzienny log pozostaje dziennym logiem**. Nie ma potrzeby zamiany na JSON.
- Pliki `bank/` są **kuratorowane**, tworzone przez zadania refleksji i nadal mogą być edytowane ręcznie.
- `memory.md` pozostaje „małe + rdzeniowe”: rzeczy, które chcesz, aby Clawd widział w każdej sesji.

### Sklep pochodny (przywoływanie maszynowe)

Dodaj indeks pochodny pod obszarem roboczym (niekoniecznie śledzony przez git):

```
~/.openclaw/workspace/.memory/index.sqlite
```

Oparty na:

- schemacie SQLite dla faktów + powiązań encji + metadanych opinii
- SQLite **FTS5** do przywoływania leksykalnego (szybkie, małe, offline)
- opcjonalnej tabeli embeddingów do przywoływania semantycznego (również offline)

Indeks jest zawsze **odtwarzalny z Markdown**.

## Retain / Recall / Reflect (pętla operacyjna)

### Retain: normalizacja dziennych logów do „faktów”

Kluczowy wgląd Hindsight, który ma tu znaczenie: przechowuj **narracyjne, samodzielne fakty**, a nie drobne fragmenty.

Praktyczna zasada dla `memory/YYYY-MM-DD.md`:

- na koniec dnia (lub w trakcie) dodaj sekcję `## Retain` z 2–5 punktami, które są:
  - narracyjne (zachowany kontekst wieloturnowy)
  - samodzielne (mają sens później w oderwaniu)
  - oznaczone typem + wzmiankami o encjach

Przykład:

```
## Retain
- W @Peter: Currently in Marrakech (Nov 27–Dec 1, 2025) for Andy’s birthday.
- B @warelay: I fixed the Baileys WS crash by wrapping connection.update handlers in try/catch (see memory/2025-11-27.md).
- O(c=0.95) @Peter: Prefers concise replies (&lt;1500 chars) on WhatsApp; long content goes into files.
```

Minimalne parsowanie:

- Prefiks typu: `W` (świat), `B` (doświadczenie/biograficzne), `O` (opinia), `S` (obserwacja/podsumowanie; zwykle generowane)
- Encje: `@Peter`, `@warelay` itd. (slug mapuje do `bank/entities/*.md`)
- Pewność opinii: `O(c=0.0..1.0)` opcjonalnie

Jeśli nie chcesz, aby autorzy musieli o tym myśleć: zadanie refleksji może wywnioskować te punkty z reszty logu, ale posiadanie jawnej sekcji `## Retain` jest najprostszą „dźwignią jakości”.

### Recall: zapytania nad indeksem pochodnym

Przywoływanie powinno wspierać:

- **leksykalne**: „znajdź dokładne terminy / nazwy / polecenia” (FTS5)
- **encje**: „opowiedz mi o X” (strony encji + fakty powiązane z encjami)
- **temporalne**: „co wydarzyło się około 27 listopada” / „od zeszłego tygodnia”
- **opinie**: „co preferuje Peter?” (z pewnością + dowodami)

Format zwrotu powinien być przyjazny dla agentów i cytować źródła:

- `kind` (`world|experience|opinion|observation`)
- `timestamp` (dzień źródłowy lub wyekstrahowany zakres czasu, jeśli obecny)
- `entities` (`["Peter","warelay"]`)
- `content` (fakt narracyjny)
- `source` (`memory/2025-11-27.md#L12` itd.)

### Reflect: tworzenie stabilnych stron + aktualizacja przekonań

Refleksja to zaplanowane zadanie (codziennie lub heartbeat `ultrathink`), które:

- aktualizuje `bank/entities/*.md` na podstawie ostatnich faktów (podsumowania encji)
- aktualizuje pewność `bank/opinions.md` na podstawie wzmocnień/sprzeczności
- opcjonalnie proponuje edycje `memory.md` („rdzeniowe” trwałe fakty)

Ewolucja opinii (prosta, wyjaśnialna):

- każda opinia ma:
  - stwierdzenie
  - pewność `c ∈ [0,1]`
  - last_updated
  - linki do dowodów (wspierające + sprzeczne identyfikatory faktów)
- gdy pojawiają się nowe fakty:
  - znajdź kandydackie opinie według nakładania encji + podobieństwa (najpierw FTS, później embeddingi)
  - aktualizuj pewność małymi deltami; duże skoki wymagają silnej sprzeczności + powtarzalnych dowodów

## Integracja CLI: samodzielna vs głęboka integracja

Rekomendacja: **głęboka integracja z OpenClaw**, przy jednoczesnym zachowaniu wydzielonej biblioteki rdzeniowej.

### Dlaczego integrować z OpenClaw?

- OpenClaw już zna:
  - ścieżkę obszaru roboczego (`agents.defaults.workspace`)
  - model sesji + heartbeat
  - wzorce logowania i rozwiązywania problemów
- Chcesz, aby sam agent wywoływał narzędzia:
  - `openclaw memory recall "…" --k 25 --since 30d`
  - `openclaw memory reflect --since 7d`

### Dlaczego mimo to wydzielić bibliotekę?

- utrzymać logikę pamięci testowalną bez gateway/runtime
- ponowne użycie w innych kontekstach (skrypty lokalne, przyszła aplikacja desktopowa itd.)

Kształt:
Narzędzia pamięci mają być małą warstwą CLI + biblioteki, ale to wyłącznie eksploracja.

## „S-Collide” / SuCo: kiedy używać (badania)

Jeśli „S-Collide” odnosi się do **SuCo (Subspace Collision)**: jest to podejście do wyszukiwania ANN, które celuje w korzystne kompromisy między kompletnością a opóźnieniami, wykorzystując wyuczone/ustrukturyzowane kolizje w podprzestrzeniach (artykuł: arXiv 2411.14754, 2024).

Pragmatyczne podejście dla `~/.openclaw/workspace`:

- **nie zaczynaj** od SuCo.
- zacznij od SQLite FTS + (opcjonalnie) prostych embeddingów; natychmiast uzyskasz większość korzyści UX.
- rozważ rozwiązania klasy SuCo/HNSW/ScaNN dopiero wtedy, gdy:
  - korpus jest duży (dziesiątki/setki tysięcy fragmentów)
  - brutalne przeszukiwanie embeddingów staje się zbyt wolne
  - jakość przywoływania jest realnie ograniczana przez wyszukiwanie leksykalne

Alternatywy przyjazne offline (rosnąca złożoność):

- SQLite FTS5 + filtry metadanych (zero ML)
- Embeddingi + brute force (działa zaskakująco daleko przy małej liczbie fragmentów)
- Indeks HNSW (powszechny, solidny; wymaga powiązania biblioteki)
- SuCo (badawczy; atrakcyjny, jeśli istnieje solidna implementacja możliwa do osadzenia)

Otwarte pytanie:

- jaki jest **najlepszy** model embeddingów offline dla „pamięci osobistego asystenta” na Twoich maszynach (laptop + desktop)?
  - jeśli masz już Ollama: twórz embeddingi lokalnym modelem; w przeciwnym razie dołącz mały model embeddingów do toolchainu.

## Najmniejszy użyteczny pilot

Jeśli chcesz minimalną, a nadal użyteczną wersję:

- Dodaj strony encji `bank/` oraz sekcję `## Retain` w dziennych logach.
- Użyj SQLite FTS do przywoływania z cytowaniami (ścieżka + numery linii).
- Dodaj embeddingi tylko wtedy, gdy jakość przywoływania lub skala tego wymagają.

## Odniesienia

- Koncepcje Letta / MemGPT: „core memory blocks” + „archival memory” + pamięć samoredagująca sterowana narzędziami.
- Raport techniczny Hindsight: „retain / recall / reflect”, pamięć czterosieciowa, ekstrakcja faktów narracyjnych, ewolucja pewności opinii.
- SuCo: arXiv 2411.14754 (2024): „Subspace Collision” – przybliżone wyszukiwanie najbliższych sąsiadów.
