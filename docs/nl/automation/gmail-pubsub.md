---
summary: "Gmail Pub/Sub-push gekoppeld aan OpenClaw-webhooks via gogcli"
read_when:
  - Gmail-inboxtriggers koppelen aan OpenClaw
  - Pub/Sub-push instellen voor het wekken van agents
title: "Gmail PubSub"
---

# Gmail Pub/Sub -> OpenClaw

Doel: Gmail-watch -> Pub/Sub-push -> `gog gmail watch serve` -> OpenClaw-webhook.

## Prereqs

- `gcloud` geïnstalleerd en aangemeld ([installatiehandleiding](https://docs.cloud.google.com/sdk/docs/install-sdk)).
- `gog` (gogcli) geïnstalleerd en geautoriseerd voor het Gmail-account ([gogcli.sh](https://gogcli.sh/)).
- OpenClaw-hooks ingeschakeld (zie [Webhooks](/automation/webhook)).
- `tailscale` aangemeld ([tailscale.com](https://tailscale.com/)). De ondersteunde installatie gebruikt Tailscale Funnel voor het publieke HTTPS-eindpunt.
  Andere tunneldiensten kunnen werken, maar zijn DIY/niet-ondersteund en vereisen handmatige bedrading.
  Op dit moment ondersteunen we Tailscale.

Voorbeeld hook-config (Gmail-presetmapping inschakelen):

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

Om de Gmail-samenvatting naar een chatoppervlak te sturen, overschrijf de preset met een mapping
die `deliver` + optioneel `channel`/`to` instelt:

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

Als je een vast kanaal wilt, stel `channel` + `to` in. Anders gebruikt `channel: "last"`
de laatste afleverroute (valt terug op WhatsApp).

Om een goedkoper model af te dwingen voor Gmail-runs, stel `model` in de mapping in
(`provider/model` of alias). Als je `agents.defaults.models` afdwingt, neem dit daar op.

Om een standaardmodel en denkniveau specifiek voor Gmail-hooks in te stellen, voeg
`hooks.gmail.model` / `hooks.gmail.thinking` toe aan je config:

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

Notities:

- Per-hook `model`/`thinking` in de mapping overschrijft deze standaardwaarden nog steeds.
- Terugvalvolgorde: `hooks.gmail.model` → `agents.defaults.model.fallbacks` → primair (auth/rate-limit/time-outs).
- Als `agents.defaults.models` is ingesteld, moet het Gmail-model in de toegestane lijst staan.
- Inhoud van de Gmail-hook wordt standaard omwikkeld met veiligheidsgrenzen voor externe inhoud.
  Om dit uit te schakelen (gevaarlijk), stel `hooks.gmail.allowUnsafeExternalContent: true` in.

Om de afhandeling van de payload verder aan te passen, voeg `hooks.mappings` toe of een JS/TS-transformatiemodule
onder `hooks.transformsDir` (zie [Webhooks](/automation/webhook)).

## Wizard (aanbevolen)

Gebruik de OpenClaw-helper om alles te verbinden (installeert afhankelijkheden op macOS via brew):

```bash
openclaw webhooks gmail setup \
  --account openclaw@gmail.com
```

Standaardwaarden:

- Gebruikt Tailscale Funnel voor het publieke push-eindpunt.
- Schrijft `hooks.gmail`-config voor `openclaw webhooks gmail run`.
- Schakelt de Gmail-hook-preset in (`hooks.presets: ["gmail"]`).

Padnotitie: wanneer `tailscale.mode` is ingeschakeld, stelt OpenClaw automatisch
`hooks.gmail.serve.path` in op `/` en houdt het publieke pad op
`hooks.gmail.tailscale.path` (standaard `/gmail-pubsub`), omdat Tailscale
de set-path-prefix verwijdert vóór proxying.
Als je wilt dat de backend het geprefixte pad ontvangt, stel
`hooks.gmail.tailscale.target` (of `--tailscale-target`) in op een volledige URL zoals
`http://127.0.0.1:8788/gmail-pubsub` en laat dit overeenkomen met `hooks.gmail.serve.path`.

Wil je een aangepast eindpunt? Gebruik `--push-endpoint <url>` of `--tailscale off`.

Platformnotitie: op macOS installeert de wizard `gcloud`, `gogcli` en `tailscale`
via Homebrew; op Linux installeer je deze eerst handmatig.

Gateway automatisch starten (aanbevolen):

- Wanneer `hooks.enabled=true` en `hooks.gmail.account` is ingesteld, start de Gateway
  `gog gmail watch serve` bij het opstarten en vernieuwt de watch automatisch.
- Stel `OPENCLAW_SKIP_GMAIL_WATCHER=1` in om uit te schakelen (handig als je de daemon zelf draait).
- Draai de handmatige daemon niet tegelijk, anders krijg je
  `listen tcp 127.0.0.1:8788: bind: address already in use`.

Handmatige daemon (start `gog gmail watch serve` + automatisch vernieuwen):

```bash
openclaw webhooks gmail run
```

## Eenmalige installatie

1. Selecteer het GCP-project **dat eigenaar is van de OAuth-client** die door `gog` wordt gebruikt.

```bash
gcloud auth login
gcloud config set project <project-id>
```

Let op: Gmail-watch vereist dat het Pub/Sub-topic in hetzelfde project staat als de OAuth-client.

2. API’s inschakelen:

```bash
gcloud services enable gmail.googleapis.com pubsub.googleapis.com
```

3. Maak een topic aan:

```bash
gcloud pubsub topics create gog-gmail-watch
```

4. Sta toe dat Gmail-push publiceert:

```bash
gcloud pubsub topics add-iam-policy-binding gog-gmail-watch \
  --member=serviceAccount:gmail-api-push@system.gserviceaccount.com \
  --role=roles/pubsub.publisher
```

## Start de watch

```bash
gog gmail watch start \
  --account openclaw@gmail.com \
  --label INBOX \
  --topic projects/<project-id>/topics/gog-gmail-watch
```

Sla de `history_id` uit de uitvoer op (voor debugging).

## De push-handler draaien

Lokaal voorbeeld (gedeelde tokenauthenticatie):

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

Notities:

- `--token` beschermt het push-eindpunt (`x-gog-token` of `?token=`).
- `--hook-url` verwijst naar OpenClaw `/hooks/gmail` (gemapt; geïsoleerde run + samenvatting naar hoofd).
- `--include-body` en `--max-bytes` bepalen het body-fragment dat naar OpenClaw wordt gestuurd.

Aanbevolen: `openclaw webhooks gmail run` omwikkelt dezelfde flow en vernieuwt de watch automatisch.

## De handler blootstellen (geavanceerd, niet ondersteund)

Als je een niet-Tailscale-tunnel nodig hebt, koppel deze handmatig en gebruik de publieke URL in de push-
abonnement (niet ondersteund, geen vangrails):

```bash
cloudflared tunnel --url http://127.0.0.1:8788 --no-autoupdate
```

Gebruik de gegenereerde URL als het push-eindpunt:

```bash
gcloud pubsub subscriptions create gog-gmail-watch-push \
  --topic gog-gmail-watch \
  --push-endpoint "https://<public-url>/gmail-pubsub?token=<shared>"
```

Productie: gebruik een stabiel HTTPS-eindpunt en configureer Pub/Sub OIDC JWT, en voer vervolgens uit:

```bash
gog gmail watch serve --verify-oidc --oidc-email <svc@...>
```

## Testen

Stuur een bericht naar de gemonitorde inbox:

```bash
gog gmail send \
  --account openclaw@gmail.com \
  --to openclaw@gmail.com \
  --subject "watch test" \
  --body "ping"
```

Controleer de watch-status en geschiedenis:

```bash
gog gmail watch status --account openclaw@gmail.com
gog gmail history --account openclaw@gmail.com --since <historyId>
```

## Problemen oplossen

- `Invalid topicName`: projectmismatch (topic staat niet in het OAuth-clientproject).
- `User not authorized`: ontbrekende `roles/pubsub.publisher` op het topic.
- Lege berichten: Gmail-push levert alleen `historyId`; haal op via `gog gmail history`.

## Opschonen

```bash
gog gmail watch stop --account openclaw@gmail.com
gcloud pubsub subscriptions delete gog-gmail-watch-push
gcloud pubsub topics delete gog-gmail-watch
```
