---
summary: "Składnia dyrektyw dla /think + /verbose oraz ich wpływ na rozumowanie modelu"
read_when:
  - Dostosowywanie parsowania dyrektyw think lub verbose albo ustawień domyślnych
title: "Poziomy myślenia"
---

# Poziomy myślenia (dyrektywy /think)

## Co to robi

- Dyrektywa wstawiana inline w dowolnej treści przychodzącej: `/t <level>`, `/think:<level>` lub `/thinking <level>`.
- Poziomy (aliasy): `off | minimal | low | medium | high | xhigh` (tylko modele GPT-5.2 + Codex)
  - minimal → „think”
  - low → „think hard”
  - medium → „think harder”
  - high → „ultrathink” (maksymalny budżet)
  - xhigh → „ultrathink+” (tylko modele GPT-5.2 + Codex)
  - `x-high`, `x_high`, `extra-high`, `extra high` oraz `extra_high` mapują się na `xhigh`.
  - `highest`, `max` mapują się na `high`.
- Uwagi dotyczące dostawców:
  - Z.AI (`zai/*`) obsługuje wyłącznie binarne myślenie (`on`/`off`). Każdy poziom inny niż `off` jest traktowany jako `on` (mapowany do `low`).

## Kolejność rozstrzygania

1. Dyrektywa inline w wiadomości (dotyczy tylko tej wiadomości).
2. Nadpisanie sesji (ustawione przez wysłanie wiadomości zawierającej wyłącznie dyrektywę).
3. Domyślne globalne (`agents.defaults.thinkingDefault` w konfiguracji).
4. Fallback: low dla modeli zdolnych do rozumowania; w przeciwnym razie off.

## Ustawianie domyślnego poziomu sesji

- Wyślij wiadomość, która zawiera **wyłącznie** dyrektywę (dozwolone są białe znaki), np. `/think:medium` lub `/t high`.
- Ustawienie obowiązuje dla bieżącej sesji (domyślnie per nadawca); jest czyszczone przez `/think:off` lub reset bezczynności sesji.
- Wysyłana jest odpowiedź potwierdzająca (`Thinking level set to high.` / `Thinking disabled.`). Jeśli poziom jest nieprawidłowy (np. `/thinking big`), polecenie zostaje odrzucone z podpowiedzią, a stan sesji pozostaje bez zmian.
- Wyślij `/think` (lub `/think:`) bez argumentu, aby zobaczyć bieżący poziom myślenia.

## Zastosowanie przez agenta

- **Wbudowany Pi**: ustalony poziom jest przekazywany do środowiska wykonawczego agenta Pi działającego w procesie.

## Dyrektywy verbose (/verbose lub /v)

- Poziomy: `on` (minimalny) | `full` | `off` (domyślny).
- Wiadomość zawierająca wyłącznie dyrektywę przełącza verbose dla sesji i odpowiada `Verbose logging enabled.` / `Verbose logging disabled.`; nieprawidłowe poziomy zwracają podpowiedź bez zmiany stanu.
- `/verbose off` zapisuje jawne nadpisanie sesji; można je wyczyścić przez interfejs Sesji, wybierając `inherit`.
- Dyrektywa inline dotyczy tylko tej wiadomości; w pozostałych przypadkach obowiązują domyślne ustawienia sesji/globalne.
- Wyślij `/verbose` (lub `/verbose:`) bez argumentu, aby zobaczyć bieżący poziom verbose.
- Gdy verbose jest włączone, agenci emitujący ustrukturyzowane wyniki narzędzi (Pi, inne agenty JSON) wysyłają każde wywołanie narzędzia jako osobną wiadomość zawierającą wyłącznie metadane, z prefiksem `<emoji> <tool-name>: <arg>`, gdy jest dostępny (ścieżka/polecenie). Te podsumowania narzędzi są wysyłane natychmiast po starcie każdego narzędzia (oddzielne „bąbelki”), a nie jako strumieniowane delty.
- Gdy verbose jest `full`, po zakończeniu przekazywane są także wyjścia narzędzi (oddzielny „bąbelek”, przycięty do bezpiecznej długości). Jeśli przełączysz `/verbose on|full|off` w trakcie wykonywania, kolejne „bąbelki” narzędzi będą respektować nowe ustawienie.

## Widoczność rozumowania (/reasoning)

- Poziomy: `on|off|stream`.
- Wiadomość zawierająca wyłącznie dyrektywę przełącza wyświetlanie bloków myślenia w odpowiedziach.
- Gdy włączone, rozumowanie jest wysyłane jako **osobna wiadomość** z prefiksem `Reasoning:`.
- `stream` (tylko Telegram): strumieniuje rozumowanie do szkicu wiadomości w Telegramie podczas generowania odpowiedzi, a następnie wysyła odpowiedź końcową bez rozumowania.
- Alias: `/reason`.
- Wyślij `/reasoning` (lub `/reasoning:`) bez argumentu, aby zobaczyć bieżący poziom rozumowania.

## Powiązane

- Dokumentacja trybu podwyższonego znajduje się w [Elevated mode](/tools/elevated).

## Heartbeats

- Treść sondy heartbeat to skonfigurowany prompt heartbeat (domyślnie: `Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.`). Dyrektywy inline w wiadomości heartbeat działają jak zwykle (należy jednak unikać zmiany domyślnych ustawień sesji z heartbeatów).
- Dostarczanie heartbeatów domyślnie obejmuje tylko ładunek końcowy. Aby wysyłać także osobną wiadomość `Reasoning:` (jeśli dostępna), ustaw `agents.defaults.heartbeat.includeReasoning: true` lub per-agent `agents.list[].heartbeat.includeReasoning: true`.

## Interfejs czatu webowego

- Selektor poziomu myślenia w czacie webowym odzwierciedla poziom zapisany w magazynie sesji/konfiguracji przy ładowaniu strony.
- Wybranie innego poziomu dotyczy tylko następnej wiadomości (`thinkingOnce`); po wysłaniu selektor wraca do zapisanego poziomu sesji.
- Aby zmienić domyślny poziom sesji, wyślij dyrektywę `/think:<level>` (jak wcześniej); selektor odzwierciedli ją po kolejnym przeładowaniu.
