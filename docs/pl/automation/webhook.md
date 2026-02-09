---
summary: "Webhooki przychodzące do wybudzania i izolowanych uruchomień agenta"
read_when:
  - Dodawanie lub zmiana punktów końcowych webhooków
  - Łączenie systemów zewnętrznych z OpenClaw
title: "Webhooki"
---

# Webhooki

Gateway może udostępniać niewielki punkt końcowy HTTP webhook do wyzwalaczy zewnętrznych.

## Włączanie

```json5
{
  hooks: {
    enabled: true,
    token: "shared-secret",
    path: "/hooks",
  },
}
```

Uwagi:

- `hooks.token` jest wymagane, gdy `hooks.enabled=true`.
- `hooks.path` domyślnie ma wartość `/hooks`.

## Uwierzytelnianie

Każde żądanie musi zawierać token hooka. Preferowane są nagłówki:

- `Authorization: Bearer <token>` (zalecane)
- `x-openclaw-token: <token>`
- `?token=<token>` (przestarzałe; zapisuje ostrzeżenie w logach i zostanie usunięte w przyszłym głównym wydaniu)

## Punkty końcowe

### `POST /hooks/wake`

Ładunek:

```json
{ "text": "System line", "mode": "now" }
```

- `text` **wymagane** (string): Opis zdarzenia (np. „Nowy e‑mail odebrany”).
- `mode` opcjonalne (`now` | `next-heartbeat`): Czy wyzwolić natychmiastowy heartbeat (domyślnie `now`) czy poczekać na kolejne okresowe sprawdzenie.

Efekt:

- Kolejkuje zdarzenie systemowe dla sesji **głównej**
- Jeśli `mode=now`, wyzwala natychmiastowy heartbeat

### `POST /hooks/agent`

Ładunek:

```json
{
  "message": "Run this",
  "name": "Email",
  "sessionKey": "hook:email:msg-123",
  "wakeMode": "now",
  "deliver": true,
  "channel": "last",
  "to": "+15551234567",
  "model": "openai/gpt-5.2-mini",
  "thinking": "low",
  "timeoutSeconds": 120
}
```

- `message` **wymagane** (string): Prompt lub wiadomość do przetworzenia przez agenta.
- `name` opcjonalne (string): Czytelna dla człowieka nazwa hooka (np. „GitHub”), używana jako prefiks w podsumowaniach sesji.
- `sessionKey` opcjonalne (string): Klucz używany do identyfikacji sesji agenta. Domyślnie losowy `hook:<uuid>`. Użycie spójnego klucza umożliwia wieloturową rozmowę w kontekście hooka.
- `wakeMode` opcjonalne (`now` | `next-heartbeat`): Czy wyzwolić natychmiastowy heartbeat (domyślnie `now`) czy poczekać na kolejne okresowe sprawdzenie.
- `deliver` opcjonalne (boolean): Jeśli `true`, odpowiedź agenta zostanie wysłana do kanału komunikacyjnego. Domyślnie `true`. Odpowiedzi będące wyłącznie potwierdzeniami heartbeat są automatycznie pomijane.
- `channel` opcjonalne (string): Kanał komunikacyjny do dostarczenia. Jeden z: `last`, `whatsapp`, `telegram`, `discord`, `slack`, `mattermost` (plugin), `signal`, `imessage`, `msteams`. Domyślnie `last`.
- `to` opcjonalne (string): Identyfikator odbiorcy dla kanału (np. numer telefonu dla WhatsApp/Signal, identyfikator czatu dla Telegram, identyfikator kanału dla Discord/Slack/Mattermost (plugin), identyfikator konwersacji dla MS Teams). Domyślnie ostatni odbiorca w sesji głównej.
- `model` opcjonalne (string): Nadpisanie modelu (np. `anthropic/claude-3-5-sonnet` lub alias). Musi znajdować się na liście dozwolonych modeli, jeśli obowiązują ograniczenia.
- `thinking` opcjonalne (string): Nadpisanie poziomu myślenia (np. `low`, `medium`, `high`).
- `timeoutSeconds` opcjonalne (number): Maksymalny czas trwania uruchomienia agenta w sekundach.

Efekt:

