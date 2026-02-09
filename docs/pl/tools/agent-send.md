---
summary: "Bezpośrednie uruchomienia CLI `openclaw agent` (z opcjonalnym dostarczaniem)"
read_when:
  - Dodawanie lub modyfikowanie punktu wejścia CLI agenta
title: "Wysyłanie agenta"
---

# `openclaw agent` (bezpośrednie uruchomienia agenta)

`openclaw agent` uruchamia pojedynczą turę agenta bez konieczności przychodzącej wiadomości czatu.
Domyślnie przechodzi **przez Gateway**; dodaj `--local`, aby wymusić osadzony
runtime na bieżącej maszynie.

## Zachowanie

- Wymagane: `--message <text>`
- Wybór sesji:
  - `--to <dest>` wyprowadza klucz sesji (cele grupy/kanału zachowują izolację; czaty bezpośrednie zapadają się do `main`), **lub**
  - `--session-id <id>` ponownie używa istniejącej sesji według identyfikatora, **lub**
  - `--agent <id>` kieruje bezpośrednio do skonfigurowanego agenta (używa klucza sesji `main` tego agenta)
- Uruchamia ten sam osadzony runtime agenta co zwykłe odpowiedzi przychodzące.
- Flagi myślenia/trybu gadatliwego są utrwalane w magazynie sesji.
- Wyjście:
  - domyślne: wypisuje tekst odpowiedzi (plus linie `MEDIA:<url>`)
  - `--json`: wypisuje ustrukturyzowany ładunek + metadane
- Opcjonalne dostarczenie z powrotem do kanału za pomocą `--deliver` + `--channel` (formaty celów zgodne z `openclaw message --target`).
- Użyj `--reply-channel`/`--reply-to`/`--reply-account`, aby nadpisać dostarczanie bez zmiany sesji.

Jeśli Gateway jest nieosiągalna, CLI **przełącza się** na lokalne uruchomienie osadzone.

## Przykłady

```bash
openclaw agent --to +15555550123 --message "status update"
openclaw agent --agent ops --message "Summarize logs"
openclaw agent --session-id 1234 --message "Summarize inbox" --thinking medium
openclaw agent --to +15555550123 --message "Trace logs" --verbose on --json
openclaw agent --to +15555550123 --message "Summon reply" --deliver
openclaw agent --agent ops --message "Generate report" --deliver --reply-channel slack --reply-to "#reports"
```

## Flagi

- `--local`: uruchom lokalnie (wymaga kluczy API dostawcy modelu w powłoce)
- `--deliver`: wyślij odpowiedź do wybranego kanału
- `--channel`: kanał dostarczania (`whatsapp|telegram|discord|googlechat|slack|signal|imessage`, domyślnie: `whatsapp`)
- `--reply-to`: nadpisanie celu dostarczania
- `--reply-channel`: nadpisanie kanału dostarczania
- `--reply-account`: nadpisanie identyfikatora konta dostarczania
- `--thinking <off|minimal|low|medium|high|xhigh>`: utrwal poziom myślenia (tylko modele GPT-5.2 + Codex)
- `--verbose <on|full|off>`: utrwal poziom trybu gadatliwego
- `--timeout <seconds>`: nadpisanie limitu czasu agenta
- `--json`: wyjście w ustrukturyzowanym JSON
