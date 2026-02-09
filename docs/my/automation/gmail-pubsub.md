---
summary: "gogcli မှတဆင့် OpenClaw webhooks နှင့် ချိတ်ဆက်ထားသော Gmail Pub/Sub push"
read_when:
  - Gmail inbox trigger များကို OpenClaw နှင့် ချိတ်ဆက်ခြင်း
  - agent wake အတွက် Pub/Sub push ကို တပ်ဆင်ခြင်း
title: "Gmail PubSub"
---

# Gmail Pub/Sub -> OpenClaw

ရည်ရွယ်ချက်: Gmail watch -> Pub/Sub push -> `gog gmail watch serve` -> OpenClaw webhook။

## Prereqs

- `gcloud` ကို ထည့်သွင်းပြီး login ပြုလုပ်ထားရပါမည် ([install guide](https://docs.cloud.google.com/sdk/docs/install-sdk))။
- `gog` (gogcli) ကို ထည့်သွင်းပြီး Gmail account အတွက် authorization ပြုလုပ်ထားရပါမည် ([gogcli.sh](https://gogcli.sh/))။
- OpenClaw hooks ကို ဖွင့်ထားရပါမည် ([Webhooks](/automation/webhook) ကိုကြည့်ပါ)။
- 39. `tailscale` သို့ login ဝင်ထားသည် ([tailscale.com](https://tailscale.com/))။ 40. Support ပြုလုပ်ထားသော setup သည် public HTTPS endpoint အတွက် Tailscale Funnel ကို အသုံးပြုသည်။
  40. အခြား tunnel service များလည်း အလုပ်လုပ်နိုင်သော်လည်း DIY/unsupported ဖြစ်ပြီး လက်ဖြင့် ချိတ်ဆက်ရမည် ဖြစ်သည်။
  41. လက်ရှိအချိန်တွင် Tailscale သာ ကျွန်ုပ်တို့ ထောက်ပံ့ထားသည်။

ဥပမာ hook config (Gmail preset mapping ကို enable ပြုလုပ်ထားသည်):

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

Gmail summary ကို chat surface တစ်ခုသို့ ပို့ရန်အတွက် preset ကို override လုပ်ပြီး
`deliver` နှင့် optional `channel`/`to` ကို သတ်မှတ်သော mapping ကို အသုံးပြုပါ:

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

43. Fixed channel တစ်ခု လိုပါက `channel` + `to` ကို သတ်မှတ်ပါ။ 44. မဟုတ်ပါက `channel: "last"` သည် နောက်ဆုံး အသုံးပြုခဲ့သော delivery route ကို အသုံးပြုမည် (WhatsApp သို့ fallback ဖြစ်သည်)။

45. Gmail run များအတွက် စျေးသက်သာသော model ကို အတင်းအသုံးပြုလိုပါက mapping ထဲတွင် `model` ကို သတ်မှတ်ပါ (`provider/model` သို့မဟုတ် alias)။ 46. `agents.defaults.models` ကို enforce လုပ်ထားပါက အဲဒီထဲတွင်လည်း ထည့်သွင်းပါ။

Gmail hooks အတွက်သာ default model နှင့် thinking level ကို သတ်မှတ်လိုပါက
config ထဲတွင် `hooks.gmail.model` / `hooks.gmail.thinking` ကို ထည့်ပါ:

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

မှတ်ချက်များ:

- Mapping ထဲရှိ per-hook `model`/`thinking` သည် ဒီ default များကို override လုပ်ပါသည်။
- Fallback အစဉ်: `hooks.gmail.model` → `agents.defaults.model.fallbacks` → primary (auth/rate-limit/timeouts)။
- `agents.defaults.models` ကို သတ်မှတ်ထားပါက Gmail model သည် allowlist ထဲတွင် ပါဝင်ရပါမည်။
- 47. Gmail hook content ကို ပုံမှန်အားဖြင့် external-content safety boundary များဖြင့် wrap လုပ်ထားသည်။
  48. Disable လုပ်လိုပါက (အန္တရာယ်ရှိ) `hooks.gmail.allowUnsafeExternalContent: true` ကို သတ်မှတ်ပါ။

Payload ကို ထပ်မံ စိတ်ကြိုက်ပြင်ဆင်လိုပါက `hooks.mappings` သို့မဟုတ် JS/TS transform module ကို
`hooks.transformsDir` အောက်တွင် ထည့်ပါ ([Webhooks](/automation/webhook) ကိုကြည့်ပါ)။

## Wizard (အကြံပြု)

အရာအားလုံးကို ချိတ်ဆက်ပေးသော OpenClaw helper ကို အသုံးပြုပါ (macOS တွင် brew ဖြင့် deps များကို ထည့်သွင်းပေးပါသည်):

```bash
openclaw webhooks gmail setup \
  --account openclaw@gmail.com
```

Defaults:

- Public push endpoint အတွက် Tailscale Funnel ကို အသုံးပြုပါသည်။
- `openclaw webhooks gmail run` အတွက် `hooks.gmail` config ကို ရေးထည့်ပါသည်။
- Gmail hook preset (`hooks.presets: ["gmail"]`) ကို enable ပြုလုပ်ပါသည်။

49. Path မှတ်ချက်: `tailscale.mode` ကို enable လုပ်ထားသောအခါ OpenClaw သည် `hooks.gmail.serve.path` ကို `/` အဖြစ် အလိုအလျောက် သတ်မှတ်ပြီး Tailscale သည် proxy လုပ်ရာတွင် set-path prefix ကို ဖယ်ရှားသည့်အတွက် public path ကို `hooks.gmail.tailscale.path` (default `/gmail-pubsub`) တွင် ဆက်လက် ထားရှိသည်။
50. Backend သို့ prefixed path ကို လက်ခံစေချင်ပါက `hooks.gmail.tailscale.target` (သို့မဟုတ် `--tailscale-target`) ကို `http://127.0.0.1:8788/gmail-pubsub` ကဲ့သို့ full URL အဖြစ် သတ်မှတ်ပြီး `hooks.gmail.serve.path` နှင့် ကိုက်ညီအောင် ချိန်ညှိပါ။

စိတ်ကြိုက် endpoint လိုချင်ပါသလား? `--push-endpoint <url>` သို့မဟုတ် `--tailscale off` ကို အသုံးပြုပါ။

Platform မှတ်ချက်: macOS တွင် wizard သည် `gcloud`, `gogcli`, နှင့် `tailscale`
တို့ကို Homebrew ဖြင့် ထည့်သွင်းပေးပါသည်။ Linux တွင်မူ အရင်ဆုံး manual ထည့်သွင်းရပါမည်။

Gateway auto-start (အကြံပြု):

- `hooks.enabled=true` နှင့် `hooks.gmail.account` ကို သတ်မှတ်ထားပါက Gateway သည်
  boot အချိန်တွင် `gog gmail watch serve` ကို စတင်ပြီး watch ကို အလိုအလျောက် ပြန်လည်သက်တမ်းတိုးပေးပါသည်။
- Opt out လုပ်လိုပါက `OPENCLAW_SKIP_GMAIL_WATCHER=1` ကို သတ်မှတ်ပါ (daemon ကို ကိုယ်တိုင် run လုပ်သူများအတွက် အသုံးဝင်ပါသည်)။
- Manual daemon ကို တပြိုင်နက် run မလုပ်ပါနှင့်၊ မဟုတ်ပါက
  `listen tcp 127.0.0.1:8788: bind: address already in use` ကို ကြုံတွေ့ရပါလိမ့်မည်။

Manual daemon (`gog gmail watch serve` + auto-renew ကို စတင်):

```bash
openclaw webhooks gmail run
```

## One-time setup

1. `gog` အသုံးပြုသော OAuth client ကို ပိုင်ဆိုင်သည့် GCP project ကို ရွေးချယ်ပါ။

```bash
gcloud auth login
gcloud config set project <project-id>
```

မှတ်ချက်: Gmail watch သည် Pub/Sub topic ကို OAuth client နှင့် တူညီသော project ထဲတွင် ရှိရပါမည်။

2. API များကို Enable ပြုလုပ်ပါ:

```bash
gcloud services enable gmail.googleapis.com pubsub.googleapis.com
```

3. Topic တစ်ခုကို ဖန်တီးပါ:

```bash
gcloud pubsub topics create gog-gmail-watch
```

4. Gmail push မှ publish လုပ်ခွင့်ပေးပါ:

```bash
gcloud pubsub topics add-iam-policy-binding gog-gmail-watch \
  --member=serviceAccount:gmail-api-push@system.gserviceaccount.com \
  --role=roles/pubsub.publisher
```

## Watch ကို စတင်ပါ

```bash
gog gmail watch start \
  --account openclaw@gmail.com \
  --label INBOX \
  --topic projects/<project-id>/topics/gog-gmail-watch
```

Output ထဲမှ `history_id` ကို သိမ်းထားပါ (debugging အတွက်)။

## Push handler ကို run ပြုလုပ်ပါ

Local ဥပမာ (shared token auth):

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

မှတ်ချက်များ:

- `--token` သည် push endpoint (`x-gog-token` သို့မဟုတ် `?token=`) ကို ကာကွယ်ပေးပါသည်။
- `--hook-url` သည် OpenClaw `/hooks/gmail` သို့ ညွှန်ပြထားပါသည် (mapped; isolated run + summary ကို main သို့ ပို့ပါသည်)။
- `--include-body` နှင့် `--max-bytes` သည် OpenClaw သို့ ပို့သော body snippet ကို ထိန်းချုပ်ပါသည်။

အကြံပြုချက်: `openclaw webhooks gmail run` သည် တူညီသော flow ကို wrap လုပ်ပြီး watch ကို အလိုအလျောက် ပြန်လည်သက်တမ်းတိုးပေးပါသည်။

## Handler ကို expose လုပ်ခြင်း (advanced, unsupported)

Tailscale မဟုတ်သော tunnel ကို လိုအပ်ပါက manual ချိတ်ဆက်ပြီး push
subscription ထဲတွင် public URL ကို အသုံးပြုပါ (unsupported, guardrails မရှိပါ):

```bash
cloudflared tunnel --url http://127.0.0.1:8788 --no-autoupdate
```

Generate လုပ်ထားသော URL ကို push endpoint အဖြစ် အသုံးပြုပါ:

```bash
gcloud pubsub subscriptions create gog-gmail-watch-push \
  --topic gog-gmail-watch \
  --push-endpoint "https://<public-url>/gmail-pubsub?token=<shared>"
```

Production: stable HTTPS endpoint ကို အသုံးပြုပြီး Pub/Sub OIDC JWT ကို configure လုပ်ကာ နောက်ထပ် run လုပ်ပါ:

```bash
gog gmail watch serve --verify-oidc --oidc-email <svc@...>
```

## Test

Watch လုပ်ထားသော inbox သို့ မက်ဆေ့ခ််တစ်စောင် ပို့ပါ:

```bash
gog gmail send \
  --account openclaw@gmail.com \
  --to openclaw@gmail.com \
  --subject "watch test" \
  --body "ping"
```

Watch state နှင့် history ကို စစ်ဆေးပါ:

```bash
gog gmail watch status --account openclaw@gmail.com
gog gmail history --account openclaw@gmail.com --since <historyId>
```

## Troubleshooting

- `Invalid topicName`: project မကိုက်ညီခြင်း (topic သည် OAuth client project ထဲတွင် မရှိပါ)။
- `User not authorized`: topic ပေါ်တွင် `roles/pubsub.publisher` မရှိခြင်း။
- Empty messages: Gmail push သည် `historyId` ကိုသာ ပေးပါသည်; `gog gmail history` ဖြင့် fetch လုပ်ပါ။

## Cleanup

```bash
gog gmail watch stop --account openclaw@gmail.com
gcloud pubsub subscriptions delete gog-gmail-watch-push
gcloud pubsub topics delete gog-gmail-watch
```
