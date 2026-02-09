---
summary: "Kontekst: co widzi model, jak jest budowany i jak go sprawdzić"
read_when:
  - Chcesz zrozumieć, co w OpenClaw oznacza „kontekst”
  - Debugujesz, dlaczego model „wie” coś (albo o tym zapomniał)
  - Chcesz zmniejszyć narzut kontekstu (/context, /status, /compact)
title: "Kontekst"
---

# Kontekst

„Kontekst” to **wszystko, co OpenClaw wysyła do modelu na potrzeby pojedynczego uruchomienia**. Jest on ograniczony **oknem kontekstu** modelu (limitem tokenów).

Intuicyjny model dla początkujących:

- **Prompt systemowy** (zbudowany przez OpenClaw): reguły, narzędzia, lista Skills, czas/środowisko uruchomieniowe oraz wstrzyknięte pliki obszaru roboczego.
- **Historia rozmowy**: Twoje wiadomości + odpowiedzi asystenta w tej sesji.
- **Wywołania narzędzi/wyniki + załączniki**: wyjścia poleceń, odczyty plików, obrazy/audio itp.

Kontekst _nie jest tym samym_ co „pamięć”: pamięć może być zapisana na dysku i wczytana później; kontekst to to, co mieści się w bieżącym oknie modelu.

## Szybki start (inspekcja kontekstu)

- `/status` → szybki widok „jak bardzo zapełnione jest moje okno?” + ustawienia sesji.
- `/context list` → co jest wstrzykiwane + przybliżone rozmiary (na plik + sumy).
- `/context detail` → głębszy podział: rozmiary na plik, rozmiary schematów narzędzi, rozmiary wpisów Skills oraz rozmiar promptu systemowego.
- `/usage tokens` → dołącza stopkę użycia na odpowiedź do zwykłych odpowiedzi.
- `/compact` → streszcza starszą historię do zwartego wpisu, aby zwolnić miejsce w oknie.

Zobacz także: [Polecenia ukośnikowe](/tools/slash-commands), [Użycie tokenów i koszty](/reference/token-use), [Kompakcja](/concepts/compaction).

## Przykładowe wyjście

Wartości różnią się w zależności od modelu, dostawcy, polityki narzędzi i zawartości obszaru roboczego.

### `/context list`

```
🧠 Context breakdown
Workspace: <workspaceDir>
Bootstrap max/file: 20,000 chars
Sandbox: mode=non-main sandboxed=false
System prompt (run): 38,412 chars (~9,603 tok) (Project Context 23,901 chars (~5,976 tok))

Injected workspace files:
- AGENTS.md: OK | raw 1,742 chars (~436 tok) | injected 1,742 chars (~436 tok)
- SOUL.md: OK | raw 912 chars (~228 tok) | injected 912 chars (~228 tok)
- TOOLS.md: TRUNCATED | raw 54,210 chars (~13,553 tok) | injected 20,962 chars (~5,241 tok)
- IDENTITY.md: OK | raw 211 chars (~53 tok) | injected 211 chars (~53 tok)
- USER.md: OK | raw 388 chars (~97 tok) | injected 388 chars (~97 tok)
- HEARTBEAT.md: MISSING | raw 0 | injected 0
- BOOTSTRAP.md: OK | raw 0 chars (~0 tok) | injected 0 chars (~0 tok)

Skills list (system prompt text): 2,184 chars (~546 tok) (12 skills)
Tools: read, edit, write, exec, process, browser, message, sessions_send, …
Tool list (system prompt text): 1,032 chars (~258 tok)
Tool schemas (JSON): 31,988 chars (~7,997 tok) (counts toward context; not shown as text)
Tools: (same as above)

Session tokens (cached): 14,250 total / ctx=32,000
```

### `/context detail`

```
🧠 Context breakdown (detailed)
…
Top skills (prompt entry size):
- frontend-design: 412 chars (~103 tok)
- oracle: 401 chars (~101 tok)
… (+10 more skills)

Top tools (schema size):
- browser: 9,812 chars (~2,453 tok)
- exec: 6,240 chars (~1,560 tok)
… (+N more tools)
```

## Co wlicza się do okna kontekstu

Liczy się wszystko, co otrzymuje model, w tym:

- Prompt systemowy (wszystkie sekcje).
- Historia rozmowy.
- Wywołania narzędzi + wyniki narzędzi.
- Załączniki/transkrypty (obrazy/audio/pliki).
- Podsumowania kompakcji i artefakty przycinania.
- „Opakowania” dostawcy lub ukryte nagłówki (niewidoczne, ale liczone).

## Jak OpenClaw buduje prompt systemowy

