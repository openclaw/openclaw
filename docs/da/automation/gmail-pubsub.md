---
summary: "Gmail Pub/Sub-push koblet til OpenClaw-webhooks via gogcli"
read_when:
  - Kobling af Gmail-indbakke-triggere til OpenClaw
  - Opsætning af Pub/Sub-push til agent-opvågning
title: "Gmail PubSub"
---

# Gmail Pub/Sub -> OpenClaw

Mål: Gmail watch -> Pub/Sub push -> `gog gmail watch serve` -> OpenClaw webhook.

## Forudsætninger

- `gcloud` installeret og logget ind ([installationsguide](https://docs.cloud.google.com/sdk/docs/install-sdk)).
- `gog` (gogcli) installeret og autoriseret til Gmail-kontoen ([gogcli.sh](https://gogcli.sh/)).
- OpenClaw-hooks aktiveret (se [Webhooks](/automation/webhook)).
- `tailscale` logget ind ([tailscale.com](https://tailscale.com/)). Understøttet opsætning bruger Tailscale Tragt til det offentlige HTTPS endepunkt.
  Andre tunneltjenester kan fungere, men er DIY/uunderstøttet og kræver manuel ledning.
  Lige nu, Tailscale er, hvad vi støtter.

Eksempel på hook-konfiguration (aktivér Gmail-preset-mapping):

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

For at levere Gmail-oversigten til en chat-overflade kan du tilsidesætte preset’et med en mapping,
der sætter `deliver` + valgfrit `channel`/`to`:

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

Hvis du ønsker en fast kanal, sæt `kanal` + `til`. Ellers `kanal: "last"`
bruger den sidste leverings rute (falder tilbage til WhatsApp).

For at tvinge en billigere model til Gmail kører, indstil `model` i mapping
(`udbyder/model` eller alias). Hvis du håndhæver `agents.defaults.models`, omfatter det der.

For at sætte en standardmodel og tænkeniveau specifikt for Gmail-hooks, tilføj
`hooks.gmail.model` / `hooks.gmail.thinking` i din konfiguration:

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

Noter:

- Per-hook `model`/`thinking` i mappingen tilsidesætter stadig disse standarder.
- Fallback-rækkefølge: `hooks.gmail.model` → `agents.defaults.model.fallbacks` → primær (auth/rate-limit/timeouts).
- Hvis `agents.defaults.models` er sat, skal Gmail-modellen være på tilladelseslisten.
- Gmail hook indhold er indpakket med eksternt indhold sikkerhed grænser som standard.
  For at deaktivere (farligt), angiv `hooks.gmail.allowUnsafeExternalContent: true`.

For yderligere tilpasning af payload-håndtering kan du tilføje `hooks.mappings` eller et JS/TS-transformmodul
under `hooks.transformsDir` (se [Webhooks](/automation/webhook)).

## Opsætningsguide (anbefalet)

Brug OpenClaw-hjælperen til at koble det hele sammen (installerer afhængigheder på macOS via brew):

```bash
openclaw webhooks gmail setup \
  --account openclaw@gmail.com
```

Standarder:

- Bruger Tailscale Funnel til det offentlige push-endpoint.
- Skriver `hooks.gmail`-konfiguration for `openclaw webhooks gmail run`.
- Aktiverer Gmail-hook-preset (`hooks.presets: ["gmail"]`).

Sti note: når `tailscale.mode` er aktiveret, sætter OpenClaw automatisk
`hooks.gmail.serve.path` til `/` og holder den offentlige sti på
`hooks. mail.tailscale.path` (standard `/gmail-pubsub`) fordi Tailscale
striber set-path præfiks før proxying.
Hvis du har brug for backend til at modtage den præfikserede sti, sæt
`hooks.gmail.tailscale.target` (eller `--tailscale-target`) til en fuld URL som
`http://127.0.0.1:8788/gmail-pubsub` og match `hooks.gmail.serve.path`.

Vil du have et brugerdefineret slutpunkt? Brug `--push-endpoint <url>` eller `--tailscale off`.

Platform-note: på macOS installerer opsætningsguiden `gcloud`, `gogcli` og `tailscale`
via Homebrew; på Linux skal du installere dem manuelt først.

Gateway auto-start (anbefalet):

- Når `hooks.enabled=true` og `hooks.gmail.account` er sat, starter Gateway
  `gog gmail watch serve` ved boot og fornyer automatisk watch’en.
- Sæt `OPENCLAW_SKIP_GMAIL_WATCHER=1` for at fravælge (nyttigt hvis du selv kører daemonen).
- Kør ikke den manuelle daemon samtidig, ellers rammer du
  `listen tcp 127.0.0.1:8788: bind: address already in use`.

Manuel daemon (starter `gog gmail watch serve` + auto-fornyelse):

```bash
openclaw webhooks gmail run
```

## Engangsopsætning

1. Vælg GCP-projektet **der ejer OAuth-klienten** brugt af `gog`.

```bash
gcloud auth login
gcloud config set project <project-id>
```

Bemærk: Gmail watch kræver, at Pub/Sub-topic’et ligger i samme projekt som OAuth-klienten.

2. Aktivér API’er:

```bash
gcloud services enable gmail.googleapis.com pubsub.googleapis.com
```

3. Opret et topic:

```bash
gcloud pubsub topics create gog-gmail-watch
```

4. Tillad Gmail-push at publicere:

```bash
gcloud pubsub topics add-iam-policy-binding gog-gmail-watch \
  --member=serviceAccount:gmail-api-push@system.gserviceaccount.com \
  --role=roles/pubsub.publisher
```

## Start watch’en

```bash
gog gmail watch start \
  --account openclaw@gmail.com \
  --label INBOX \
  --topic projects/<project-id>/topics/gog-gmail-watch
```

Gem `history_id` fra outputtet (til fejlfinding).

## Kør push-handleren

Lokalt eksempel (shared token-auth):

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

Noter:

- `--token` beskytter push-endpoint’et (`x-gog-token` eller `?token=`).
- `--hook-url` peger på OpenClaw `/hooks/gmail` (mappet; isoleret kørsel + oversigt til main).
- `--include-body` og `--max-bytes` styrer body-udsnittet, der sendes til OpenClaw.

Anbefalet: `openclaw webhooks gmail run` indpakker samme flow og fornyer automatisk watch’en.

## Eksponér handleren (avanceret, ikke understøttet)

Hvis du har brug for en ikke-Tailscale-tunnel, så kobl den manuelt og brug den offentlige URL i push-
abonnementet (ikke understøttet, ingen sikkerhedsforanstaltninger):

```bash
cloudflared tunnel --url http://127.0.0.1:8788 --no-autoupdate
```

Brug den genererede URL som push-endpoint:

```bash
gcloud pubsub subscriptions create gog-gmail-watch-push \
  --topic gog-gmail-watch \
  --push-endpoint "https://<public-url>/gmail-pubsub?token=<shared>"
```

Produktion: brug et stabilt HTTPS-endpoint og konfigurér Pub/Sub OIDC JWT, og kør derefter:

```bash
gog gmail watch serve --verify-oidc --oidc-email <svc@...>
```

## Test

Send en besked til den overvågede indbakke:

```bash
gog gmail send \
  --account openclaw@gmail.com \
  --to openclaw@gmail.com \
  --subject "watch test" \
  --body "ping"
```

Tjek watch-status og historik:

```bash
gog gmail watch status --account openclaw@gmail.com
gog gmail history --account openclaw@gmail.com --since <historyId>
```

## Fejlfinding

- `Invalid topicName`: projekt-mismatch (topic’et er ikke i OAuth-klientens projekt).
- `User not authorized`: mangler `roles/pubsub.publisher` på topic’et.
- Tomme beskeder: Gmail-push leverer kun `historyId`; hent via `gog gmail history`.

## Oprydning

```bash
gog gmail watch stop --account openclaw@gmail.com
gcloud pubsub subscriptions delete gog-gmail-watch-push
gcloud pubsub topics delete gog-gmail-watch
```
