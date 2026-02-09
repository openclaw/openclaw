---
summary: "Gateway ဝန်ဆောင်မှု၊ အသက်တာလည်ပတ်မှုနှင့် လည်ပတ်ရေးဆိုင်ရာ Runbook"
read_when:
  - Gateway လုပ်ငန်းစဉ်ကို လည်ပတ်နေစဉ် သို့မဟုတ် ပြဿနာရှာဖွေနေစဉ်
title: "Gateway Runbook"
---

# Gateway ဝန်ဆောင်မှု Runbook

နောက်ဆုံး ပြင်ဆင်သည့်ရက်စွဲ: 2025-12-09

## အရာသည် ဘာလဲ

- တစ်ချိန်လုံး လည်ပတ်နေပြီး Baileys/Telegram ချိတ်ဆက်မှု တစ်ခုတည်းနှင့် control/event plane ကို ကိုင်တွယ်ထားသော လုပ်ငန်းစဉ်။
- Replaces the legacy `gateway` command. CLI entry point: `openclaw gateway`.
- ရပ်တန့်သည့်အချိန်အထိ လည်ပတ်နေပြီး အရေးကြီးသော အမှားများ ဖြစ်ပါက non-zero ဖြင့် ထွက်သွားကာ supervisor က ပြန်လည်စတင်စေသည်။

## ဘယ်လို လည်ပတ်မလဲ (local)

```bash
openclaw gateway --port 18789
# for full debug/trace logs in stdio:
openclaw gateway --port 18789 --verbose
# if the port is busy, terminate listeners then start:
openclaw gateway --force
# dev loop (auto-reload on TS changes):
pnpm gateway:watch
```

- Config hot reload သည် `~/.openclaw/openclaw.json` (သို့မဟုတ် `OPENCLAW_CONFIG_PATH`) ကို စောင့်ကြည့်နေသည်။
  - မူလ mode: `gateway.reload.mode="hybrid"` (လုံခြုံသော ပြောင်းလဲမှုများကို ချက်ချင်းသက်ရောက်စေပြီး အရေးကြီးသောအခါ ပြန်စတင်)။
  - Hot reload သည် လိုအပ်သည့်အခါ **SIGUSR1** ဖြင့် in-process restart ကို အသုံးပြုသည်။
  - `gateway.reload.mode="off"` ဖြင့် ပိတ်နိုင်သည်။
- WebSocket control plane ကို `127.0.0.1:<port>` (မူလ 18789) တွင် bind လုပ်သည်။
- The same port also serves HTTP (control UI, hooks, A2UI). Single-port multiplex။
  - OpenAI Chat Completions (HTTP): [`/v1/chat/completions`](/gateway/openai-http-api)။
  - OpenResponses (HTTP): [`/v1/responses`](/gateway/openresponses-http-api)။
  - Tools Invoke (HTTP): [`/tools/invoke`](/gateway/tools-invoke-http-api)။
