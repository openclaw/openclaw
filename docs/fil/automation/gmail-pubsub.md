---
summary: "Gmail Pub/Sub push na naka-wire sa OpenClaw webhooks gamit ang gogcli"
read_when:
  - Pag-wire ng Gmail inbox triggers sa OpenClaw
  - Pag-setup ng Pub/Sub push para sa agent wake
title: "Gmail PubSub"
---

# Gmail Pub/Sub -> OpenClaw

Layunin: Gmail watch -> Pub/Sub push -> `gog gmail watch serve` -> OpenClaw webhook.

## Prereqs

- `gcloud` naka-install at naka-log in ([install guide](https://docs.cloud.google.com/sdk/docs/install-sdk)).
- `gog` (gogcli) naka-install at may awtorisasyon para sa Gmail account ([gogcli.sh](https://gogcli.sh/)).
- Naka-enable ang OpenClaw hooks (tingnan ang [Webhooks](/automation/webhook)).
- `tailscale` logged in ([tailscale.com](https://tailscale.com/)). Supported setup uses Tailscale Funnel for the public HTTPS endpoint.
  Other tunnel services can work, but are DIY/unsupported and require manual wiring.
  Right now, Tailscale is what we support.

Halimbawang hook config (i-enable ang Gmail preset mapping):

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

Para maihatid ang Gmail summary sa isang chat surface, i-override ang preset gamit ang mapping
na nagse-set ng `deliver` + opsyonal na `channel`/`to`:

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

If you want a fixed channel, set `channel` + `to`. Otherwise `channel: "last"`
uses the last delivery route (falls back to WhatsApp).

To force a cheaper model for Gmail runs, set `model` in the mapping
(`provider/model` or alias). If you enforce `agents.defaults.models`, include it there.

Para magtakda ng default na model at thinking level na partikular para sa Gmail hooks, idagdag
ang `hooks.gmail.model` / `hooks.gmail.thinking` sa iyong config:

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

Mga tala:

- Ang per-hook `model`/`thinking` sa mapping ay nag-o-override pa rin sa mga default na ito.
- Fallback order: `hooks.gmail.model` → `agents.defaults.model.fallbacks` → primary (auth/rate-limit/timeouts).
- Kung naka-set ang `agents.defaults.models`, dapat nasa allowlist ang Gmail model.
- Gmail hook content is wrapped with external-content safety boundaries by default.
  To disable (dangerous), set `hooks.gmail.allowUnsafeExternalContent: true`.

Para mas i-customize pa ang payload handling, idagdag ang `hooks.mappings` o isang JS/TS transform module
sa ilalim ng `hooks.transformsDir` (tingnan ang [Webhooks](/automation/webhook)).

## Wizard (inirerekomenda)

Gamitin ang OpenClaw helper para i-wire ang lahat (nag-i-install ng deps sa macOS gamit ang brew):

```bash
openclaw webhooks gmail setup \
  --account openclaw@gmail.com
```

Mga default:

- Gumagamit ng Tailscale Funnel para sa public push endpoint.
- Nagsusulat ng `hooks.gmail` config para sa `openclaw webhooks gmail run`.
- Ina-enable ang Gmail hook preset (`hooks.presets: ["gmail"]`).

Path note: when `tailscale.mode` is enabled, OpenClaw automatically sets
`hooks.gmail.serve.path` to `/` and keeps the public path at
`hooks.gmail.tailscale.path` (default `/gmail-pubsub`) because Tailscale
strips the set-path prefix before proxying.
If you need the backend to receive the prefixed path, set
`hooks.gmail.tailscale.target` (or `--tailscale-target`) to a full URL like
`http://127.0.0.1:8788/gmail-pubsub` and match `hooks.gmail.serve.path`.

Want a custom endpoint? Use `--push-endpoint <url>` or `--tailscale off`.

Platform note: sa macOS ini-install ng wizard ang `gcloud`, `gogcli`, at `tailscale`
sa pamamagitan ng Homebrew; sa Linux, i-install muna ang mga ito nang mano-mano.

Gateway auto-start (inirerekomenda):

- Kapag naka-set ang `hooks.enabled=true` at `hooks.gmail.account`, sinisimulan ng Gateway ang
  `gog gmail watch serve` sa boot at awtomatikong nagre-renew ng watch.
- I-set ang `OPENCLAW_SKIP_GMAIL_WATCHER=1` para mag-opt out (kapaki-pakinabang kung ikaw mismo ang nagpapatakbo ng daemon).
- Huwag patakbuhin ang manual daemon nang sabay, o tatama ka sa
  `listen tcp 127.0.0.1:8788: bind: address already in use`.

Manual daemon (sinisimulan ang `gog gmail watch serve` + auto-renew):

```bash
openclaw webhooks gmail run
```

## One-time setup

1. Piliin ang GCP project **na may-ari ng OAuth client** na ginagamit ng `gog`.

```bash
gcloud auth login
gcloud config set project <project-id>
```

Tala: Kailangan ng Gmail watch na ang Pub/Sub topic ay nasa parehong project ng OAuth client.

2. I-enable ang mga API:

```bash
gcloud services enable gmail.googleapis.com pubsub.googleapis.com
```

3. Gumawa ng topic:

```bash
gcloud pubsub topics create gog-gmail-watch
```

4. Payagan ang Gmail push na mag-publish:

```bash
gcloud pubsub topics add-iam-policy-binding gog-gmail-watch \
  --member=serviceAccount:gmail-api-push@system.gserviceaccount.com \
  --role=roles/pubsub.publisher
```

## Simulan ang watch

```bash
gog gmail watch start \
  --account openclaw@gmail.com \
  --label INBOX \
  --topic projects/<project-id>/topics/gog-gmail-watch
```

I-save ang `history_id` mula sa output (para sa debugging).

## Patakbuhin ang push handler

Local na halimbawa (shared token auth):

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

Mga tala:

- Pinoprotektahan ng `--token` ang push endpoint (`x-gog-token` o `?token=`).
- Tumuturo ang `--hook-url` sa OpenClaw `/hooks/gmail` (mapped; isolated run + summary sa main).
- Kinokontrol ng `--include-body` at `--max-bytes` ang body snippet na ipinapadala sa OpenClaw.

Inirerekomenda: binabalot ng `openclaw webhooks gmail run` ang parehong daloy at awtomatikong nire-renew ang watch.

## I-expose ang handler (advanced, unsupported)

Kung kailangan mo ng non-Tailscale tunnel, i-wire ito nang mano-mano at gamitin ang public URL sa push
subscription (unsupported, walang guardrails):

```bash
cloudflared tunnel --url http://127.0.0.1:8788 --no-autoupdate
```

Gamitin ang nabuo na URL bilang push endpoint:

```bash
gcloud pubsub subscriptions create gog-gmail-watch-push \
  --topic gog-gmail-watch \
  --push-endpoint "https://<public-url>/gmail-pubsub?token=<shared>"
```

Production: gumamit ng stable na HTTPS endpoint at i-configure ang Pub/Sub OIDC JWT, pagkatapos ay patakbuhin:

```bash
gog gmail watch serve --verify-oidc --oidc-email <svc@...>
```

## Test

Magpadala ng mensahe sa mino-monitor na inbox:

```bash
gog gmail send \
  --account openclaw@gmail.com \
  --to openclaw@gmail.com \
  --subject "watch test" \
  --body "ping"
```

Suriin ang watch state at history:

```bash
gog gmail watch status --account openclaw@gmail.com
gog gmail history --account openclaw@gmail.com --since <historyId>
```

## Pag-troubleshoot

- `Invalid topicName`: hindi tugmang project (ang topic ay wala sa OAuth client project).
- `User not authorized`: nawawala ang `roles/pubsub.publisher` sa topic.
- Walang laman na mga mensahe: nagbibigay lang ang Gmail push ng `historyId`; kunin sa pamamagitan ng `gog gmail history`.

## Cleanup

```bash
gog gmail watch stop --account openclaw@gmail.com
gcloud pubsub subscriptions delete gog-gmail-watch-push
gcloud pubsub topics delete gog-gmail-watch
```
