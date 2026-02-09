---
summary: "Co zawiera systemowy prompt OpenClaw i jak jest składany"
read_when:
  - Edytowanie tekstu systemowego promptu, listy narzędzi lub sekcji czasu/heartbeat
  - Zmienianie zachowania bootstrapu obszaru roboczego lub wstrzykiwania Skills
title: "Systemowy prompt"
---

# Systemowy prompt

OpenClaw buduje niestandardowy systemowy prompt dla każdego uruchomienia agenta. Prompt jest **zarządzany przez OpenClaw** i nie korzysta z domyślnego promptu p-coding-agent.

Prompt jest składany przez OpenClaw i wstrzykiwany do każdego uruchomienia agenta.

## Struktura

Prompt jest celowo zwięzły i wykorzystuje stałe sekcje:

- **Tooling**: bieżąca lista narzędzi + krótkie opisy.
- **Safety**: krótkie przypomnienie o barierach bezpieczeństwa, aby unikać zachowań polegających na dążeniu do władzy lub omijaniu nadzoru.
- **Skills** (gdy dostępne): informuje model, jak na żądanie wczytywać instrukcje umiejętności.
- **OpenClaw Self-Update**: jak uruchomić `config.apply` i `update.run`.
- **Workspace**: katalog roboczy (`agents.defaults.workspace`).
- **Documentation**: lokalna ścieżka do dokumentacji OpenClaw (repozytorium lub pakiet npm) oraz kiedy ją czytać.
- **Workspace Files (injected)**: wskazuje, że pliki bootstrapu są dołączone poniżej.
- **Sandbox** (gdy włączony): wskazuje środowisko sandbox, ścieżki sandbox oraz to, czy dostępne jest wykonanie z podwyższonymi uprawnieniami.
- **Current Date & Time**: lokalny czas użytkownika, strefa czasowa oraz format czasu.
- **Reply Tags**: opcjonalna składnia tagów odpowiedzi dla obsługiwanych dostawców.
- **Heartbeats**: prompt heartbeat oraz zachowanie potwierdzeń.
- **Runtime**: host, system operacyjny, node, model, katalog główny repozytorium (jeśli wykryty), poziom „thinking” (jedna linia).
- **Reasoning**: bieżący poziom widoczności + wskazówka dotycząca przełącznika /reasoning.

Zabezpieczenia bezpieczeństwa w systemowym promptcie mają charakter doradczy. Kierują zachowaniem modelu, ale nie egzekwują polityk. Do twardego egzekwowania używaj polityk narzędzi, zatwierdzeń exec, sandboxing oraz list dozwolonych kanałów; operatorzy mogą je celowo wyłączyć.

## Tryby promptu

OpenClaw może renderować mniejsze systemowe prompty dla sub-agentów. Środowisko uruchomieniowe ustawia
`promptMode` dla każdego uruchomienia (nie jest to konfiguracja widoczna dla użytkownika):

- `full` (domyślny): zawiera wszystkie powyższe sekcje.
- `minimal`: używany dla sub-agentów; pomija **Skills**, **Memory Recall**, **OpenClaw
  Self-Update**, **Model Aliases**, **User Identity**, **Reply Tags**,
  **Messaging**, **Silent Replies** oraz **Heartbeats**. Tooling, **Safety**,
  Workspace, Sandbox, Current Date & Time (jeśli znane), Runtime oraz wstrzyknięty
  kontekst pozostają dostępne.
- `none`: zwraca wyłącznie bazową linię tożsamości.

Gdy `promptMode=minimal`, dodatkowe wstrzyknięte prompty są oznaczane jako **Subagent
Context** zamiast **Group Chat Context**.

## Wstrzykiwanie bootstrapu obszaru roboczego

Pliki bootstrapu są przycinane i dołączane w sekcji **Project Context**, aby model widział kontekst tożsamości i profilu bez potrzeby jawnych odczytów:

- `AGENTS.md`
- `SOUL.md`
- `TOOLS.md`
- `IDENTITY.md`
- `USER.md`
- `HEARTBEAT.md`
- `BOOTSTRAP.md` (tylko w zupełnie nowych obszarach roboczych)

Duże pliki są obcinane z odpowiednim znacznikiem. Maksymalny rozmiar na plik jest kontrolowany przez
`agents.defaults.bootstrapMaxChars` (domyślnie: 20000). Brakujące pliki wstrzykują
krótki znacznik braku pliku.

Wewnętrzne hooki mogą przechwycić ten krok przez `agent:bootstrap`, aby modyfikować lub zastępować
wstrzyknięte pliki bootstrapu (na przykład zamieniając `SOUL.md` na alternatywną personę).

Aby sprawdzić, jaki wkład ma każdy wstrzyknięty plik (surowy vs wstrzyknięty, obcięcie oraz narzut schematu narzędzi), użyj `/context list` lub `/context detail`. Zobacz [Context](/concepts/context).

## Obsługa czasu

Systemowy prompt zawiera dedykowaną sekcję **Current Date & Time**, gdy znana jest
strefa czasowa użytkownika. Aby zachować stabilność cache promptu, obecnie zawiera ona tylko
**strefę czasową** (bez dynamicznego zegara ani formatu czasu).

Użyj `session_status`, gdy agent potrzebuje bieżącego czasu; karta statusu
zawiera wiersz z sygnaturą czasową.

Skonfiguruj za pomocą:

- `agents.defaults.userTimezone`
- `agents.defaults.timeFormat` (`auto` | `12` | `24`)

Zobacz [Date & Time](/date-time), aby poznać pełne szczegóły zachowania.

## Skills

Gdy istnieją kwalifikujące się umiejętności, OpenClaw wstrzykuje zwięzłą **listę dostępnych Skills**
(`formatSkillsForPrompt`), która zawiera **ścieżkę pliku** dla każdej umiejętności. Prompt instruuje model,
aby używał `read` do wczytania pliku SKILL.md w podanej lokalizacji
(obszar roboczy, zarządzane lub dołączone). Jeśli żadna umiejętność się nie kwalifikuje,
sekcja Skills jest pomijana.

```
<available_skills>
  <skill>
    <name>...</name>
    <description>...</description>
    <location>...</location>
  </skill>
</available_skills>
```

Pozwala to utrzymać mały rozmiar bazowego promptu, przy jednoczesnym umożliwieniu ukierunkowanego użycia umiejętności.

## Dokumentacja

Gdy jest dostępna, systemowy prompt zawiera sekcję **Documentation**, która wskazuje
lokalny katalog dokumentacji OpenClaw (albo `docs/` w obszarze roboczym repozytorium, albo
dołączoną dokumentację pakietu npm), a także informuje o publicznym mirrorze, repozytorium źródłowym,
społeczności Discord oraz ClawHub ([https://clawhub.com](https://clawhub.com)) do odkrywania Skills. Prompt instruuje model, aby w pierwszej kolejności konsultował lokalną dokumentację
w kwestiach zachowania OpenClaw, poleceń, konfiguracji lub architektury, oraz aby samodzielnie uruchamiał
`openclaw status`, gdy to możliwe (pytając użytkownika tylko wtedy, gdy nie ma dostępu).