- Starts a Canvas file server by default on `canvasHost.port` (default `18793`), serving `http://<gateway-host>:18793/__openclaw__/canvas/` from `~/.openclaw/workspace/canvas`. `canvasHost.enabled=false` သို့မဟုတ် `OPENCLAW_SKIP_CANVAS_HOST=1` ဖြင့် ပိတ်နိုင်သည်။
- stdout သို့ logs ထုတ်သည်။ launchd/systemd ကို အသုံးပြု၍ အသက်ရှင်စေပြီး log များကို လှည့်ပတ်သိမ်းဆည်းပါ။
- ပြဿနာရှာဖွေနေစဉ် `--verbose` ကို အသုံးပြု၍ log ဖိုင်မှ debug logging (handshakes, req/res, events) ကို stdio သို့ ပြန်လည်ထုတ်ပြနိုင်သည်။
- `--force` သည် ရွေးချယ်ထားသော port ပေါ်ရှိ listener များကို `lsof` ဖြင့် ရှာဖွေပြီး SIGTERM ပို့ကာ သတ်ခဲ့သည့်အရာများကို log လုပ်ပြီးနောက် gateway ကို စတင်သည် (`lsof` မရှိပါက ချက်ချင်း မအောင်မြင်ပါ)။
- supervisor (launchd/systemd/mac app child-process mode) အောက်တွင် လည်ပတ်ပါက ရပ်တန့်/ပြန်စတင်ခြင်းသည် ပုံမှန်အားဖြင့် **SIGTERM** ပို့သည်။ အဟောင်း build များတွင် `pnpm` `ELIFECYCLE` exit code **143** (SIGTERM) အဖြစ် ပြသနိုင်ပြီး ၎င်းသည် ပုံမှန် shutdown ဖြစ်သည်၊ crash မဟုတ်ပါ။
- **SIGUSR1** သည် ခွင့်ပြုထားသည့်အခါ in-process restart ကို လှုံ့ဆော်သည် (gateway tool/config apply/update သို့မဟုတ် လက်ဖြင့် restart အတွက် `commands.restart` ကို ဖွင့်ပါ)။
- Gateway auth is required by default: set `gateway.auth.token` (or `OPENCLAW_GATEWAY_TOKEN`) or `gateway.auth.password`. Clients must send `connect.params.auth.token/password` unless using Tailscale Serve identity.
- wizard သည် loopback ပေါ်တွင်ပင် token ကို မူလအားဖြင့် ထုတ်ပေးပါသည်။
- Port ဦးစားပေးမှု: `--port` > `OPENCLAW_GATEWAY_PORT` > `gateway.port` > မူလ `18789`။

## Remote access

- Tailscale/VPN ကို ဦးစားပေးပါ၊ မဟုတ်ပါက SSH tunnel ကို အသုံးပြုပါ။

  ```bash
  ssh -N -L 18789:127.0.0.1:18789 user@host
  ```

- ထို့နောက် clients များသည် tunnel မှတစ်ဆင့် `ws://127.0.0.1:18789` သို့ ချိတ်ဆက်သည်။

- token ကို သတ်မှတ်ထားပါက tunnel ဖြင့်ပင် `connect.params.auth.token` တွင် ထည့်သွင်းရမည်။

## Gateway အများအပြား (တူညီသော host)

ပုံမှန်အားဖြင့် မလိုအပ်ပါ: Gateway တစ်ခုတည်းဖြင့် messaging channel များနှင့် agent များကို များစွာ ဝန်ဆောင်မှုပေးနိုင်ပါသည်။ Use multiple Gateways only for redundancy or strict isolation (ex: rescue bot).

State + config ကို ခွဲထုတ်ပြီး unique ports များ အသုံးပြုပါက ထောက်ပံ့ထားပါသည်။ Full guide: [Multiple gateways](/gateway/multiple-gateways).

Service အမည်များသည် profile ကို သိရှိထားသည်။

- macOS: `bot.molt.<profile>` (legacy `com.openclaw.*` may still exist)
- Linux: `openclaw-gateway-<profile>.service`
- Windows: `OpenClaw Gateway (<profile>)`

Install metadata ကို service config အတွင်းတွင် ထည့်သွင်းထားသည်။

- `OPENCLAW_SERVICE_MARKER=openclaw`
- `OPENCLAW_SERVICE_KIND=gateway`
- `OPENCLAW_SERVICE_VERSION=<version>`

