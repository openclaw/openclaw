---
summary: "Gmail Pub/Sub-push kopplad till OpenClaw-webhooks via gogcli"
read_when:
  - Koppla Gmail-inkorgstriggers till OpenClaw
  - Konfigurera Pub/Sub-push för agentväckning
title: "Gmail PubSub"
---

# Gmail Pub/Sub -> OpenClaw

Mål: Gmail watch -> Pub/Sub push -> `gog gmail watch serve` -> OpenClaw-webhook.

## Förutsättningar

- `gcloud` installerat och inloggat ([installationsguide](https://docs.cloud.google.com/sdk/docs/install-sdk)).
- `gog` (gogcli) installerat och auktoriserat för Gmail-kontot ([gogcli.sh](https://gogcli.sh/)).
- OpenClaw-hooks aktiverade (se [Webhooks](/automation/webhook)).
- `tailscale` inloggad ([tailscale.com](https://tailscale.com/)). Konfigurationen som stöds använder Tailscale Funnel för den offentliga HTTPS-slutpunkten.
  Andra tunneltjänster kan fungera, men är DIY/ej stödda och kräver manuell ledning.
  Just nu är Tailscale vad vi stöder.

Exempel på hook-konfig (aktivera Gmail-förinställd mappning):

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

För att leverera Gmail-sammanfattningen till en chattkanal, åsidosätt förinställningen med en mappning
som sätter `deliver` + valfri `channel`/`to`:

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

Om du vill ha en fast kanal, sätt `channel` + `to`. Annars `channel: "last"`
använder den senaste leveransvägen (faller tillbaka till WhatsApp).

För att tvinga fram en billigare modell för Gmail-körningar, sätt `model` i kartläggningen
(`provider/model` eller alias). Om du genomdriver `agents.defaults.models`, inkludera den där.

För att sätta en standardmodell och tänkenivå specifikt för Gmail-hooks, lägg till
`hooks.gmail.model` / `hooks.gmail.thinking` i din konfig:

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

Noteringar:

- Per-hook `model`/`thinking` i mappningen åsidosätter fortfarande dessa standarder.
- Reservordning: `hooks.gmail.model` → `agents.defaults.model.fallbacks` → primär (auth/rate-limit/timeouts).
- Om `agents.defaults.models` är satt måste Gmail-modellen finnas i tillåtelselistan.
- Gmail-hook innehåll är insvept med externa säkerhetsgränser för innehåll som standard.
  För att inaktivera (farlig), sätt `hooks.gmail.allowUnsafeExternalInnehåll: true`.

För att anpassa payload-hanteringen ytterligare, lägg till `hooks.mappings` eller en JS/TS-transformmodul
under `hooks.transformsDir` (se [Webhooks](/automation/webhook)).

## Guide (rekommenderas)

Använd OpenClaw-hjälparen för att koppla ihop allt (installerar beroenden på macOS via brew):

```bash
openclaw webhooks gmail setup \
  --account openclaw@gmail.com
```

Standarder:

- Använder Tailscale Funnel för den publika push-slutpunkten.
- Skriver `hooks.gmail`-konfig för `openclaw webhooks gmail run`.
- Aktiverar Gmail-hook-förinställningen (`hooks.presets: ["gmail"]`).

Sökvägskommentaren: när `tailscale.mode` är aktiverat, sätter OpenClaw automatiskt
`hooks.gmail.serve.path` till `/` och behåller den offentliga sökvägen på
`hooks. mail.tailscale.path` (standard `/gmail-pubsub`) eftersom Tailscale
tar bort set-path-prefixet innan proxying.
Om du behöver backend för att få den prefixerade sökvägen anger du
`hooks.gmail.tailscale.target` (eller `--tailscale-target`) till en fullständig URL som
`http://127.0.0.1:8788/gmail-pubsub` och matchar `hooks.gmail.serve.path`.

Vill du ha en anpassad slutpunkt? Använd `--push-endpoint <url>` eller` --tailscale off`.

Plattformsnotis: på macOS installerar guiden `gcloud`, `gogcli` och `tailscale`
via Homebrew; på Linux installerar du dem manuellt först.

Gateway auto-start (rekommenderas):

- När `hooks.enabled=true` och `hooks.gmail.account` är satt startar Gateway
  `gog gmail watch serve` vid uppstart och förnyar watch automatiskt.
- Sätt `OPENCLAW_SKIP_GMAIL_WATCHER=1` för att välja bort (användbart om du kör daemonen själv).
- Kör inte den manuella daemonen samtidigt, annars får du
  `listen tcp 127.0.0.1:8788: bind: address already in use`.

Manuell daemon (startar `gog gmail watch serve` + auto-förnyelse):

```bash
openclaw webhooks gmail run
```

## Engångsinställning

1. Välj GCP-projektet **som äger OAuth-klienten** som används av `gog`.

```bash
gcloud auth login
gcloud config set project <project-id>
```

Obs: Gmail watch kräver att Pub/Sub-ämnet finns i samma projekt som OAuth-klienten.

2. Aktivera API:er:

```bash
gcloud services enable gmail.googleapis.com pubsub.googleapis.com
```

3. Skapa ett ämne:

```bash
gcloud pubsub topics create gog-gmail-watch
```

4. Tillåt att Gmail-push publicerar:

```bash
gcloud pubsub topics add-iam-policy-binding gog-gmail-watch \
  --member=serviceAccount:gmail-api-push@system.gserviceaccount.com \
  --role=roles/pubsub.publisher
```

## Starta watch

```bash
gog gmail watch start \
  --account openclaw@gmail.com \
  --label INBOX \
  --topic projects/<project-id>/topics/gog-gmail-watch
```

Spara `history_id` från utdata (för felsökning).

## Kör push-hanteraren

Lokalt exempel (delad token-auth):

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

Noteringar:

- `--token` skyddar push-slutpunkten (`x-gog-token` eller `?token=`).
- `--hook-url` pekar på OpenClaw `/hooks/gmail` (mappad; isolerad körning + sammanfattning till huvud).
- `--include-body` och `--max-bytes` styr body-snippet som skickas till OpenClaw.

Rekommenderat: `openclaw webhooks gmail run` omsluter samma flöde och förnyar watch automatiskt.

## Exponera hanteraren (avancerat, ej stödd)

Om du behöver en icke-Tailscale-tunnel, koppla den manuellt och använd den publika URL:en i push-
prenumerationen (ej stödd, inga skyddsräcken):

```bash
cloudflared tunnel --url http://127.0.0.1:8788 --no-autoupdate
```

Använd den genererade URL:en som push-slutpunkt:

```bash
gcloud pubsub subscriptions create gog-gmail-watch-push \
  --topic gog-gmail-watch \
  --push-endpoint "https://<public-url>/gmail-pubsub?token=<shared>"
```

Produktion: använd en stabil HTTPS-slutpunkt och konfigurera Pub/Sub OIDC JWT, kör sedan:

```bash
gog gmail watch serve --verify-oidc --oidc-email <svc@...>
```

## Test

Skicka ett meddelande till den bevakade inkorgen:

```bash
gog gmail send \
  --account openclaw@gmail.com \
  --to openclaw@gmail.com \
  --subject "watch test" \
  --body "ping"
```

Kontrollera watch-status och historik:

```bash
gog gmail watch status --account openclaw@gmail.com
gog gmail history --account openclaw@gmail.com --since <historyId>
```

## Felsökning

- `Invalid topicName`: projektmatchningsfel (ämnet finns inte i OAuth-klientens projekt).
- `User not authorized`: saknar `roles/pubsub.publisher` på ämnet.
- Tomma meddelanden: Gmail-push tillhandahåller bara `historyId`; hämta via `gog gmail history`.

## Rensa upp

```bash
gog gmail watch stop --account openclaw@gmail.com
gcloud pubsub subscriptions delete gog-gmail-watch-push
gcloud pubsub topics delete gog-gmail-watch
```
