---
summary: "Gateway (ချတ်၊ နိုဒ်များ၊ ဖွဲ့စည်းပြင်ဆင်မှု) အတွက် ဘရောက်ဇာအခြေပြု ထိန်းချုပ် UI"
read_when:
  - ဘရောက်ဇာမှ Gateway ကို လည်ပတ်လိုသောအခါ
  - SSH တန်နယ်များ မသုံးဘဲ Tailnet ဝင်ရောက်လိုသောအခါ
title: "Control UI"
x-i18n:
  source_path: web/control-ui.md
  source_hash: baaaf73820f0e703
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:55:32Z
---

# Control UI (ဘရောက်ဇာ)

Control UI သည် Gateway မှ ဝန်ဆောင်မှုပေးထားသော **Vite + Lit** single-page app အသေးစားတစ်ခုဖြစ်သည်။

- ပုံမှန်: `http://<host>:18789/`
- ရွေးချယ်နိုင်သော prefix: `gateway.controlUi.basePath` ကို သတ်မှတ်ပါ (ဥပမာ `/openclaw`)

၎င်းသည် တူညီသော ပေါ့တ်ပေါ်ရှိ **Gateway WebSocket** သို့ **တိုက်ရိုက်** ဆက်သွယ်ပါသည်။

## Quick open (local)

Gateway သည် တူညီသော ကွန်ပျူတာပေါ်တွင် လည်ပတ်နေပါက အောက်ပါကို ဖွင့်ပါ။

