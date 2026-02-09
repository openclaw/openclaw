---
summary: "Wiadomości odpytywania heartbeat oraz reguły powiadomień"
read_when:
  - Dostosowywanie częstotliwości heartbeat lub komunikatów
  - Wybór między heartbeat a cronem dla zadań zaplanowanych
title: "Heartbeat"
---

# Heartbeat (Gateway)

> **Heartbeat czy Cron?** Zobacz [Cron vs Heartbeat](/automation/cron-vs-heartbeat), aby uzyskać wskazówki, kiedy używać każdego z nich.

Heartbeat uruchamia **okresowe tury agenta** w głównej sesji, aby model mógł
wyłapywać wszystko, co wymaga uwagi, bez spamowania Cię.

Rozwiązywanie problemów: [/automation/troubleshooting](/automation/troubleshooting)

## Szybki start (dla początkujących)

1. Pozostaw heartbeat włączony (domyślnie `30m` lub `1h` dla Anthropic OAuth/setup-token) albo ustaw własną częstotliwość.
2. Utwórz krótką listę kontrolną `HEARTBEAT.md` w obszarze roboczym agenta (opcjonalne, ale zalecane).
3. Zdecyduj, gdzie mają trafiać komunikaty heartbeat (`target: "last"` jest domyślne).
4. Opcjonalnie: włącz dostarczanie rozumowania heartbeat dla przejrzystości.
5. Opcjonalnie: ogranicz heartbeat do aktywnych godzin (czas lokalny).

Przykładowa konfiguracja:

```json5
{
  agents: {
    defaults: {
      heartbeat: {
        every: "30m",
        target: "last",
        // activeHours: { start: "08:00", end: "24:00" },
        // includeReasoning: true, // optional: send separate `Reasoning:` message too
      },
    },
  },
}
```

## Ustawienia domyślne

- Interwał: `30m` (lub `1h`, gdy wykrytym trybem uwierzytelniania jest Anthropic OAuth/setup-token). Ustaw `agents.defaults.heartbeat.every` lub per‑agent `agents.list[].heartbeat.every`; użyj `0m`, aby wyłączyć.
- Treść promptu (konfigurowalna przez `agents.defaults.heartbeat.prompt`):
  `Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.`
- Prompt heartbeat jest wysyłany **dosłownie** jako wiadomość użytkownika. Prompt systemowy
  zawiera sekcję „Heartbeat”, a uruchomienie jest oznaczane wewnętrznie.
- Aktywne godziny (`heartbeat.activeHours`) są sprawdzane w skonfigurowanej strefie czasowej.
  Poza oknem heartbeat jest pomijany do następnego tyknięcia w obrębie okna.

## Do czego służy prompt heartbeat

Domyślny prompt jest celowo szeroki:

- **Zadania w tle**: „Consider outstanding tasks” skłania agenta do przeglądu
  działań następczych (skrzynka odbiorcza, kalendarz, przypomnienia, kolejka pracy)
  i wyłonienia pilnych spraw.
- **Kontakt z człowiekiem**: „Checkup sometimes on your human during day time” zachęca do
  okazjonalnej, lekkiej wiadomości „czy czegoś potrzebujesz?”, jednocześnie unikając
  nocnego spamu dzięki użyciu skonfigurowanej lokalnej strefy czasowej
  (zob. [/concepts/timezone](/concepts/timezone)).

Jeśli chcesz, aby heartbeat robił coś bardzo konkretnego (np. „check Gmail PubSub
stats” lub „verify gateway health”), ustaw `agents.defaults.heartbeat.prompt` (lub
`agents.list[].heartbeat.prompt`) na własną treść (wysyłaną dosłownie).

## Kontrakt odpowiedzi

- Jeśli nic nie wymaga uwagi, odpowiedz **`HEARTBEAT_OK`**.
- Podczas uruchomień heartbeat OpenClaw traktuje `HEARTBEAT_OK` jako potwierdzenie,
  gdy pojawia się na **początku lub końcu** odpowiedzi. Token jest usuwany, a odpowiedź
  odrzucana, jeśli pozostała treść ma **≤ `ackMaxChars`** (domyślnie: 300).
- Jeśli `HEARTBEAT_OK` pojawi się **w środku** odpowiedzi, nie jest traktowany
  w szczególny sposób.
- W przypadku alertów **nie** dołączaj `HEARTBEAT_OK`; zwróć wyłącznie treść alertu.

