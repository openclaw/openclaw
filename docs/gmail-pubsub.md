---
summary: "Gmail Pub/Sub push wired into Clawdis webhooks via gogcli"
read_when:
  - Wiring Gmail inbox triggers to Clawdis
  - Setting up Pub/Sub push for agent wake
---

# Gmail Pub/Sub -> Clawdis

Goal: Gmail watch -> Pub/Sub push -> `gog gmail watch serve` -> Clawdis webhook.

## Prereqs

- `gcloud` installed and logged in.
- `gog` (gogcli) installed and authorized for the Gmail account.
- Clawdis hooks enabled (see `docs/webhook.md`).
- `tailscale` logged in if you want a public HTTPS endpoint via Funnel.

Example hook config (enable Gmail preset mapping):

```json5
{
  hooks: {
    enabled: true,
    token: "CLAWDIS_HOOK_TOKEN",
    path: "/hooks",
    presets: ["gmail"]
  }
}
```

To customize payload handling, add `hooks.mappings` or a JS/TS transform module
under `hooks.transformsDir` (see `docs/webhook.md`).

## Wizard (recommended)

Use the Clawdis helper to wire everything together (installs deps on macOS via brew):

```bash
clawdis hooks gmail setup \
  --account clawdbot@gmail.com
```

Defaults:
- Uses Tailscale Funnel for the public push endpoint.
- Writes `hooks.gmail` config for `clawdis hooks gmail run`.
- Enables the Gmail hook preset (`hooks.presets: ["gmail"]`).

Path note: when `tailscale.mode` is enabled, Clawdis automatically sets
`hooks.gmail.serve.path` to `/` and keeps the public path at
`hooks.gmail.tailscale.path` (default `/gmail-pubsub`) because Tailscale
strips the set-path prefix before proxying.

Want a custom endpoint? Use `--push-endpoint <url>` or `--tailscale off`.

Platform note: on macOS the wizard installs `gcloud`, `gogcli`, and `tailscale`
via Homebrew; on Linux install them manually first.

Gateway auto-start (recommended):
- When `hooks.enabled=true` and `hooks.gmail.account` is set, the Gateway starts
  `gog gmail watch serve` on boot and auto-renews the watch.
- Set `CLAWDIS_SKIP_GMAIL_WATCHER=1` to opt out (useful if you run the daemon yourself).
- Do not run the manual daemon at the same time, or you will hit
  `listen tcp 127.0.0.1:8788: bind: address already in use`.

Manual daemon (starts `gog gmail watch serve` + auto-renew):

```bash
clawdis hooks gmail run
```

## One-time setup

1) Select the GCP project **that owns the OAuth client** used by `gog`.

```bash
gcloud auth login
gcloud config set project <project-id>
```

Note: Gmail watch requires the Pub/Sub topic to live in the same project as the OAuth client.

2) Enable APIs:

```bash
gcloud services enable gmail.googleapis.com pubsub.googleapis.com
```

3) Create a topic:

```bash
gcloud pubsub topics create gog-gmail-watch
```

4) Allow Gmail push to publish:

```bash
gcloud pubsub topics add-iam-policy-binding gog-gmail-watch \
  --member=serviceAccount:gmail-api-push@system.gserviceaccount.com \
  --role=roles/pubsub.publisher
```

## Start the watch

```bash
gog gmail watch start \
  --account clawdbot@gmail.com \
  --label INBOX \
  --topic projects/<project-id>/topics/gog-gmail-watch
```

Save the `history_id` from the output (for debugging).

## Run the push handler

Local example (shared token auth):

```bash
gog gmail watch serve \
  --account clawdbot@gmail.com \
  --bind 127.0.0.1 \
  --port 8788 \
  --path /gmail-pubsub \
  --token <shared> \
  --hook-url http://127.0.0.1:18789/hooks/gmail \
  --hook-token CLAWDIS_HOOK_TOKEN \
  --include-body \
  --max-bytes 20000
```

Notes:
- `--token` protects the push endpoint (`x-gog-token` or `?token=`).
- `--hook-url` points to Clawdis `/hooks/gmail` (mapped; isolated run + summary to main).
- `--include-body` and `--max-bytes` control the body snippet sent to Clawdis.

Recommended: `clawdis hooks gmail run` wraps the same flow and auto-renews the watch.

## Expose the handler (dev)

For local testing, tunnel the handler and use the public URL in the push subscription:

```bash
cloudflared tunnel --url http://127.0.0.1:8788 --no-autoupdate
```

Use the generated URL as the push endpoint:

```bash
gcloud pubsub subscriptions create gog-gmail-watch-push \
  --topic gog-gmail-watch \
  --push-endpoint "https://<public-url>/gmail-pubsub?token=<shared>"
```

Production: use a stable HTTPS endpoint and configure Pub/Sub OIDC JWT, then run:

```bash
gog gmail watch serve --verify-oidc --oidc-email <svc@...>
```

## Test

Send a message to the watched inbox:

```bash
gog gmail send \
  --account clawdbot@gmail.com \
  --to clawdbot@gmail.com \
  --subject "watch test" \
  --body "ping"
```

Check watch state and history:

```bash
gog gmail watch status --account clawdbot@gmail.com
gog gmail history --account clawdbot@gmail.com --since <historyId>
```

## Troubleshooting

- `Invalid topicName`: project mismatch (topic not in the OAuth client project).
- `User not authorized`: missing `roles/pubsub.publisher` on the topic.
- Empty messages: Gmail push only provides `historyId`; fetch via `gog gmail history`.

## Cleanup

```bash
gog gmail watch stop --account clawdbot@gmail.com
gcloud pubsub subscriptions delete gog-gmail-watch-push
gcloud pubsub topics delete gog-gmail-watch
```
