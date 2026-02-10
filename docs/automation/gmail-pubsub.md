---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "Gmail Pub/Sub push wired into OpenClaw webhooks via gogcli"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Wiring Gmail inbox triggers to OpenClaw（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Setting up Pub/Sub push for agent wake（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "Gmail PubSub"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Gmail Pub/Sub -> OpenClaw（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Goal: Gmail watch -> Pub/Sub push -> `gog gmail watch serve` -> OpenClaw webhook.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Prereqs（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `gcloud` installed and logged in ([install guide](https://docs.cloud.google.com/sdk/docs/install-sdk)).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `gog` (gogcli) installed and authorized for the Gmail account ([gogcli.sh](https://gogcli.sh/)).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- OpenClaw hooks enabled (see [Webhooks](/automation/webhook)).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `tailscale` logged in ([tailscale.com](https://tailscale.com/)). Supported setup uses Tailscale Funnel for the public HTTPS endpoint.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  Other tunnel services can work, but are DIY/unsupported and require manual wiring.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  Right now, Tailscale is what we support.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Example hook config (enable Gmail preset mapping):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  hooks: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    enabled: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    token: "OPENCLAW_HOOK_TOKEN",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    path: "/hooks",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    presets: ["gmail"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
To deliver the Gmail summary to a chat surface, override the preset with a mapping（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
that sets `deliver` + optional `channel`/`to`:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  hooks: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    enabled: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    token: "OPENCLAW_HOOK_TOKEN",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    presets: ["gmail"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    mappings: [（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        match: { path: "gmail" },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        action: "agent",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        wakeMode: "now",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        name: "Gmail",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        sessionKey: "hook:gmail:{{messages[0].id}}",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        messageTemplate: "New email from {{messages[0].from}}\nSubject: {{messages[0].subject}}\n{{messages[0].snippet}}\n{{messages[0].body}}",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        model: "openai/gpt-5.2-mini",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        deliver: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        channel: "last",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        // to: "+15551234567"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If you want a fixed channel, set `channel` + `to`. Otherwise `channel: "last"`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
uses the last delivery route (falls back to WhatsApp).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
To force a cheaper model for Gmail runs, set `model` in the mapping（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
(`provider/model` or alias). If you enforce `agents.defaults.models`, include it there.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
To set a default model and thinking level specifically for Gmail hooks, add（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`hooks.gmail.model` / `hooks.gmail.thinking` in your config:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  hooks: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    gmail: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      model: "openrouter/meta-llama/llama-3.3-70b-instruct:free",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      thinking: "off",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Notes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Per-hook `model`/`thinking` in the mapping still overrides these defaults.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Fallback order: `hooks.gmail.model` → `agents.defaults.model.fallbacks` → primary (auth/rate-limit/timeouts).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If `agents.defaults.models` is set, the Gmail model must be in the allowlist.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Gmail hook content is wrapped with external-content safety boundaries by default.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  To disable (dangerous), set `hooks.gmail.allowUnsafeExternalContent: true`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
To customize payload handling further, add `hooks.mappings` or a JS/TS transform module（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
under `hooks.transformsDir` (see [Webhooks](/automation/webhook)).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Wizard (recommended)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use the OpenClaw helper to wire everything together (installs deps on macOS via brew):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw webhooks gmail setup \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --account openclaw@gmail.com（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Defaults:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Uses Tailscale Funnel for the public push endpoint.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Writes `hooks.gmail` config for `openclaw webhooks gmail run`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Enables the Gmail hook preset (`hooks.presets: ["gmail"]`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Path note: when `tailscale.mode` is enabled, OpenClaw automatically sets（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`hooks.gmail.serve.path` to `/` and keeps the public path at（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`hooks.gmail.tailscale.path` (default `/gmail-pubsub`) because Tailscale（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
strips the set-path prefix before proxying.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If you need the backend to receive the prefixed path, set（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`hooks.gmail.tailscale.target` (or `--tailscale-target`) to a full URL like（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`http://127.0.0.1:8788/gmail-pubsub` and match `hooks.gmail.serve.path`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Want a custom endpoint? Use `--push-endpoint <url>` or `--tailscale off`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Platform note: on macOS the wizard installs `gcloud`, `gogcli`, and `tailscale`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
via Homebrew; on Linux install them manually first.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Gateway auto-start (recommended):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- When `hooks.enabled=true` and `hooks.gmail.account` is set, the Gateway starts（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  `gog gmail watch serve` on boot and auto-renews the watch.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Set `OPENCLAW_SKIP_GMAIL_WATCHER=1` to opt out (useful if you run the daemon yourself).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Do not run the manual daemon at the same time, or you will hit（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  `listen tcp 127.0.0.1:8788: bind: address already in use`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Manual daemon (starts `gog gmail watch serve` + auto-renew):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw webhooks gmail run（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## One-time setup（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Select the GCP project **that owns the OAuth client** used by `gog`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
gcloud auth login（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
gcloud config set project <project-id>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Note: Gmail watch requires the Pub/Sub topic to live in the same project as the OAuth client.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Enable APIs:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
gcloud services enable gmail.googleapis.com pubsub.googleapis.com（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. Create a topic:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
gcloud pubsub topics create gog-gmail-watch（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. Allow Gmail push to publish:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
gcloud pubsub topics add-iam-policy-binding gog-gmail-watch \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --member=serviceAccount:gmail-api-push@system.gserviceaccount.com \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --role=roles/pubsub.publisher（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Start the watch（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
gog gmail watch start \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --account openclaw@gmail.com \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --label INBOX \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --topic projects/<project-id>/topics/gog-gmail-watch（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Save the `history_id` from the output (for debugging).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Run the push handler（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Local example (shared token auth):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
gog gmail watch serve \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --account openclaw@gmail.com \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --bind 127.0.0.1 \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --port 8788 \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --path /gmail-pubsub \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --token <shared> \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --hook-url http://127.0.0.1:18789/hooks/gmail \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --hook-token OPENCLAW_HOOK_TOKEN \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --include-body \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --max-bytes 20000（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Notes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--token` protects the push endpoint (`x-gog-token` or `?token=`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--hook-url` points to OpenClaw `/hooks/gmail` (mapped; isolated run + summary to main).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--include-body` and `--max-bytes` control the body snippet sent to OpenClaw.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Recommended: `openclaw webhooks gmail run` wraps the same flow and auto-renews the watch.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Expose the handler (advanced, unsupported)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If you need a non-Tailscale tunnel, wire it manually and use the public URL in the push（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
subscription (unsupported, no guardrails):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
cloudflared tunnel --url http://127.0.0.1:8788 --no-autoupdate（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use the generated URL as the push endpoint:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
gcloud pubsub subscriptions create gog-gmail-watch-push \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --topic gog-gmail-watch \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --push-endpoint "https://<public-url>/gmail-pubsub?token=<shared>"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Production: use a stable HTTPS endpoint and configure Pub/Sub OIDC JWT, then run:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
gog gmail watch serve --verify-oidc --oidc-email <svc@...>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Test（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Send a message to the watched inbox:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
gog gmail send \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --account openclaw@gmail.com \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --to openclaw@gmail.com \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --subject "watch test" \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --body "ping"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Check watch state and history:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
gog gmail watch status --account openclaw@gmail.com（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
gog gmail history --account openclaw@gmail.com --since <historyId>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Troubleshooting（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `Invalid topicName`: project mismatch (topic not in the OAuth client project).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `User not authorized`: missing `roles/pubsub.publisher` on the topic.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Empty messages: Gmail push only provides `historyId`; fetch via `gog gmail history`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Cleanup（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
gog gmail watch stop --account openclaw@gmail.com（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
gcloud pubsub subscriptions delete gog-gmail-watch-push（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
gcloud pubsub topics delete gog-gmail-watch（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
