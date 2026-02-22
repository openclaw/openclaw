---
summary: "OpenClaw Gateway CLI (`openclaw gateway`) — Gateway များကို လည်ပတ်စေခြင်း၊ မေးမြန်းခြင်းနှင့် ရှာဖွေတွေ့ရှိခြင်း"
read_when:
  - CLI မှ Gateway ကို လည်ပတ်စေသောအခါ (dev သို့မဟုတ် ဆာဗာများ)
  - Gateway အတည်ပြုချက်၊ bind မုဒ်များနှင့် ချိတ်ဆက်နိုင်မှုကို ဒီဘဂ်လုပ်နေစဉ်
  - Bonjour (LAN + tailnet) ဖြင့် Gateway များကို ရှာဖွေတွေ့ရှိရာတွင်
title: "gateway"
---

# Gateway CLI

Gateway သည် OpenClaw ၏ WebSocket ဆာဗာဖြစ်သည် (ချန်နယ်များ၊ နိုဒ်များ၊ ဆက်ရှင်များ၊ ဟုခ်များ)။

ဤစာမျက်နှာရှိ အောက်ခံ subcommand များသည် `openclaw gateway …` အောက်တွင် တည်ရှိသည်။

ဆက်စပ် စာရွက်စာတမ်းများ:

- [/gateway/bonjour](/gateway/bonjour)
- [/gateway/discovery](/gateway/discovery)
- [/gateway/configuration](/gateway/configuration)

## Gateway ကို လည်ပတ်စေခြင်း

ဒေသတွင်း Gateway လုပ်ငန်းစဉ်ကို လည်ပတ်စေပါ:

```bash
openclaw gateway
```

Foreground အမည်အစားထိုး:

```bash
openclaw gateway run
```

မှတ်ချက်များ:

- default အနေဖြင့် `~/.openclaw/openclaw.json` ထဲတွင် `gateway.mode=local` ကို သတ်မှတ်ထားခြင်း မရှိပါက Gateway သည် start မလုပ်ပါ။ ad-hoc/dev run များအတွက် `--allow-unconfigured` ကို အသုံးပြုပါ။
- အတည်ပြုချက်မရှိဘဲ loopback အပြင်ဘက်သို့ bind လုပ်ခြင်းကို ပိတ်ထားသည် (လုံခြုံရေး ကာကွယ်တားဆီးချက်)။
- `SIGUSR1` သည် အတည်ပြုထားပါက လုပ်ငန်းစဉ်အတွင်း ပြန်လည်စတင်မှုကို ဖြစ်စေသည် (`commands.restart` ကို ဖွင့်ပါ သို့မဟုတ် gateway tool/config apply/update ကို အသုံးပြုပါ)။
- `SIGINT`/`SIGTERM` handler များသည် gateway process ကို ရပ်တန့်စေသော်လည်း custom terminal state ကို ပြန်လည်မထူထောင်ပါ။ CLI ကို TUI သို့မဟုတ် raw-mode input ဖြင့် wrap လုပ်ထားပါက exit မလုပ်မီ terminal ကို ပြန်လည် restore လုပ်ပါ။

### ရွေးချယ်စရာများ

- `--port <port>`: WebSocket ပေါ့တ် (မူလတန်ဖိုးသည် config/env မှ လာသည်; များသောအားဖြင့် `18789`)။
- `--bind <loopback|lan|tailnet|auto|custom>`: listener bind မုဒ်။
- `--auth <token|password>`: auth မုဒ် override။
- `--token <token>`: token override (လုပ်ငန်းစဉ်အတွက် `OPENCLAW_GATEWAY_TOKEN` ကိုလည်း သတ်မှတ်ပေးသည်)။
- `--password <password>`: password override (လုပ်ငန်းစဉ်အတွက် `OPENCLAW_GATEWAY_PASSWORD` ကိုလည်း သတ်မှတ်ပေးသည်)။
- `--tailscale <off|serve|funnel>`: Gateway ကို Tailscale မှတဆင့် ထုတ်ဖော်ပြသခြင်း။
- `--tailscale-reset-on-exit`: ပိတ်ချိန်တွင် Tailscale serve/funnel config ကို ပြန်လည်သတ်မှတ်ခြင်း။
- `--allow-unconfigured`: config တွင် `gateway.mode=local` မရှိဘဲ gateway စတင်နိုင်ရန် ခွင့်ပြုခြင်း။
- `--dev`: မရှိပါက dev config + workspace ကို ဖန်တီးခြင်း (BOOTSTRAP.md ကို ကျော်လွှားသည်)။
- `--reset`: dev config + credentials + sessions + workspace ကို ပြန်လည်သတ်မှတ်ခြင်း (`--dev` လိုအပ်သည်)။
- `--force`: စတင်မလုပ်မီ ရွေးထားသော ပေါ့တ်ပေါ်ရှိ ရှိပြီးသား listener မည်သည့်အရာမဆို ဖျက်သိမ်းခြင်း။
- `--verbose`: အသေးစိတ် log များ။
- `--claude-cli-logs`: console တွင် claude-cli log များသာ ပြသရန် (၎င်း၏ stdout/stderr ကိုလည်း ဖွင့်ပေးသည်)။
- `--ws-log <auto|full|compact>`: websocket log စတိုင် (မူလ `auto`)။
- `--compact`: `--ws-log compact` အတွက် alias။
- `--raw-stream`: မော်ဒယ် raw stream ဖြစ်ရပ်များကို jsonl သို့ log လုပ်ခြင်း။
- `--raw-stream-path <path>`: raw stream jsonl လမ်းကြောင်း။

