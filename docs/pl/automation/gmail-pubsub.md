---
summary: "Push Pub/Sub z Gmaila podłączony do webhooków OpenClaw za pomocą gogcli"
read_when:
  - Podłączanie wyzwalaczy skrzynki Gmail do OpenClaw
  - Konfiguracja push Pub/Sub do wybudzania agenta
title: "Gmail Pub/Sub"
---

# Gmail Pub/Sub -> OpenClaw

Cel: obserwacja Gmail → push Pub/Sub → `gog gmail watch serve` → webhook OpenClaw.

## Prereqs

- Zainstalowane i zalogowane `gcloud` ([instrukcja instalacji](https://docs.cloud.google.com/sdk/docs/install-sdk)).
- Zainstalowane i autoryzowane `gog` (gogcli) dla konta Gmail ([gogcli.sh](https://gogcli.sh/)).
- Włączone hooki OpenClaw (zobacz [Webhooks](/automation/webhook)).
- Zalogowane `tailscale` ([tailscale.com](https://tailscale.com/)). Wspierana konfiguracja używa Tailscale Funnel jako publicznego punktu końcowego HTTPS.
  Inne usługi tunelowania mogą działać, ale są DIY/nieobsługiwane i wymagają ręcznego okablowania.
  Obecnie wspieramy Tailscale.

Przykładowa konfiguracja hooka (włącz mapowanie presetu Gmail):

```json5
{
  hooks: {
    enabled: true,
    token: "OPENCLAW_HOOK_TOKEN",
    path: "/hooks",
    presets: ["gmail"],
  },
}
```

Aby dostarczyć podsumowanie Gmaila na powierzchnię czatu, nadpisz preset mapowaniem,
które ustawia `deliver` + opcjonalnie `channel`/`to`:

```json5
{
  hooks: {
    enabled: true,
    token: "OPENCLAW_HOOK_TOKEN",
    presets: ["gmail"],
    mappings: [
      {
        match: { path: "gmail" },
        action: "agent",
        wakeMode: "now",
        name: "Gmail",
        sessionKey: "hook:gmail:{{messages[0].id}}",
        messageTemplate: "New email from {{messages[0].from}}\nSubject: {{messages[0].subject}}\n{{messages[0].snippet}}\n{{messages[0].body}}",
        model: "openai/gpt-5.2-mini",
        deliver: true,
        channel: "last",
        // to: "+15551234567"
      },
    ],
  },
}
```

Jeśli chcesz stały kanał, ustaw `channel` + `to`. W przeciwnym razie `channel: "last"`
używa ostatniej trasy dostarczenia (z fallbackiem do WhatsApp).

Aby wymusić tańszy model dla uruchomień Gmail, ustaw `model` w mapowaniu
(`provider/model` lub alias). Jeśli wymuszasz `agents.defaults.models`, uwzględnij go tam.

Aby ustawić domyślny model i poziom „thinking” specyficznie dla hooków Gmail, dodaj
`hooks.gmail.model` / `hooks.gmail.thinking` w konfiguracji:

```json5
{
  hooks: {
    gmail: {
      model: "openrouter/meta-llama/llama-3.3-70b-instruct:free",
      thinking: "off",
    },
  },
}
```

Uwagi:

- Per-hook `model`/`thinking` w mapowaniu nadal nadpisuje te wartości domyślne.
- Kolejność fallbacku: `hooks.gmail.model` → `agents.defaults.model.fallbacks` → główny (uwierzytelnianie/limity/timeouty).
- Jeśli ustawiono `agents.defaults.models`, model Gmail musi znajdować się na liście dozwolonych.
- Zawartość hooka Gmail jest domyślnie opakowana granicami bezpieczeństwa treści zewnętrznych.
  Aby wyłączyć (niebezpieczne), ustaw `hooks.gmail.allowUnsafeExternalContent: true`.

Aby dalej dostosować obsługę payloadu, dodaj `hooks.mappings` lub moduł transformacji JS/TS
pod `hooks.transformsDir` (zobacz [Webhooks](/automation/webhook)).

## Kreator (zalecane)

Użyj pomocnika OpenClaw, aby połączyć wszystko razem (instaluje zależności na macOS przez brew):

```bash
openclaw webhooks gmail setup \
  --account openclaw@gmail.com
```

Domyślne ustawienia:

- Używa Tailscale Funnel jako publicznego punktu końcowego push.
- Zapisuje konfigurację `hooks.gmail` dla `openclaw webhooks gmail run`.
- Włącza preset hooka Gmail (`hooks.presets: ["gmail"]`).

Uwaga dotycząca ścieżki: gdy włączone jest `tailscale.mode`, OpenClaw automatycznie ustawia
`hooks.gmail.serve.path` na `/` i utrzymuje publiczną ścieżkę na
`hooks.gmail.tailscale.path` (domyślnie `/gmail-pubsub`), ponieważ Tailscale
usuwa prefiks set-path przed proxy.
Jeśli backend ma otrzymywać ścieżkę z prefiksem, ustaw
`hooks.gmail.tailscale.target` (lub `--tailscale-target`) na pełny URL, np. `http://127.0.0.1:8788/gmail-pubsub`, i dopasuj `hooks.gmail.serve.path`.

Chcesz niestandardowy punkt końcowy? Użyj `--push-endpoint <url>` lub `--tailscale off`.

Uwaga platformowa: na macOS kreator instaluje `gcloud`, `gogcli` i `tailscale`
przez Homebrew; na Linuxie zainstaluj je wcześniej ręcznie.

Automatyczny start Gateway (zalecane):

- Gdy ustawione są `hooks.enabled=true` i `hooks.gmail.account`, Gateway uruchamia
  `gog gmail watch serve` przy starcie i automatycznie odnawia watch.
- Ustaw `OPENCLAW_SKIP_GMAIL_WATCHER=1`, aby zrezygnować (przydatne, jeśli uruchamiasz demona samodzielnie).
- Nie uruchamiaj jednocześnie ręcznego demona, bo natrafisz na
  `listen tcp 127.0.0.1:8788: bind: address already in use`.

Ręczny demon (uruchamia `gog gmail watch serve` + auto-odnawianie):

```bash
openclaw webhooks gmail run
```

## Konfiguracja jednorazowa

1. Wybierz projekt GCP **będący właścicielem klienta OAuth** używanego przez `gog`.

```bash
gcloud auth login
gcloud config set project <project-id>
```

Uwaga: watch Gmail wymaga, aby temat Pub/Sub znajdował się w tym samym projekcie co klient OAuth.

2. Włącz API:

```bash
gcloud services enable gmail.googleapis.com pubsub.googleapis.com
```

3. Utwórz temat:

```bash
gcloud pubsub topics create gog-gmail-watch
```

4. Zezwól Gmail push na publikowanie:

```bash
gcloud pubsub topics add-iam-policy-binding gog-gmail-watch \
  --member=serviceAccount:gmail-api-push@system.gserviceaccount.com \
  --role=roles/pubsub.publisher
```

## Uruchom watch

```bash
gog gmail watch start \
  --account openclaw@gmail.com \
  --label INBOX \
  --topic projects/<project-id>/topics/gog-gmail-watch
```

Zapisz `history_id` z wyjścia (do debugowania).

## Uruchom handler push

Przykład lokalny (uwierzytelnianie tokenem współdzielonym):

```bash
gog gmail watch serve \
  --account openclaw@gmail.com \
  --bind 127.0.0.1 \
  --port 8788 \
  --path /gmail-pubsub \
  --token <shared> \
  --hook-url http://127.0.0.1:18789/hooks/gmail \
  --hook-token OPENCLAW_HOOK_TOKEN \
  --include-body \
  --max-bytes 20000
```

Uwagi:

- `--token` chroni punkt końcowy push (`x-gog-token` lub `?token=`).
- `--hook-url` wskazuje na OpenClaw `/hooks/gmail` (zmapowane; izolowane uruchomienie + podsumowanie do głównego).
- `--include-body` i `--max-bytes` kontrolują fragment treści wysyłany do OpenClaw.

Zalecane: `openclaw webhooks gmail run` opakowuje ten sam przepływ i automatycznie odnawia watch.

## Wystawienie handlera (zaawansowane, nieobsługiwane)

Jeśli potrzebujesz tunelu innego niż Tailscale, okabluj go ręcznie i użyj publicznego URL w subskrypcji push
(nieobsługiwane, bez zabezpieczeń):

```bash
cloudflared tunnel --url http://127.0.0.1:8788 --no-autoupdate
```

Użyj wygenerowanego URL jako punktu końcowego push:

```bash
gcloud pubsub subscriptions create gog-gmail-watch-push \
  --topic gog-gmail-watch \
  --push-endpoint "https://<public-url>/gmail-pubsub?token=<shared>"
```

Produkcja: użyj stabilnego punktu końcowego HTTPS i skonfiguruj Pub/Sub OIDC JWT, a następnie uruchom:

```bash
gog gmail watch serve --verify-oidc --oidc-email <svc@...>
```

## Test

Wyślij wiadomość do obserwowanej skrzynki:

```bash
gog gmail send \
  --account openclaw@gmail.com \
  --to openclaw@gmail.com \
  --subject "watch test" \
  --body "ping"
```

Sprawdź stan watch i historię:

```bash
gog gmail watch status --account openclaw@gmail.com
gog gmail history --account openclaw@gmail.com --since <historyId>
```

## Rozwiązywanie problemów

- `Invalid topicName`: niezgodność projektu (temat nie znajduje się w projekcie klienta OAuth).
- `User not authorized`: brak `roles/pubsub.publisher` na temacie.
- Puste wiadomości: push Gmail dostarcza tylko `historyId`; pobierz przez `gog gmail history`.

## Czyszczenie

```bash
gog gmail watch stop --account openclaw@gmail.com
gcloud pubsub subscriptions delete gog-gmail-watch-push
gcloud pubsub topics delete gog-gmail-watch
```