Prompt systemowy jest **własnością OpenClaw** i jest przebudowywany przy każdym uruchomieniu. Zawiera:

- Listę narzędzi + krótkie opisy.
- Listę Skills (tylko metadane; patrz poniżej).
- Lokalizację obszaru roboczego.
- Czas (UTC + przeliczony czas użytkownika, jeśli skonfigurowano).
- Metadane środowiska uruchomieniowego (host/OS/model/myślenie).
- Wstrzyknięte pliki bootstrapowe obszaru roboczego w sekcji **Project Context**.

Pełny podział: [Prompt systemowy](/concepts/system-prompt).

## Wstrzyknięte pliki obszaru roboczego (Project Context)

Domyślnie OpenClaw wstrzykuje stały zestaw plików obszaru roboczego (jeśli są obecne):

- `AGENTS.md`
- `SOUL.md`
- `TOOLS.md`
- `IDENTITY.md`
- `USER.md`
- `HEARTBEAT.md`
- `BOOTSTRAP.md` (tylko przy pierwszym uruchomieniu)

Duże pliki są obcinane per plik przy użyciu `agents.defaults.bootstrapMaxChars` (domyślnie `20000` znaków). `/context` pokazuje rozmiary **surowe vs wstrzyknięte** oraz informuje, czy nastąpiło obcięcie.

## Skills: co jest wstrzykiwane, a co ładowane na żądanie

Prompt systemowy zawiera zwartą **listę Skills** (nazwa + opis + lokalizacja). Ta lista generuje realny narzut.

Instrukcje Skills _nie_ są dołączane domyślnie. Oczekuje się, że model `read` `SKILL.md` danej umiejętności **tylko wtedy, gdy jest potrzebna**.

## Narzędzia: są dwa koszty

Narzędzia wpływają na kontekst na dwa sposoby:

1. **Tekst listy narzędzi** w promptcie systemowym (to, co widzisz jako „Tooling”).
2. **Schematy narzędzi** (JSON). Są wysyłane do modelu, aby mógł wywoływać narzędzia. Wliczają się do kontekstu, mimo że nie widzisz ich jako zwykłego tekstu.

`/context detail` rozbija największe schematy narzędzi, aby pokazać, co dominuje.

## Polecenia, dyrektywy i „skrótowce inline”

Polecenia ukośnikowe są obsługiwane przez Gateway. Istnieje kilka zachowań:

- **Polecenia samodzielne**: wiadomość, która składa się wyłącznie z `/...`, jest uruchamiana jako polecenie.
- **Dyrektywy**: `/think`, `/verbose`, `/reasoning`, `/elevated`, `/model`, `/queue` są usuwane, zanim model zobaczy wiadomość.
  - Wiadomości zawierające wyłącznie dyrektywy utrwalają ustawienia sesji.
  - Dyrektywy inline w zwykłej wiadomości działają jako wskazówki per wiadomość.
- **Skrótowce inline** (tylko dla nadawców z listy dozwolonych): określone tokeny `/...` wewnątrz zwykłej wiadomości mogą uruchomić się natychmiast (np. „hej /status”) i są usuwane, zanim model zobaczy pozostały tekst.

Szczegóły: [Polecenia ukośnikowe](/tools/slash-commands).

## Sesje, kompakcja i przycinanie (co się utrwala)

To, co utrzymuje się między wiadomościami, zależy od mechanizmu:

- **Zwykła historia** utrzymuje się w transkrypcie sesji, dopóki nie zostanie skompaktowana/przycięta przez politykę.
- **Kompakcja** utrwala podsumowanie w transkrypcie i zachowuje nienaruszone najnowsze wiadomości.
- **Przycinanie** usuwa stare wyniki narzędzi z promptu _w pamięci_ dla danego uruchomienia, ale nie przepisuje transkryptu.

Dokumentacja: [Sesja](/concepts/session), [Kompakcja](/concepts/compaction), [Przycinanie sesji](/concepts/session-pruning).

## Co `/context` faktycznie raportuje

`/context` preferuje najnowszy raport promptu systemowego **zbudowany podczas uruchomienia**, gdy jest dostępny:

- `System prompt (run)` = przechwycony z ostatniego uruchomienia osadzonego (z obsługą narzędzi) i utrwalony w magazynie sesji.
- `System prompt (estimate)` = obliczany w locie, gdy nie istnieje raport z uruchomienia (albo gdy uruchamiasz przez backend CLI, który nie generuje raportu).

W obu przypadkach raportuje rozmiary i główne czynniki; **nie** zrzuca pełnego promptu systemowego ani schematów narzędzi.