## လည်ပတ်နေသော Gateway ကို မေးမြန်းခြင်း

မေးမြန်းမှု command အားလုံးသည် WebSocket RPC ကို အသုံးပြုသည်။

ထုတ်လွှင့်ပုံစံများ:

- မူလ: လူဖတ်ရလွယ်ကူသောပုံစံ (TTY တွင် အရောင်ပါ)။
- `--json`: စက်ဖတ်နိုင်သော JSON (styling/spinner မပါ)။
- `--no-color` (သို့မဟုတ် `NO_COLOR=1`): လူဖတ်ပုံစံကို ထိန်းထားပြီး ANSI ကို ပိတ်ခြင်း။

မျှဝေထားသော ရွေးချယ်စရာများ (ထောက်ပံ့ထားသည့်နေရာများတွင်):

- `--url <url>`: Gateway WebSocket URL။
- `--token <token>`: Gateway token။
- `--password <password>`: Gateway password။
- `--timeout <ms>`: timeout/budget (command အလိုက် ကွာခြားသည်)။
- `--expect-final`: “final” တုံ့ပြန်မှုကို စောင့်ဆိုင်းခြင်း (agent ခေါ်ယူမှုများ)။

မှတ်ချက်: `--url` ကို သတ်မှတ်ထားပါက CLI သည် config သို့မဟုတ် environment credentials များကို fallback မလုပ်ပါ။
`--token` သို့မဟုတ် `--password` ကို တိတိကျကျ ပေးပါ။ credential ကို တိတိကျကျ မပေးထားပါက error ဖြစ်ပါသည်။

### `gateway health`

```bash
openclaw gateway health --url ws://127.0.0.1:18789
```

### `gateway status`

`gateway status` သည် Gateway ဝန်ဆောင်မှု (launchd/systemd/schtasks) ကို ပြသပြီး RPC probe ကို ရွေးချယ်အသုံးပြုနိုင်ပါသည်။

```bash
openclaw gateway status
openclaw gateway status --json
```

ရွေးချယ်စရာများ:

- `--url <url>`: probe URL ကို override လုပ်ခြင်း။
- `--token <token>`: probe အတွက် token auth။
- `--password <password>`: probe အတွက် password auth။
- `--timeout <ms>`: probe timeout (မူလ `10000`)။
- `--no-probe`: RPC probe ကို ကျော်လွှားခြင်း (ဝန်ဆောင်မှုသာ ပြသ)။
- `--deep`: စနစ်အဆင့် ဝန်ဆောင်မှုများကိုပါ scan လုပ်ခြင်း။

### `gateway probe`

`gateway probe` သည် “debug everything” command ဖြစ်ပါသည်။ အမြဲတမ်း probe လုပ်သည်မှာ:

- သင့် config တွင် သတ်မှတ်ထားသော remote gateway (ရှိပါက) နှင့်
- localhost (loopback) ကို **remote ကို သတ်မှတ်ထားသော်လည်း** probe လုပ်ပါသည်။

gateway အများအပြား ရောက်ရှိနိုင်ပါက အားလုံးကို print ထုတ်ပေးပါသည်။ isolated profiles/ports (ဥပမာ rescue bot) ကို အသုံးပြုပါက gateway အများအပြားကို ထောက်ပံ့ပေးသော်လည်း install အများစုတွင် gateway တစ်ခုတည်းသာ run လုပ်နေဆဲဖြစ်သည်။