Poza heartbeatami, przypadkowy `HEARTBEAT_OK` na początku/końcu wiadomości jest usuwany
i logowany; wiadomość, która składa się wyłącznie z `HEARTBEAT_OK`, jest odrzucana.

## Konfiguracja

```json5
{
  agents: {
    defaults: {
      heartbeat: {
        every: "30m", // default: 30m (0m disables)
        model: "anthropic/claude-opus-4-6",
        includeReasoning: false, // default: false (deliver separate Reasoning: message when available)
        target: "last", // last | none | <channel id> (core or plugin, e.g. "bluebubbles")
        to: "+15551234567", // optional channel-specific override
        accountId: "ops-bot", // optional multi-account channel id
        prompt: "Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.",
        ackMaxChars: 300, // max chars allowed after HEARTBEAT_OK
      },
    },
  },
}
```

### Zakres i pierwszeństwo

- `agents.defaults.heartbeat` ustawia globalne zachowanie heartbeat.
- `agents.list[].heartbeat` nadpisuje/scala się na wierzchu; jeśli którykolwiek agent ma blok `heartbeat`,
  heartbeat uruchamiają **tylko te agenty**.
- `channels.defaults.heartbeat` ustawia domyślną widoczność dla wszystkich kanałów.
- `channels.<channel>.heartbeat` nadpisuje domyślne ustawienia kanałów.
- `channels.<channel>.accounts.<id>.heartbeat` (kanały wielokontowe) nadpisuje ustawienia per‑kanał.

### Heartbeat per‑agent

Jeśli którykolwiek wpis `agents.list[]` zawiera blok `heartbeat`, heartbeat
uruchamiają **tylko te agenty**. Blok per‑agent scala się na wierzchu `agents.defaults.heartbeat`
(dzięki czemu możesz ustawić wspólne domyślne wartości raz i nadpisywać je per agent).

Przykład: dwóch agentów, heartbeat uruchamia tylko drugi agent.

```json5
{
  agents: {
    defaults: {
      heartbeat: {
        every: "30m",
        target: "last",
      },
    },
    list: [
      { id: "main", default: true },
      {
        id: "ops",
        heartbeat: {
          every: "1h",
          target: "whatsapp",
          to: "+15551234567",
          prompt: "Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.",
        },
      },
    ],
  },
}
```

### Przykład aktywnych godzin

Ogranicz heartbeat do godzin pracy w konkretnej strefie czasowej:

```json5
{
  agents: {
    defaults: {
      heartbeat: {
        every: "30m",
        target: "last",
        activeHours: {
          start: "09:00",
          end: "22:00",
          timezone: "America/New_York", // optional; uses your userTimezone if set, otherwise host tz
        },
      },
    },
  },
}
```

Poza tym oknem (przed 9:00 lub po 22:00 czasu wschodniego) heartbeat jest pomijany. Następne zaplanowane tyknięcie w obrębie okna wykona się normalnie.

### Przykład wielu kont

Użyj `accountId`, aby wskazać konkretne konto w kanałach wielokontowych, takich jak Telegram:

```json5
{
  agents: {
    list: [
      {
        id: "ops",
        heartbeat: {
          every: "1h",
          target: "telegram",
          to: "12345678",
          accountId: "ops-bot",
        },
      },
    ],
  },
  channels: {
    telegram: {
      accounts: {
        "ops-bot": { botToken: "YOUR_TELEGRAM_BOT_TOKEN" },
      },
    },
  },
}
```

### Uwagi do pól

- `every`: interwał heartbeat (łańcuch czasu trwania; domyślna jednostka = minuty).
- `model`: opcjonalne nadpisanie modelu dla uruchomień heartbeat (`provider/model`).
- `includeReasoning`: gdy włączone, dostarcza także osobną wiadomość `Reasoning:`, gdy jest dostępna
  (ten sam kształt co `/reasoning on`).
- `session`: opcjonalny klucz sesji dla uruchomień heartbeat.
  - `main` (domyślne): główna sesja agenta.
  - Jawny klucz sesji (skopiuj z `openclaw sessions --json` lub z [sessions CLI](/cli/sessions)).
  - Formaty klucza sesji: zob. [Sessions](/concepts/session) i [Groups](/channels/groups).
