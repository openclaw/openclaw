---
summary: "Zachowanie i konfiguracja obsługi wiadomości grupowych WhatsApp (mentionPatterns są współdzielone między powierzchniami)"
read_when:
  - Zmiana reguł wiadomości grupowych lub wzmianek
title: "Wiadomości grupowe"
---

# Wiadomości grupowe (kanał WhatsApp Web)

Cel: pozwolić, aby Clawd był obecny w grupach WhatsApp, budził się tylko po wywołaniu i utrzymywał ten wątek oddzielnie od osobistej sesji DM.

Uwaga: `agents.list[].groupChat.mentionPatterns` jest teraz używane także przez Telegram/Discord/Slack/iMessage; ten dokument koncentruje się na zachowaniu specyficznym dla WhatsApp. W konfiguracjach wieloagentowych ustaw `agents.list[].groupChat.mentionPatterns` na agenta (lub użyj `messages.groupChat.mentionPatterns` jako globalnego zapasowego).

## Co jest zaimplementowane (2025-12-03)

- Tryby aktywacji: `mention` (domyślny) lub `always`. `mention` wymaga pingnięcia (prawdziwe wzmianki WhatsApp @ poprzez `mentionedJids`, wzorce regex lub E.164 bota gdziekolwiek w tekście). `always` budzi agenta przy każdej wiadomości, ale powinien on odpowiadać tylko wtedy, gdy może wnieść istotną wartość; w przeciwnym razie zwraca cichy token `NO_REPLY`. Ustawienia domyślne można określić w konfiguracji (`channels.whatsapp.groups`) i nadpisać per grupa poprzez `/activation`. Gdy ustawione jest `channels.whatsapp.groups`, działa to także jako lista dozwolonych grup (dodaj `"*"`, aby zezwolić na wszystkie).
- Polityka grup: `channels.whatsapp.groupPolicy` kontroluje, czy wiadomości grupowe są akceptowane (`open|disabled|allowlist`). `allowlist` używa `channels.whatsapp.groupAllowFrom` (zapasowo: jawne `channels.whatsapp.allowFrom`). Domyślnie obowiązuje `allowlist` (zablokowane do czasu dodania nadawców).
- Sesje per grupa: klucze sesji mają postać `agent:<agentId>:whatsapp:group:<jid>`, więc polecenia takie jak `/verbose on` lub `/think high` (wysyłane jako samodzielne wiadomości) są ograniczone do danej grupy; osobisty stan DM pozostaje nienaruszony. Sygnały heartbeat są pomijane dla wątków grupowych.
- Wstrzykiwanie kontekstu: **tylko oczekujące** wiadomości grupowe (domyślnie 50), które _nie_ uruchomiły wykonania, są poprzedzane pod `[Chat messages since your last reply - for context]`, a linia wyzwalająca znajduje się pod `[Current message - respond to this]`. Wiadomości już obecne w sesji nie są wstrzykiwane ponownie.
- Ujawnianie nadawcy: każda partia grupowa kończy się teraz `[from: Sender Name (+E164)]`, aby Pi wiedział, kto mówi.
- Efemeral/view-jeden: odpakowujemy je przed ekstrakcją tekstu/wzmianek, więc pingi w nich nadal wyzwalają.
- Systemowy prompt grupy: przy pierwszej turze sesji grupowej (oraz zawsze, gdy `/activation` zmienia tryb) wstrzykujemy krótki opis do promptu systemowego, np. `You are replying inside the WhatsApp group "<subject>". Group members: Alice (+44...), Bob (+43...), … Activation: trigger-only … Address the specific sender noted in the message context.`. Jeśli metadane nie są dostępne, nadal informujemy agenta, że to czat grupowy.

## Przykład konfiguracji (WhatsApp)

Dodaj blok `groupChat` do `~/.openclaw/openclaw.json`, aby pingnięcia po nazwie wyświetlanej działały nawet wtedy, gdy WhatsApp usuwa wizualne `@` z treści tekstu:

```json5
{
  channels: {
    whatsapp: {
      groups: {
        "*": { requireMention: true },
      },
    },
  },
  agents: {
    list: [
      {
        id: "main",
        groupChat: {
          historyLimit: 50,
          mentionPatterns: ["@?openclaw", "\\+?15555550123"],
        },
      },
    ],
  },
}
```

Uwagi:

- Wyrażenia regex nie rozróżniają wielkości liter; obejmują ping po nazwie wyświetlanej, np. `@openclaw`, oraz surowy numer z `+` lub bez, ze spacjami lub bez.
- WhatsApp nadal wysyła kanoniczne wzmianki poprzez `mentionedJids`, gdy ktoś stuknie kontakt, więc zapasowy wariant z numerem jest rzadko potrzebny, ale stanowi użyteczną siatkę bezpieczeństwa.

### Polecenie aktywacji (tylko właściciel)

Użyj polecenia czatu grupowego:

- `/activation mention`
- `/activation always`

Tylko numer właściciela (z `channels.whatsapp.allowFrom` lub E.164 bota, gdy nieustawione) może to zmienić. Wyślij `/status` jako samodzielną wiadomość w grupie, aby zobaczyć bieżący tryb aktywacji.

## Jak używać

1. Dodaj swoje konto WhatsApp (to, na którym działa OpenClaw) do grupy.
2. Napisz `@openclaw …` (lub dołącz numer). Tylko nadawcy z listy dozwolonych mogą to wyzwolić, chyba że ustawisz `groupPolicy: "open"`.
3. Prompt agenta będzie zawierał ostatni kontekst grupowy oraz końcowy znacznik `[from: …]`, aby mógł zwrócić się do właściwej osoby.
4. Dyrektywy na poziomie sesji (`/verbose on`, `/think high`, `/new` lub `/reset`, `/compact`) obowiązują tylko dla sesji tej grupy; wysyłaj je jako samodzielne wiadomości, aby zostały zarejestrowane. Twoja osobista sesja DM pozostaje niezależna.

## Testowanie / weryfikacja

- Ręczne testy dymne:
  - Wyślij ping `@openclaw` w grupie i potwierdź odpowiedź, która odnosi się do nazwy nadawcy.
  - Wyślij drugi ping i sprawdź, czy blok historii jest dołączony, a następnie wyczyszczony w kolejnej turze.
- Sprawdź logi gateway (uruchom z `--verbose`), aby zobaczyć wpisy `inbound web message` pokazujące `from: <groupJid>` oraz sufiks `[from: …]`.

## Znane kwestie

- Sygnały heartbeat są celowo pomijane dla grup, aby uniknąć hałaśliwych rozgłoszeń.
- Tłumienie echa używa połączonego ciągu partii; jeśli wyślesz identyczny tekst dwukrotnie bez wzmianek, odpowiedź otrzyma tylko pierwszy.
- Wpisy w magazynie sesji będą widoczne jako `agent:<agentId>:whatsapp:group:<jid>` w magazynie sesji (domyślnie `~/.openclaw/agents/<agentId>/sessions/sessions.json`); brak wpisu oznacza jedynie, że grupa nie wyzwoliła jeszcze wykonania.
- Wskaźniki pisania w grupach stosują się do `agents.defaults.typingMode` (domyślnie: `message` bez wzmianki).
