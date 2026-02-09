---
summary: "Gateway (ချတ်၊ နိုဒ်များ၊ ဖွဲ့စည်းပြင်ဆင်မှု) အတွက် ဘရောက်ဇာအခြေပြု ထိန်းချုပ် UI"
read_when:
  - ဘရောက်ဇာမှ Gateway ကို လည်ပတ်လိုသောအခါ
  - SSH တန်နယ်များ မသုံးဘဲ Tailnet ဝင်ရောက်လိုသောအခါ
title: "Control UI"
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
  Dashboard settings panel တွင် token ကို သိမ်းဆည်းနိုင်သော်လည်း password များကို မသိမ်းဆည်းပါ။
  Onboarding wizard သည် default အနေဖြင့် gateway token ကို ဖန်တီးပေးသောကြောင့် ပထမဆုံး connect လုပ်ချိန်တွင် ဤနေရာတွင် paste လုပ်ပါ။

## စက်ပစ္စည်း ချိတ်ဆက်အတည်ပြုခြင်း (ပထမဆုံး ချိတ်ဆက်မှု)

Browser သို့မဟုတ် device အသစ်တစ်ခုမှ Control UI ကို connect လုပ်သောအခါ Gateway သည် **one-time pairing approval** ကို တောင်းဆိုပါသည် — `gateway.auth.allowTailscale: true` ဖြင့် Tailnet တူနေပါစေ။ ဤသည်မှာ ခွင့်ပြုချက်မရှိသော access ကို တားဆီးရန် လုံခြုံရေး အစီအမံ ဖြစ်ပါသည်။

**မြင်ရမည့်အရာ:** "disconnected (1008): pairing required"

**စက်ပစ္စည်းကို အတည်ပြုရန်:**

```bash
# List pending requests
openclaw devices list

# Approve by request ID
openclaw devices approve <requestId>
```

တစ်ကြိမ် approve လုပ်ပြီးပါက device ကို မှတ်ထားပြီး `openclaw devices revoke --device <id> --role <role>` ဖြင့် revoke မလုပ်မချင်း ထပ်မံ approve လိုအပ်မည် မဟုတ်ပါ။ Token rotation နှင့် revocation အတွက် [Devices CLI](/cli/devices) ကို ကြည့်ပါ။

**မှတ်ချက်များ:**

- Local ချိတ်ဆက်မှုများ (`127.0.0.1`) ကို အလိုအလျောက် အတည်ပြုပါသည်။
- Remote connections (LAN, Tailnet စသည်) ကို explicit approval လိုအပ်ပါသည်။
- ဘရောက်ဇာ ပရိုဖိုင်တစ်ခုစီသည် ထူးခြားသော device ID တစ်ခုကို ဖန်တီးသဖြင့်
  ဘရောက်ဇာ ပြောင်းလဲခြင်း သို့မဟုတ် ဘရောက်ဇာဒေတာ ဖျက်ရှင်းခြင်း ပြုလုပ်ပါက
  ထပ်မံ ချိတ်ဆက်အတည်ပြုရပါမည်။

## ယနေ့ လုပ်ဆောင်နိုင်သည့် အရာများ

- Gateway WS မှတစ်ဆင့် မော်ဒယ်နှင့် ချတ်လုပ်ခြင်း (`chat.history`, `chat.send`, `chat.abort`, `chat.inject`)
- Chat အတွင်း tool calls များကို stream လုပ်ခြင်း + live tool output cards (agent events)
- Channels: WhatsApp/Telegram/Discord/Slack + plugin channels (Mattermost စသည်)။ status + QR login + channel အလိုက် config (`channels.status`, `web.login.*`, `config.patch`)
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

- Isolated jobs များအတွက် delivery သည် default အနေဖြင့် summary ကို ကြေညာပေးပါသည်။ internal-only runs လိုပါက none သို့ ပြောင်းလဲနိုင်ပါသည်။
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

default အနေဖြင့် `gateway.auth.allowTailscale` သည် `true` ဖြစ်ပါက Serve requests များသည် Tailscale identity headers (`tailscale-user-login`) ဖြင့် authentication လုပ်နိုင်ပါသည်။ 1. OpenClaw သည် `x-forwarded-for` လိပ်စာကို `tailscale whois` ဖြင့် resolve လုပ်ပြီး header နှင့် ကိုက်ညီမှုကို စစ်ဆေးကာ၊ Tailscale ၏ `x-forwarded-*` headers ပါရှိသည့် loopback သို့ request ဝင်ရောက်လာသောအခါတွင်သာ လက်ခံပါသည်။ 2. Serve traffic အတွက်တောင် token/password လိုအပ်စေချင်ပါက `gateway.auth.allowTailscale: false` (သို့) `gateway.auth.mode: "password"` ကို force လုပ်ပါ။

### Tailnet သို့ bind လုပ်၍ token သုံးခြင်း

```bash
openclaw gateway --bind tailnet --token "$(openssl rand -hex 32)"
```

ထို့နောက် ဖွင့်ပါ:

- `http://<tailscale-ip>:18789/` (သို့မဟုတ် သင်သတ်မှတ်ထားသော `gateway.controlUi.basePath`)

UI ဆက်တင်များထဲသို့ token ကို ကူးထည့်ပါ (`connect.params.auth.token` အဖြစ် ပို့ဆောင်ပါသည်)။

## Insecure HTTP

3. Dashboard ကို plain HTTP (`http://<lan-ip>` သို့မဟုတ် `http://<tailscale-ip>`) ဖြင့်ဖွင့်ပါက browser သည် **non-secure context** အဖြစ် လည်ပတ်ပြီး WebCrypto ကို ပိတ်ဆို့ပါသည်။ 4. ပုံမှန်အားဖြင့် OpenClaw သည် device identity မပါသော Control UI connections ကို **ပိတ်ဆို့** ပါသည်။

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

5. ဤအရာသည် Control UI အတွက် device identity + pairing ကို (HTTPS ပေါ်တွင်တောင်) ပိတ်ထားပါသည်။ 6. ကွန်ယက်ကို ယုံကြည်နိုင်ပါကသာ အသုံးပြုပါ။

HTTPS တပ်ဆင်ခြင်း လမ်းညွှန်အတွက် [Tailscale](/gateway/tailscale) ကို ကြည့်ပါ။

## UI ကို တည်ဆောက်ခြင်း

7. Gateway သည် static files များကို `dist/control-ui` မှ serve လုပ်ပါသည်။ 8. အောက်ပါအတိုင်း build လုပ်ပါ:

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

9. Control UI သည် static files ဖြစ်ပြီး WebSocket target ကို configure လုပ်နိုင်သဖြင့် HTTP origin နှင့် မတူနိုင်ပါသည်။ 10. Vite dev server ကို local တွင်အသုံးပြုပြီး Gateway ကို အခြားနေရာတွင် run လုပ်လိုသောအခါ အဆင်ပြေပါသည်။

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
- 11. `gatewayUrl` ကို set လုပ်ထားပါက UI သည် config သို့မဟုတ် environment credentials သို့ ပြန်မလှည့်ပါ။
  12. `token` (သို့) `password` ကို ထင်ရှားစွာ ပေးရပါသည်။ 13. ထင်ရှားသော credentials မပါရှိပါက error ဖြစ်ပါသည်။
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