- `target`:
  - `last` (domyślne): dostarcz do ostatnio użytego kanału zewnętrznego.
  - jawny kanał: `whatsapp` / `telegram` / `discord` / `googlechat` / `slack` / `msteams` / `signal` / `imessage`.
  - `none`: uruchom heartbeat, ale **nie dostarczaj** na zewnątrz.
- `to`: opcjonalne nadpisanie odbiorcy (identyfikator specyficzny dla kanału, np. E.164 dla WhatsApp lub identyfikator czatu Telegram).
- `accountId`: opcjonalny identyfikator konta dla kanałów wielokontowych. Gdy `target: "last"`,
  identyfikator konta dotyczy rozwiązanego ostatniego kanału, jeśli obsługuje konta; w przeciwnym razie jest ignorowany. Jeśli identyfikator konta nie pasuje do skonfigurowanego konta dla rozwiązanego kanału, dostarczenie jest pomijane.
- `prompt`: nadpisuje domyślną treść promptu (nie jest scalane).
- `ackMaxChars`: maks. liczba znaków dozwolona po `HEARTBEAT_OK` przed dostarczeniem.
- `activeHours`: ogranicza uruchomienia heartbeat do okna czasowego. Obiekt z `start` (HH:MM, włącznie),
  `end` (HH:MM, wyłącznie; dozwolone `24:00` dla końca dnia) oraz opcjonalnie `timezone`.
  - Pominięte lub `"user"`: używa Twojej `agents.defaults.userTimezone`, jeśli ustawiona, w przeciwnym razie wraca do strefy czasowej systemu hosta.
  - `"local"`: zawsze używa strefy czasowej systemu hosta.
  - Dowolny identyfikator IANA (np. `America/New_York`): używany bezpośrednio; jeśli nieprawidłowy, wraca do zachowania `"user"` powyżej.
  - Poza aktywnym oknem heartbeat jest pomijany do następnego tyknięcia w obrębie okna.

## Zachowanie dostawy

- Heartbeat domyślnie uruchamia się w głównej sesji agenta (`agent:<id>:<mainKey>`),
  lub `global`, gdy `session.scope = "global"`. Ustaw `session`, aby nadpisać
  na konkretną sesję kanału (Discord/WhatsApp/etc.).
- `session` wpływa tylko na kontekst uruchomienia; dostarczanie kontrolują `target` i `to`.
- Aby dostarczyć do konkretnego kanału/odbiorcy, ustaw `target` + `to`. Z `target: "last"` dostarczanie używa ostatniego kanału zewnętrznego dla tej sesji.
- Jeśli główna kolejka jest zajęta, heartbeat jest pomijany i ponawiany później.
- Jeśli `target` rozwiąże się do braku celu zewnętrznego, uruchomienie nadal następuje,
  ale nie jest wysyłana żadna wiadomość wychodząca.
- Odpowiedzi wyłącznie heartbeat **nie** podtrzymują sesji; przywracany jest ostatni `updatedAt`,
  więc wygaszanie bezczynności działa normalnie.

## Kontrole widoczności

Domyślnie potwierdzenia `HEARTBEAT_OK` są tłumione, a treści alertów dostarczane. Możesz to dostosować per kanał lub per konto:

```yaml
channels:
  defaults:
    heartbeat:
      showOk: false # Hide HEARTBEAT_OK (default)
      showAlerts: true # Show alert messages (default)
      useIndicator: true # Emit indicator events (default)
  telegram:
    heartbeat:
      showOk: true # Show OK acknowledgments on Telegram
  whatsapp:
    accounts:
      work:
        heartbeat:
          showAlerts: false # Suppress alert delivery for this account
```

Pierwszeństwo: per‑konto → per‑kanał → domyślne kanału → domyślne wbudowane.

### Co robi każda flaga

- `showOk`: wysyła potwierdzenie `HEARTBEAT_OK`, gdy model zwraca odpowiedź tylko‑OK.
- `showAlerts`: wysyła treść alertu, gdy model zwraca odpowiedź inną niż OK.
- `useIndicator`: emituje zdarzenia wskaźników dla powierzchni statusu UI.

Jeśli **wszystkie trzy** są fałszywe, OpenClaw całkowicie pomija uruchomienie heartbeat
(brak wywołania modelu).

### Przykłady per‑kanał vs per‑konto

```yaml
channels:
  defaults:
    heartbeat:
      showOk: false
      showAlerts: true
      useIndicator: true
  slack:
    heartbeat:
      showOk: true # all Slack accounts
    accounts:
      ops:
        heartbeat:
          showAlerts: false # suppress alerts for the ops account only
  telegram:
    heartbeat:
      showOk: true
```