Rescue-Bot Pattern: keep a second Gateway isolated with its own profile, state dir, workspace, and base port spacing. လမ်းညွှန်အပြည့်အစုံ: [Rescue-bot guide](/gateway/multiple-gateways#rescue-bot-guide)။

### Dev profile (`--dev`)

အမြန်လမ်းကြောင်း: သင်၏ အဓိက setup ကို မထိခိုက်စေဘဲ (config/state/workspace) ကို လုံးဝခွဲခြားထားသော dev instance ကို လည်ပတ်ပါ။

```bash
openclaw --dev setup
openclaw --dev gateway --allow-unconfigured
# then target the dev instance:
openclaw --dev status
openclaw --dev health
```

မူလတန်ဖိုးများ (env/flags/config ဖြင့် ပြန်လည်သတ်မှတ်နိုင်သည်)။

- `OPENCLAW_STATE_DIR=~/.openclaw-dev`
- `OPENCLAW_CONFIG_PATH=~/.openclaw-dev/openclaw.json`
- `OPENCLAW_GATEWAY_PORT=19001` (Gateway WS + HTTP)
- browser control service port = `19003` (derived: `gateway.port+2`, loopback only)
- `canvasHost.port=19005` (derived: `gateway.port+4`)
- `agents.defaults.workspace` သည် `--dev` အောက်တွင် `setup`/`onboard` ကို လည်ပတ်ပါက မူလအားဖြင့် `~/.openclaw/workspace-dev` ဖြစ်လာသည်။

Derived ports (အတွေ့အကြုံအခြေခံ စည်းမျဉ်းများ)။

- Base port = `gateway.port` (သို့မဟုတ် `OPENCLAW_GATEWAY_PORT` / `--port`)
- browser control service port = base + 2 (loopback only)
- `canvasHost.port = base + 4` (သို့မဟုတ် `OPENCLAW_CANVAS_HOST_PORT` / config override)
- Browser profile CDP ports auto-allocate from `browser.controlPort + 9 .. + 108` (persisted per profile).

Instance တစ်ခုစီအတွက် စစ်ဆေးစာရင်း။

- unique `gateway.port`
- unique `OPENCLAW_CONFIG_PATH`
- unique `OPENCLAW_STATE_DIR`
- unique `agents.defaults.workspace`
- WhatsApp ကို အသုံးပြုပါက သီးခြား WhatsApp နံပါတ်များ

Profile တစ်ခုချင်းစီအတွက် service install။

```bash
openclaw --profile main gateway install
openclaw --profile rescue gateway install
```

ဥပမာ။

```bash
OPENCLAW_CONFIG_PATH=~/.openclaw/a.json OPENCLAW_STATE_DIR=~/.openclaw-a openclaw gateway --port 19001
OPENCLAW_CONFIG_PATH=~/.openclaw/b.json OPENCLAW_STATE_DIR=~/.openclaw-b openclaw gateway --port 19002
```

## Protocol (operator မြင်ကွင်း)

- စာရွက်စာတမ်း အပြည့်အစုံ: [Gateway protocol](/gateway/protocol) နှင့် [Bridge protocol (legacy)](/gateway/bridge-protocol)။
- Mandatory first frame from client: `req {type:"req", id, method:"connect", params:{minProtocol,maxProtocol,client:{id,displayName?,version,platform,deviceFamily?,modelIdentifier?,mode,instanceId?}, caps, auth?, locale?, userAgent? } }`.
- Gateway သည် `res {type:"res", id, ok:true, payload:hello-ok }` ဖြင့် ပြန်ကြားသည် (သို့မဟုတ် အမှားဖြစ်ပါက `ok:false` ပြန်ပြီး ပိတ်သည်)။
- handshake ပြီးနောက်:
  - Requests: `{type:"req", id, method, params}` → `{type:"res", id, ok, payload|error}`
  - Events: `{type:"event", event, payload, seq?, stateVersion?}`
- Structured presence entries: `{host, ip, version, platform?, deviceFamily?, modelIdentifier?, mode, lastInputSeconds?, ts, reason?, tags?[], instanceId? }` (for WS clients, `instanceId` comes from `connect.client.instanceId`).
- `agent` responses များသည် အဆင့်နှစ်ဆင့်ရှိသည်။ ပထမအဆင့် `res` ack `{runId,status:"accepted"}`၊ ထို့နောက် run ပြီးဆုံးသည့်အခါ နောက်ဆုံး `res` `{runId,status:"ok"|"error",summary}` ပေးပို့သည်။ streamed output ကို `event:"agent"` အဖြစ် လက်ခံရရှိသည်။

## Methods (အစပိုင်း အစု)

- `health` — health snapshot အပြည့်အစုံ (`openclaw health --json` နှင့် တူညီသော ပုံစံ)။
- `status` — အကျဉ်းချုပ်။
- `system-presence` — လက်ရှိ presence စာရင်း။
- `system-event` — presence/system note တင်ပို့ခြင်း (structured)။
- `send` — လက်ရှိ channel(များ) မှတစ်ဆင့် မက်ဆေ့ချ် ပို့ခြင်း။
- `agent` — agent turn ကို လည်ပတ်ခြင်း (တူညီသော ချိတ်ဆက်မှုတွင် events များကို stream ပြန်ပို့သည်)။
- `node.list` — paired + လက်ရှိချိတ်ဆက်ထားသော nodes များကို စာရင်းပြုစုခြင်း (`caps`, `deviceFamily`, `modelIdentifier`, `paired`, `connected`, နှင့် ကြော်ငြာထားသော `commands` ပါဝင်သည်)။
- `node.describe` — node တစ်ခုကို ဖော်ပြခြင်း (စွမ်းဆောင်ရည်များ + ထောက်ပံ့ထားသော `node.invoke` commands; paired nodes နှင့် လက်ရှိချိတ်ဆက်ထားသော်လည်း မpaired ဖြစ်သေးသော nodes များအတွက်လည်း အသုံးပြုနိုင်သည်)။
- `node.invoke` — node ပေါ်တွင် command တစ်ခုကို invoke လုပ်ခြင်း (ဥပမာ `canvas.*`, `camera.*`)။
- `node.pair.*` — pairing lifecycle (`request`, `list`, `approve`, `reject`, `verify`)။

Presence ကို ဘယ်လို ထုတ်လုပ်/ထပ်မတူအောင် ပြုလုပ်သလဲနှင့် တည်ငြိမ်သော `client.instanceId` အရေးကြီးရခြင်းအကြောင်းကို [Presence](/concepts/presence) တွင် ကြည့်ပါ။

## Events

- `agent` — agent run မှ streamed tool/output events (seq-tagged)။
- `presence` — presence updates (stateVersion ပါသော deltas) ကို ချိတ်ဆက်ထားသော clients အားလုံးသို့ ပို့သည်။
- `tick` — liveness ကို အတည်ပြုရန် periodic keepalive/no-op။
- `shutdown` — Gateway is exiting; payload includes `reason` and optional `restartExpectedMs`. Clients should reconnect.

## WebChat ပေါင်းစည်းခြင်း

- WebChat သည် Gateway WebSocket နှင့် တိုက်ရိုက် ဆက်သွယ်သည့် native SwiftUI UI ဖြစ်ပြီး history၊ sends၊ abort နှင့် events များကို ကိုင်တွယ်သည်။
- Remote အသုံးပြုခြင်းသည် တူညီသော SSH/Tailscale tunnel ကို အသုံးပြုသည်။ gateway token ကို သတ်မှတ်ထားပါက `connect` အတွင်း client က ထည့်သွင်းပို့ရမည်။
- macOS app သည် WS တစ်ခုတည်းဖြင့် ချိတ်ဆက်ပြီး presence ကို initial snapshot မှ hydrate လုပ်ကာ UI ကို update လုပ်ရန် `presence` events များကို နားထောင်သည်။

## Typing နှင့် validation

- Server သည် inbound frame တစ်ခုချင်းစီကို protocol definitions မှ ထုတ်လုပ်ထားသော JSON Schema နှင့် AJV ဖြင့် စစ်ဆေးသည်။
- Clients (TS/Swift) များသည် generate လုပ်ထားသော types များကို အသုံးပြုသည် (TS သည် တိုက်ရိုက်၊ Swift သည် repo ၏ generator မှတစ်ဆင့်)။
- Protocol definitions များသည် source of truth ဖြစ်သည်။ schema/models များကို ပြန်လည် generate လုပ်ရန်:
  - `pnpm protocol:gen`
  - `pnpm protocol:gen:swift`

## Connection snapshot

- `hello-ok` တွင် `snapshot` ပါဝင်ပြီး `presence`, `health`, `stateVersion`, `uptimeMs` နှင့် `policy {maxPayload,maxBufferedBytes,tickIntervalMs}` ပါရှိသဖြင့် clients များသည် ထပ်မံ request မလိုဘဲ ချက်ချင်း render လုပ်နိုင်သည်။
- `health`/`system-presence` များကို လက်ဖြင့် refresh အတွက် ဆက်လက်အသုံးပြုနိုင်သော်လည်း connect လုပ်ချိန်တွင် မလိုအပ်ပါ။

## Error codes (res.error ပုံစံ)

- Errors use `{ code, message, details?, retryable?, retryAfterMs? }`.
- စံ error codes:
  - `NOT_LINKED` — WhatsApp authentication မလုပ်ရသေးပါ။
  - `AGENT_TIMEOUT` — agent သည် သတ်မှတ်ထားသော အချိန်အကန့်အသတ်အတွင်း မတုံ့ပြန်ပါ။
  - `INVALID_REQUEST` — schema/param validation မအောင်မြင်ပါ။
  - `UNAVAILABLE` — Gateway ပိတ်သိမ်းနေသည် သို့မဟုတ် dependency တစ်ခု မရရှိနိုင်ပါ။

## Keepalive အပြုအမူ

- `tick` events (သို့မဟုတ် WS ping/pong) များကို အချိန်အလိုက် ထုတ်ပေး၍ traffic မရှိသည့်အခါတွင်ပင် Gateway အသက်ရှင်နေကြောင်း clients များ သိရှိစေသည်။
- Send/agent acknowledgements များကို သီးခြား responses အဖြစ် ဆက်လက်ပို့ပေးထားရမည်။ ticks များကို sends အတွက် မလွန်ကဲစေပါနှင့်။

## Replay / gaps

- Events are not replayed. Clients detect seq gaps and should refresh (`health` + `system-presence`) before continuing. WebChat and macOS clients now auto-refresh on gap.

## Supervision (macOS ဥပမာ)

- ဝန်ဆောင်မှုကို အသက်ရှင်စေဖို့ launchd ကို အသုံးပြုပါ။
  - Program: `openclaw` သို့ လမ်းကြောင်း
  - Arguments: `gateway`
  - KeepAlive: true
  - StandardOut/Err: ဖိုင်လမ်းကြောင်းများ သို့မဟုတ် `syslog`
- မအောင်မြင်ပါက launchd သည် ပြန်လည်စတင်မည်။ အရေးကြီးသော misconfig ဖြစ်ပါက ဆက်လက် ထွက်သွားနေစေ၍ operator သတိပြုနိုင်စေပါ။
- LaunchAgents များသည် user တစ်ဦးချင်းစီအလိုက် ဖြစ်ပြီး login session လိုအပ်သည်။ headless setup များအတွက် custom LaunchDaemon ကို အသုံးပြုပါ (မပါဝင်ပို့ဆောင်ထားပါ)။
  - `openclaw gateway install` writes `~/Library/LaunchAgents/bot.molt.gateway.plist`
    (or `bot.molt.<profile>.plist`; legacy `com.openclaw.*` is cleaned up).
  - `openclaw doctor` သည် LaunchAgent config ကို audit လုပ်ပြီး လက်ရှိ မူလအကြံပြုတန်ဖိုးများသို့ update လုပ်နိုင်သည်။

## Gateway ဝန်ဆောင်မှု စီမံခန့်ခွဲမှု (CLI)

Install/start/stop/restart/status အတွက် Gateway CLI ကို အသုံးပြုပါ။

```bash
openclaw gateway status
openclaw gateway install
openclaw gateway stop
openclaw gateway restart
openclaw logs --follow
```

မှတ်ချက်များ။

- `gateway status` သည် service ၏ resolved port/config ကို အသုံးပြု၍ Gateway RPC ကို မူလအားဖြင့် probe လုပ်သည် (`--url` ဖြင့် override လုပ်နိုင်သည်)။
- `gateway status --deep` သည် system-level scans (LaunchDaemons/system units) ကို ထည့်သွင်းသည်။
- `gateway status --no-probe` သည် RPC probe ကို ကျော်လွှားသည် (network မရရှိသည့်အခါ အသုံးဝင်သည်)။
- `gateway status --json` သည် scripts အတွက် တည်ငြိမ်သည်။
- `gateway status` သည် **supervisor runtime** (launchd/systemd လည်ပတ်နေခြင်း) ကို **RPC reachability** (WS connect + status RPC) နှင့် ခွဲခြား၍ အစီရင်ခံသည်။
- `gateway status` သည် “localhost vs LAN bind” ရောယှက်မှုနှင့် profile မကိုက်ညီမှုများကို ရှောင်ရှားရန် config path + probe target ကို ပုံနှိပ်ပြသည်။
- `gateway status` သည် service လည်ပတ်နေသလို တွေ့ရသော်လည်း port ပိတ်ထားပါက နောက်ဆုံး gateway error line ကို ထည့်သွင်းပြသသည်။
- `logs` သည် RPC မှတစ်ဆင့် Gateway file log ကို tail လုပ်ပေးသည် (လက်ဖြင့် `tail`/`grep` မလိုအပ်ပါ)။
- If other gateway-like services are detected, the CLI warns unless they are OpenClaw profile services.
  We still recommend **one gateway per machine** for most setups; use isolated profiles/ports for redundancy or a rescue bot. See [Multiple gateways](/gateway/multiple-gateways).
  - Cleanup: `openclaw gateway uninstall` (လက်ရှိ service) နှင့် `openclaw doctor` (legacy migrations)။
- `gateway install` သည် ထည့်သွင်းပြီးသားဖြစ်ပါက no-op ဖြစ်သည်။ ပြန်လည်ထည့်သွင်းရန် `openclaw gateway install --force` ကို အသုံးပြုပါ (profile/env/path ပြောင်းလဲမှုများ)။

Bundled mac app။

- OpenClaw.app သည် Node-based gateway relay ကို bundle လုပ်နိုင်ပြီး per-user LaunchAgent ကို `bot.molt.gateway` (သို့မဟုတ် `bot.molt.<profile>` အမည်ဖြင့်) တပ်ဆင်နိုင်ပါသည်။`; legacy `com.openclaw.\*\` labels still unload cleanly).
- သန့်ရှင်းစွာ ရပ်တန့်ရန် `openclaw gateway stop` (သို့မဟုတ် `launchctl bootout gui/$UID/bot.molt.gateway`) ကို အသုံးပြုပါ။
- ပြန်လည်စတင်ရန် `openclaw gateway restart` (သို့မဟုတ် `launchctl kickstart -k gui/$UID/bot.molt.gateway`) ကို အသုံးပြုပါ။
  - `launchctl` သည် LaunchAgent ထည့်သွင်းထားပါကသာ အလုပ်လုပ်သည်။ မရှိပါက ပထမဦးစွာ `openclaw gateway install` ကို အသုံးပြုပါ။
  - Replace the label with `bot.molt.<profile>` when running a named profile.

## Supervision (systemd user unit)

OpenClaw installs a **systemd user service** by default on Linux/WSL2. We
recommend user services for single-user machines (simpler env, per-user config).
Use a **system service** for multi-user or always-on servers (no lingering
required, shared supervision).

`openclaw gateway install` writes the user unit. `openclaw doctor` သည် ယူနစ်ကို စစ်ဆေးပြီး လက်ရှိအကြံပြုထားသော မူလသတ်မှတ်ချက်များနှင့် ကိုက်ညီအောင် အပ်ဒိတ်လုပ်နိုင်သည်။

`~/.config/systemd/user/openclaw-gateway[-<profile>].service` ကို ဖန်တီးပါ။

```
[Unit]
Description=OpenClaw Gateway (profile: <profile>, v<version>)
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/usr/local/bin/openclaw gateway --port 18789
Restart=always
RestartSec=5
Environment=OPENCLAW_GATEWAY_TOKEN=
WorkingDirectory=/home/youruser

[Install]
WantedBy=default.target
```

Logout/idle ဖြစ်ပါက user service ဆက်လက်လည်ပတ်နိုင်ရန် lingering ကို ဖွင့်ပါ (လိုအပ်သည်)။

```
sudo loginctl enable-linger youruser
```

Onboarding သည် Linux/WSL2 ပေါ်တွင် ဤအရာကို လည်ပတ်စေသည် (sudo ကို မေးနိုင်ပြီး `/var/lib/systemd/linger` ကို ရေးသားမည်)။
ထို့နောက် ဝန်ဆောင်မှုကို ဖွင့်ပါ:

```
systemctl --user enable --now openclaw-gateway[-<profile>].service
```

**အခြားရွေးချယ်စရာ (system service)** - အမြဲဖွင့်ထားရသော သို့မဟုတ် multi-user ဆာဗာများအတွက် user unit အစား systemd **system** unit ကို တပ်ဆင်နိုင်သည် (lingering မလိုအပ်)။
`/etc/systemd/system/openclaw-gateway[-<profile>].service` ကို ဖန်တီးပါ (အပေါ်ရှိ unit ကို မိတ္တူကူး၍ `WantedBy=multi-user.target` သို့ ပြောင်းပြီး `User=` နှင့် `WorkingDirectory=` ကို သတ်မှတ်ပါ)၊ ထို့နောက်:

```
sudo systemctl daemon-reload
sudo systemctl enable --now openclaw-gateway[-<profile>].service
```

## Windows (WSL2)

Windows တွင် ထည့်သွင်းပါက **WSL2** ကို အသုံးပြုပြီး အထက်ပါ Linux systemd အပိုင်းကို လိုက်နာပါ။

## Operational checks

- Liveness: WS ကို ဖွင့်ပြီး `req:connect` ပို့ပါ → `res` နှင့် `payload.type="hello-ok"` (snapshot ပါ) ကို မျှော်လင့်ပါ။
- Readiness: `health` ကို ခေါ်ပါ → `ok: true` နှင့် `linkChannel` တွင် ချိတ်ဆက်ထားသော channel ကို မျှော်လင့်ပါ (လိုအပ်သည့်အခါ)။
- Debug: `tick` နှင့် `presence` events များကို subscribe လုပ်ပါ။ `status` တွင် linked/auth age ကို ပြသကြောင်း သေချာစေပါ။ presence entries များတွင် Gateway ဟို့စ် နှင့် ချိတ်ဆက်ထားသော clients များကို ပြသရမည်။

## Safety guarantees

- မူလအားဖြင့် ဟို့စ် တစ်ခုလျှင် Gateway တစ်ခုသာ သတ်မှတ်ပါ။ profiles အများအပြားကို လည်ပတ်ပါက ports/state ကို ခွဲခြားပြီး မှန်ကန်သော instance ကို ရည်ညွှန်းပါ။
- direct Baileys ချိတ်ဆက်မှုသို့ fallback မရှိပါ။ Gateway မရှိပါက send များသည် ချက်ချင်း မအောင်မြင်ပါ။
- connect မဟုတ်သည့် ပထမ frame များ သို့မဟုတ် malformed JSON များကို ငြင်းပယ်ပြီး socket ကို ပိတ်ပါသည်။
- Graceful shutdown: ပိတ်မီ `shutdown` event ကို ထုတ်ပေးပြီး clients များသည် close + reconnect ကို ကိုင်တွယ်ရမည်။

## CLI helpers

- `openclaw gateway health|status` — Gateway WS မှတစ်ဆင့် health/status ကို တောင်းဆိုသည်။
- `openclaw message send --target <num> --message "hi" [--media ...]` — Gateway မှတစ်ဆင့် send လုပ်သည် (WhatsApp အတွက် idempotent)။
- `openclaw agent --message "hi" --to <num>` — agent turn ကို လည်ပတ်သည် (မူလအားဖြင့် final ကို စောင့်သည်)။
- `openclaw gateway call <method> --params '{"k":"v"}'` — debugging အတွက် raw method invoker။
- `openclaw gateway stop|restart` — supervised gateway service ကို ရပ်တန့်/ပြန်စတင် (launchd/systemd)။
- Gateway helper subcommands များသည် `--url` တွင် လည်ပတ်နေသော gateway ကို ယူဆထားပြီး အလိုအလျောက် spawn မလုပ်တော့ပါ။

## Migration guidance

- `openclaw gateway` နှင့် legacy TCP control port အသုံးပြုမှုများကို ရပ်တန့်ပါ။
- clients များကို mandatory connect နှင့် structured presence ပါဝင်သော WS protocol ကို အသုံးပြုအောင် update လုပ်ပါ။