- Uruchamia **izolowaną** turę agenta (własny klucz sesji)
- Zawsze publikuje podsumowanie w sesji **głównej**
- Jeśli `wakeMode=now`, wyzwala natychmiastowy heartbeat

### `POST /hooks/<name>` (mapowane)

Niestandardowe nazwy hooków są rozwiązywane przez `hooks.mappings` (zob. konfigurację). Mapowanie może
zamienić dowolne ładunki na akcje `wake` lub `agent`, z opcjonalnymi szablonami lub
transformacjami kodu.

Opcje mapowania (podsumowanie):

- `hooks.presets: ["gmail"]` włącza wbudowane mapowanie Gmail.
- `hooks.mappings` pozwala zdefiniować `match`, `action` oraz szablony w konfiguracji.
- `hooks.transformsDir` + `transform.module` ładuje moduł JS/TS dla logiki niestandardowej.
- Użyj `match.source`, aby zachować generyczny punkt ingestu (routing sterowany ładunkiem).
- Transformacje TS wymagają loadera TS (np. `bun` lub `tsx`) albo wstępnie skompilowanego `.js` w czasie wykonania.
- Ustaw `deliver: true` + `channel`/`to` w mapowaniach, aby kierować odpowiedzi na powierzchnię czatu
  (`channel` domyślnie ma wartość `last` i w razie potrzeby przełącza się na WhatsApp).
- `allowUnsafeExternalContent: true` wyłącza zewnętrzną otoczkę bezpieczeństwa treści dla tego hooka
  (niebezpieczne; tylko dla zaufanych źródeł wewnętrznych).
- `openclaw webhooks gmail setup` zapisuje konfigurację `hooks.gmail` dla `openclaw webhooks gmail run`.
  Zobacz [Gmail Pub/Sub](/automation/gmail-pubsub) dla pełnego przepływu watch Gmail.

## Odpowiedzi

- `200` dla `/hooks/wake`
- `202` dla `/hooks/agent` (uruchomienie asynchroniczne rozpoczęte)
- `401` w przypadku niepowodzenia uwierzytelniania
- `400` w przypadku nieprawidłowego ładunku
- `413` w przypadku zbyt dużych ładunków

## Przykłady

```bash
curl -X POST http://127.0.0.1:18789/hooks/wake \
  -H 'Authorization: Bearer SECRET' \
  -H 'Content-Type: application/json' \
  -d '{"text":"New email received","mode":"now"}'
```

```bash
curl -X POST http://127.0.0.1:18789/hooks/agent \
  -H 'x-openclaw-token: SECRET' \
  -H 'Content-Type: application/json' \
  -d '{"message":"Summarize inbox","name":"Email","wakeMode":"next-heartbeat"}'
```

### Użycie innego modelu

Dodaj `model` do ładunku agenta (lub mapowania), aby nadpisać model dla tego uruchomienia:

```bash
curl -X POST http://127.0.0.1:18789/hooks/agent \
  -H 'x-openclaw-token: SECRET' \
  -H 'Content-Type: application/json' \
  -d '{"message":"Summarize inbox","name":"Email","model":"openai/gpt-5.2-mini"}'
```

Jeśli wymuszasz `agents.defaults.models`, upewnij się, że model nadpisania jest na niej uwzględniony.

```bash
curl -X POST http://127.0.0.1:18789/hooks/gmail \
  -H 'Authorization: Bearer SECRET' \
  -H 'Content-Type: application/json' \
  -d '{"source":"gmail","messages":[{"from":"Ada","subject":"Hello","snippet":"Hi"}]}'
```

## Bezpieczeństwo

- Trzymaj punkty końcowe hooków za loopback, w tailnecie lub za zaufanym reverse proxy.
- Używaj dedykowanego tokenu hooka; nie używaj ponownie tokenów uwierzytelniania gateway.
- Unikaj umieszczania w logach webhooków wrażliwych surowych ładunków.
- Ładunki hooków są domyślnie traktowane jako niezaufane i opakowywane granicami bezpieczeństwa.
  Jeśli musisz wyłączyć to dla konkretnego hooka, ustaw `allowUnsafeExternalContent: true`
  w mapowaniu tego hooka (niebezpieczne).