### Typowe wzorce

| Cel                                                                | Konfiguracja                                                                             |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| Zachowanie domyślne (ciche OK, alerty)          | _(brak konfiguracji)_                                                 |
| W pełni ciche (brak wiadomości, brak wskaźnika) | `channels.defaults.heartbeat: { showOk: false, showAlerts: false, useIndicator: false }` |
| Tylko wskaźnik (brak wiadomości)                | `channels.defaults.heartbeat: { showOk: false, showAlerts: false, useIndicator: true }`  |
| OK tylko w jednym kanale                                           | `channels.telegram.heartbeat: { showOk: true }`                                          |

## HEARTBEAT.md (opcjonalne)

Jeśli w obszarze roboczym istnieje plik `HEARTBEAT.md`, domyślny prompt instruuje
agenta, aby go odczytał. Traktuj to jako swoją „listę kontrolną heartbeat”:
małą, stabilną i bezpieczną do dołączania co 30 minut.

Jeśli `HEARTBEAT.md` istnieje, ale jest w praktyce puste (tylko puste linie i nagłówki
Markdown, takie jak `# Heading`), OpenClaw pomija uruchomienie heartbeat, aby oszczędzać wywołania API.
Jeśli plik nie istnieje, heartbeat nadal się uruchamia, a model decyduje, co zrobić.

Utrzymuj go bardzo małym (krótka lista kontrolna lub przypomnienia), aby uniknąć rozrostu promptu.

Przykład `HEARTBEAT.md`:

```md
# Heartbeat checklist

- Quick scan: anything urgent in inboxes?
- If it’s daytime, do a lightweight check-in if nothing else is pending.
- If a task is blocked, write down _what is missing_ and ask Peter next time.
```

### Czy agent może aktualizować HEARTBEAT.md?

Tak — jeśli go o to poprosisz.

`HEARTBEAT.md` to zwykły plik w obszarze roboczym agenta, więc możesz powiedzieć
agentowi (w normalnej rozmowie) coś w rodzaju:

- „Zaktualizuj `HEARTBEAT.md`, aby dodać codzienne sprawdzenie kalendarza.”
- „Przepisz `HEARTBEAT.md`, aby był krótszy i skupiony na działaniach następczych ze skrzynki.”

Jeśli chcesz, aby działo się to proaktywnie, możesz też dodać wyraźną linię w promptcie
heartbeat, np.: „Jeśli lista kontrolna stanie się nieaktualna, zaktualizuj HEARTBEAT.md
na lepszą.”

Uwaga dotycząca bezpieczeństwa: nie umieszczaj sekretów (kluczy API, numerów telefonów,
prywatnych tokenów) w `HEARTBEAT.md` — staje się częścią kontekstu promptu.

## Ręczne wybudzenie (na żądanie)

Możesz dodać zdarzenie systemowe do kolejki i natychmiast wyzwolić heartbeat za pomocą:

```bash
openclaw system event --text "Check for urgent follow-ups" --mode now
```

Jeśli wielu agentów ma skonfigurowane `heartbeat`, ręczne wybudzenie uruchamia
heartbeat każdego z tych agentów natychmiast.

Użyj `--mode next-heartbeat`, aby poczekać na następne zaplanowane tyknięcie.

## Dostarczanie rozumowania (opcjonalne)

Domyślnie heartbeat dostarcza tylko końcowy ładunek „odpowiedzi”.

Jeśli chcesz przejrzystości, włącz:

- `agents.defaults.heartbeat.includeReasoning: true`

Po włączeniu heartbeat dostarczy także osobną wiadomość z prefiksem
`Reasoning:` (ten sam kształt co `/reasoning on`). Może to być przydatne, gdy agent
zarządza wieloma sesjami/kodeksami i chcesz zobaczyć, dlaczego zdecydował się do Ciebie
odezwać — ale może też ujawnić więcej szczegółów wewnętrznych, niż chcesz. Preferuj
pozostawienie tej opcji wyłączonej w czatach grupowych.

## Świadomość kosztów

Heartbeat uruchamia pełne tury agenta. Krótsze interwały spalają więcej tokenów. Utrzymuj `HEARTBEAT.md` na niskim poziomie i rozważ tańszy `model` lub `target: "none"`,
jeśli chcesz wyłącznie wewnętrzne aktualizacje stanu.