```bash
openclaw gateway probe
openclaw gateway probe --json
```

#### SSH ဖြင့် အဝေးမှချိတ်ဆက်ခြင်း (Mac app နှိုင်းယှဉ်မှု)

macOS app ၏ “Remote over SSH” မုဒ်သည် local port-forward ကို အသုံးပြုသဖြင့် (loopback သာ bind လုပ်ထားနိုင်သော) remote gateway ကို `ws://127.0.0.1:<port>` တွင် ချိတ်ဆက်နိုင်စေပါသည်။

CLI နှင့်ညီမျှသော အမိန့်:

```bash
openclaw gateway probe --ssh user@gateway-host
```

ရွေးချယ်စရာများ:

- `--ssh <target>`: `user@host` သို့မဟုတ် `user@host:port` (ပေါ့တ် မူလတန်ဖိုး `22`)။
- `--ssh-identity <path>`: identity ဖိုင်။
- `--ssh-auto`: ရှာဖွေတွေ့ရှိသော ပထမဆုံး Gateway ဟို့စ်ကို SSH ပစ်မှတ်အဖြစ် ရွေးချယ်ခြင်း (LAN/WAB သာ)။

Config (မဖြစ်မနေမဟုတ်၊ မူလတန်ဖိုးများအဖြစ် အသုံးပြုသည်):

- `gateway.remote.sshTarget`
- `gateway.remote.sshIdentity`

### `gateway call <method>`

အဆင့်နိမ့် RPC အကူအညီကိရိယာ။

```bash
openclaw gateway call status
openclaw gateway call logs.tail --params '{"sinceMs": 60000}'
```

## Gateway ဝန်ဆောင်မှုကို စီမံခန့်ခွဲခြင်း

```bash
openclaw gateway install
openclaw gateway start
openclaw gateway stop
openclaw gateway restart
openclaw gateway uninstall
```

မှတ်ချက်များ:

- `gateway install` သည် `--port`, `--runtime`, `--token`, `--force`, `--json` ကို ထောက်ပံ့ပါသည်။
- Lifecycle command များသည် scripting အတွက် `--json` ကို လက်ခံပါသည်။

## Gateway များကို ရှာဖွေတွေ့ရှိခြင်း (Bonjour)

`gateway discover` သည် Gateway beacon များ (`_openclaw-gw._tcp`) ကို scan လုပ်ပါသည်။

- Multicast DNS-SD: `local.`
- Unicast DNS-SD (Wide-Area Bonjour): domain တစ်ခုကို ရွေးချယ်ပါ (ဥပမာ: `openclaw.internal.`) နှင့် split DNS + DNS server ကို စီစဉ်ပါ; [/gateway/bonjour](/gateway/bonjour) ကို ကြည့်ပါ

Bonjour discovery ကို ဖွင့်ထားသော Gateway များ (မူလအနေဖြင့် ဖွင့်ထားသည်) သာ beacon ကို ကြော်ငြာပါသည်။

Wide-Area discovery မှတ်တမ်းများတွင် (TXT) ပါဝင်သည်များ—

- `role` (gateway အခန်းကဏ္ဍ အညွှန်း)
- `transport` (transport အညွှန်း၊ ဥပမာ `gateway`)
- `gatewayPort` (WebSocket ပေါ့တ်၊ များသောအားဖြင့် `18789`)
- `sshPort` (SSH ပေါ့တ်; မပါရှိပါက မူလ `22`)
- `tailnetDns` (ရရှိနိုင်ပါက MagicDNS ဟို့စ်အမည်)
- `gatewayTls` / `gatewayTlsSha256` (TLS ဖွင့်ထားမှု + cert fingerprint)
- `cliPath` (remote ထည့်သွင်းမှုများအတွက် ရွေးချယ်နိုင်သော အညွှန်း)

### `gateway discover`

```bash
openclaw gateway discover
```

ရွေးချယ်စရာများ:

- `--timeout <ms>`: command တစ်ခုချင်းစီအလိုက် timeout (browse/resolve); မူလ `2000`။
- `--json`: စက်ဖတ်နိုင်သော ထုတ်လွှင့်မှု (styling/spinner ကိုလည်း ပိတ်သည်)။

ဥပမာများ:

```bash
openclaw gateway discover --timeout 4000
openclaw gateway discover --json | jq '.beacons[].wsUrl'
```