- [http://127.0.0.1:18789/](http://127.0.0.1:18789/) (သို့မဟုတ် [http://localhost:18789/](http://localhost:18789/))

စာမျက်နှာ မတင်လာပါက Gateway ကို အရင်စတင်ပါ: `openclaw gateway`။

Auth ကို WebSocket handshake အတွင်း အောက်ပါအတိုင်း ပေးပို့ပါသည်။

- `connect.params.auth.token`
- `connect.params.auth.password`
  ဒက်ရှ်ဘုတ် ဆက်တင် ပန်နယ်မှ token ကို သိမ်းဆည်းနိုင်ပါသည်; စကားဝှက်များကို မသိမ်းဆည်းပါ။
  onboarding wizard သည် ပုံမှန်အားဖြင့် gateway token ကို ထုတ်ပေးထားသဖြင့် ပထမဆုံး ချိတ်ဆက်ရာတွင် ဤနေရာတွင် ကူးထည့်ပါ။

## စက်ပစ္စည်း ချိတ်ဆက်အတည်ပြုခြင်း (ပထမဆုံး ချိတ်ဆက်မှု)

Control UI ကို ဘရောက်ဇာအသစ် သို့မဟုတ် စက်ပစ္စည်းအသစ်မှ ချိတ်ဆက်သောအခါ Gateway သည်
**တစ်ကြိမ်သာ ချိတ်ဆက်အတည်ပြုခြင်း** ကို တောင်းဆိုပါသည် — `gateway.auth.allowTailscale: true` ဖြင့်
တူညီသော Tailnet အတွင်းရှိနေသော်လည်း ဖြစ်ပါသည်။ ၎င်းသည်
ခွင့်မပြုထားသော ဝင်ရောက်မှုများကို တားဆီးရန် လုံခြုံရေး အစီအမံတစ်ရပ်ဖြစ်ပါသည်။

**မြင်ရမည့်အရာ:** "disconnected (1008): pairing required"

**စက်ပစ္စည်းကို အတည်ပြုရန်:**

```bash
# List pending requests
openclaw devices list

# Approve by request ID
openclaw devices approve <requestId>
```

အတည်ပြုပြီးနောက် စက်ပစ္စည်းကို မှတ်သားထားမည်ဖြစ်ပြီး `openclaw devices revoke --device <id> --role <role>` ဖြင့် မဖယ်ရှားမချင်း
ထပ်မံ အတည်ပြုရန် မလိုတော့ပါ။ Token ပြောင်းလဲခြင်းနှင့် ဖယ်ရှားခြင်းအတွက်
[Devices CLI](/cli/devices) ကို ကြည့်ပါ။

**မှတ်ချက်များ:**

- Local ချိတ်ဆက်မှုများ (`127.0.0.1`) ကို အလိုအလျောက် အတည်ပြုပါသည်။
- Remote ချိတ်ဆက်မှုများ (LAN၊ Tailnet စသည်) တွင် အတိအလင်း အတည်ပြုရန် လိုအပ်ပါသည်။
- ဘရောက်ဇာ ပရိုဖိုင်တစ်ခုစီသည် ထူးခြားသော device ID တစ်ခုကို ဖန်တီးသဖြင့်
  ဘရောက်ဇာ ပြောင်းလဲခြင်း သို့မဟုတ် ဘရောက်ဇာဒေတာ ဖျက်ရှင်းခြင်း ပြုလုပ်ပါက
  ထပ်မံ ချိတ်ဆက်အတည်ပြုရပါမည်။

## ယနေ့ လုပ်ဆောင်နိုင်သည့် အရာများ

- Gateway WS မှတစ်ဆင့် မော်ဒယ်နှင့် ချတ်လုပ်ခြင်း (`chat.history`, `chat.send`, `chat.abort`, `chat.inject`)
- Chat အတွင်း tool calls များကို stream လုပ်ခြင်း + live tool output cards (agent events)
- ချန်နယ်များ: WhatsApp/Telegram/Discord/Slack + plugin ချန်နယ်များ (Mattermost စသည်) အခြေအနေ + QR လော့ဂ်အင် + ချန်နယ်တစ်ခုချင်းစီအလိုက် ဖွဲ့စည်းပြင်ဆင်မှု (`channels.status`, `web.login.*`, `config.patch`)
- Instances: ရှိနေမှု စာရင်း + ပြန်လည်သစ်တင်ခြင်း (`system-presence`)
- Sessions: စာရင်း + ဆက်ရှင်တစ်ခုချင်းစီအတွက် thinking/verbose အစားထိုးခြင်း (`sessions.list`, `sessions.patch`)
- Cron jobs: စာရင်း/ထည့်သွင်း/အလုပ်လုပ်စေ/ဖွင့်/ပိတ် + အလုပ်လုပ်ခဲ့သည့် မှတ်တမ်း (`cron.*`)
- Skills: အခြေအနေ၊ ဖွင့်/ပိတ်၊ ထည့်သွင်းခြင်း၊ API key အပ်ဒိတ်များ (`skills.*`)
- Nodes: စာရင်း + caps (`node.list`)
- Exec approvals: gateway သို့မဟုတ် node allowlists များကို ပြင်ဆင်ခြင်း + `exec host=gateway/node` အတွက် မူဝါဒမေးမြန်းခြင်း (`exec.approvals.*`)
- Config: `~/.openclaw/openclaw.json` ကို ကြည့်/ပြင် (`config.get`, `config.set`)
- Config: အတည်ပြုစစ်ဆေးမှုဖြင့် အသုံးချ + ပြန်လည်စတင်ခြင်း (`config.apply`) နှင့် နောက်ဆုံး အသက်ဝင်ခဲ့သော ဆက်ရှင်ကို နိုးထစေခြင်း
- Config ရေးသားမှုများတွင် အတူတကွ ပြင်ဆင်မှုများကို မပျက်စီးစေရန် base-hash guard ပါဝင်ပါသည်
- Config schema + ဖောင် ရေးဆွဲခြင်း (`config.schema`၊ plugin + ချန်နယ် schema များ ပါဝင်သည်); Raw JSON editor ကို ဆက်လက် အသုံးပြုနိုင်ပါသည်
- Debug: အခြေအနေ/ကျန်းမာရေး/မော်ဒယ် snapshot များ + event log + လက်ဖြင့် RPC ခေါ်ဆိုမှုများ (`status`, `health`, `models.list`)
- Logs: filter/export ဖြင့် gateway ဖိုင် logs ကို live tail ကြည့်ရှုခြင်း (`logs.tail`)
- Update: package/git update ကို အလုပ်လုပ်စေပြီး ပြန်လည်စတင်ခြင်း (`update.run`) နှင့် restart report

Cron jobs panel မှတ်ချက်များ:

- သီးခြားထားသော jobs များအတွက် ပို့ဆောင်မှုကို ပုံမှန်အားဖြင့် အကျဉ်းချုပ် ကြေညာခြင်း သတ်မှတ်ထားပါသည်။ အတွင်းရေးသာ လည်ပတ်စေလိုပါက none သို့ ပြောင်းနိုင်ပါသည်။
- announce ကို ရွေးချယ်ထားပါက Channel/target အကွက်များ ပေါ်လာပါသည်။

## Chat အပြုအမူ

- `chat.send` သည် **non-blocking** ဖြစ်ပြီး `{ runId, status: "started" }` ဖြင့် ချက်ချင်း ack ပြန်ပေးကာ တုံ့ပြန်မှုကို `chat` events မှတစ်ဆင့် stream လုပ်ပါသည်။
- တူညီသော `idempotencyKey` ဖြင့် ပြန်ပို့ပါက လည်ပတ်နေစဉ် `{ status: "in_flight" }` ကို ပြန်ပေးပြီး ပြီးဆုံးပြီးနောက် `{ status: "ok" }` ကို ပြန်ပေးပါသည်။
- `chat.inject` သည် ဆက်ရှင် transcript တွင် assistant မှတ်ချက်တစ်ခု ထည့်သွင်းကာ UI-only အပ်ဒိတ်များအတွက် `chat` event ကို ထုတ်လွှင့်ပါသည် (agent run မရှိ၊ ချန်နယ်သို့ ပို့ဆောင်မှု မရှိ)။
- ရပ်တန့်ရန်:
  - **Stop** ကို နှိပ်ပါ (`chat.abort` ကို ခေါ်ဆိုသည်)
  - `/stop` (သို့မဟုတ် `stop|esc|abort|wait|exit|interrupt`) ကို ရိုက်ထည့်၍ out-of-band ဖြင့် ဖျက်သိမ်းပါ
  - `chat.abort` သည် ဆက်ရှင်အတွက် လက်ရှိ လည်ပတ်နေသော run များအားလုံးကို ဖျက်သိမ်းရန် `{ sessionKey }` ( `runId` မလို) ကို ထောက်ပံ့ပါသည်

## Tailnet ဝင်ရောက်မှု (အကြံပြု)

### Integrated Tailscale Serve (ဦးစားပေး)

Gateway ကို loopback ပေါ်တွင် ထားရှိပြီး HTTPS ဖြင့် Tailscale Serve မှ proxy လုပ်ပါ။

```bash
openclaw gateway --tailscale serve
```

ဖွင့်ရန်:

- `https://<magicdns>/` (သို့မဟုတ် သင်သတ်မှတ်ထားသော `gateway.controlUi.basePath`)

ပုံမှန်အားဖြင့် Serve request များသည် `gateway.auth.allowTailscale` သည် `true` ဖြစ်နေသည့်အခါ
Tailscale identity headers (`tailscale-user-login`) မှတစ်ဆင့် authentication ပြုလုပ်နိုင်ပါသည်။ OpenClaw သည်
`x-forwarded-for` လိပ်စာကို `tailscale whois` ဖြင့် ဖြေရှင်း၍ header နှင့် ကိုက်ညီမှုရှိမရှိ စစ်ဆေးကာ
request သည် loopback သို့ Tailscale ၏ `x-forwarded-*` headers ဖြင့် ဝင်လာသောအခါတွင်သာ လက်ခံပါသည်။
Serve traffic အတွက်တောင် token/password ကို မဖြစ်မနေ လိုအပ်စေလိုပါက
`gateway.auth.allowTailscale: false` ကို သတ်မှတ်ပါ (သို့မဟုတ် `gateway.auth.mode: "password"` ကို အတင်းအကျပ် သတ်မှတ်ပါ)။

### Tailnet သို့ bind လုပ်၍ token သုံးခြင်း

```bash
openclaw gateway --bind tailnet --token "$(openssl rand -hex 32)"
```

ထို့နောက် ဖွင့်ပါ:

- `http://<tailscale-ip>:18789/` (သို့မဟုတ် သင်သတ်မှတ်ထားသော `gateway.controlUi.basePath`)

UI ဆက်တင်များထဲသို့ token ကို ကူးထည့်ပါ (`connect.params.auth.token` အဖြစ် ပို့ဆောင်ပါသည်)။

## Insecure HTTP

plain HTTP (`http://<lan-ip>` သို့မဟုတ် `http://<tailscale-ip>`) ဖြင့် dashboard ကို ဖွင့်ပါက
ဘရောက်ဇာသည် **non-secure context** ဖြင့် လည်ပတ်ပြီး WebCrypto ကို တားဆီးပါသည်။ ပုံမှန်အားဖြင့်
OpenClaw သည် device identity မရှိသော Control UI ချိတ်ဆက်မှုများကို **ပိတ်ဆို့** ပါသည်။

**အကြံပြု ဖြေရှင်းချက်:** HTTPS (Tailscale Serve) ကို အသုံးပြုပါ သို့မဟုတ် UI ကို local မှ ဖွင့်ပါ။

- `https://<magicdns>/` (Serve)
- `http://127.0.0.1:18789/` (gateway ဟို့စ်ပေါ်တွင်)

**Downgrade ဥပမာ (HTTP ပေါ်တွင် token-only):**

```json5
{
  gateway: {
    controlUi: { allowInsecureAuth: true },
    bind: "tailnet",
    auth: { mode: "token", token: "replace-me" },
  },
}
```

ဤအရာသည် Control UI အတွက် device identity + pairing ကို ပိတ်ပင်ပါသည် (HTTPS ပေါ်တွင်ပါ)။
ကွန်ယက်ကို ယုံကြည်နိုင်မှသာ အသုံးပြုပါ။

HTTPS တပ်ဆင်ခြင်း လမ်းညွှန်အတွက် [Tailscale](/gateway/tailscale) ကို ကြည့်ပါ။

## UI ကို တည်ဆောက်ခြင်း

Gateway သည် static ဖိုင်များကို `dist/control-ui` မှ ဝန်ဆောင်မှုပေးပါသည်။ အောက်ပါအတိုင်း build လုပ်ပါ။

```bash
pnpm ui:build # auto-installs UI deps on first run
```

Optional absolute base (asset URL များကို တည်ငြိမ်စေရန်):

```bash
OPENCLAW_CONTROL_UI_BASE_PATH=/openclaw/ pnpm ui:build
```

Local development အတွက် (dev server ခွဲထားခြင်း):

```bash
pnpm ui:dev # auto-installs UI deps on first run
```

ထို့နောက် UI ကို သင်၏ Gateway WS URL (ဥပမာ `ws://127.0.0.1:18789`) သို့ ညွှန်ပြပါ။

## Debugging/testing: dev server + remote Gateway

Control UI သည် static ဖိုင်များဖြစ်ပြီး WebSocket target ကို ဖွဲ့စည်းပြင်ဆင်နိုင်ပါသည်၊ HTTP origin နှင့် မတူနိုင်ပါသည်။ ဤအရာသည် Vite dev server ကို local မှ အသုံးပြုချင်ပြီး Gateway ကို အခြားနေရာတွင် လည်ပတ်နေစေချင်သောအခါ အဆင်ပြေပါသည်။

1. UI dev server ကို စတင်ပါ: `pnpm ui:dev`
2. အောက်ပါကဲ့သို့ URL တစ်ခုကို ဖွင့်ပါ:

```text
http://localhost:5173/?gatewayUrl=ws://<gateway-host>:18789
```

လိုအပ်ပါက တစ်ကြိမ်သာ auth ပြုလုပ်ခြင်း:

```text
http://localhost:5173/?gatewayUrl=wss://<gateway-host>:18789&token=<gateway-token>
```

မှတ်ချက်များ:

- `gatewayUrl` ကို load ပြီးနောက် localStorage တွင် သိမ်းဆည်းပြီး URL မှ ဖယ်ရှားပါသည်။
- `token` ကို localStorage တွင် သိမ်းဆည်းပါသည်; `password` ကို မေမိုရီတွင်သာ ထားရှိပါသည်။
- `gatewayUrl` ကို သတ်မှတ်ထားပါက UI သည် config သို့မဟုတ် environment credentials သို့ ပြန်မလှန်ပါ။
  `token` (သို့မဟုတ် `password`) ကို အတိအလင်း ပေးရပါမည်။ အတိအလင်း credentials မရှိပါက အမှားဖြစ်ပါသည်။
- Gateway သည် TLS (Tailscale Serve၊ HTTPS proxy စသည်) အောက်တွင်ရှိပါက `wss://` ကို အသုံးပြုပါ။
- Clickjacking ကို ကာကွယ်ရန် `gatewayUrl` ကို top-level window တွင်သာ လက်ခံပါသည် (embed မလုပ်နိုင်)။
- Cross-origin dev setup များ (ဥပမာ `pnpm ui:dev` မှ remote Gateway သို့) အတွက် UI origin ကို
  `gateway.controlUi.allowedOrigins` တွင် ထည့်ပါ။

ဥပမာ:

```json5
{
  gateway: {
    controlUi: {
      allowedOrigins: ["http://localhost:5173"],
    },
  },
}
```

Remote ဝင်ရောက်မှု တပ်ဆင်ခြင်း အသေးစိတ်: [Remote access](/gateway/remote)။
