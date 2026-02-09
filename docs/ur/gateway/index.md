---
summary: "Gateway سروس، لائف سائیکل، اور آپریشنز کے لیے رن بُک"
read_when:
  - Gateway پروسیس کو چلانے یا ڈیبگ کرنے کے دوران
title: "Gateway رن بُک"
---

# Gateway سروس رن بُک

آخری تازہ کاری: 2025-12-09

## یہ کیا ہے

- ہمیشہ فعال رہنے والا پروسیس جو واحد Baileys/Telegram کنکشن اور کنٹرول/ایونٹ پلین کا مالک ہوتا ہے۔
- لیگیسی `gateway` کمانڈ کی جگہ لیتا ہے۔ CLI entry point: `openclaw gateway`.
- روکے جانے تک چلتا رہتا ہے؛ مہلک غلطیوں پر نان زیرو کے ساتھ خارج ہوتا ہے تاکہ سپروائزر اسے دوبارہ شروع کرے۔

## کیسے چلائیں (لوکل)

```bash
openclaw gateway --port 18789
# for full debug/trace logs in stdio:
openclaw gateway --port 18789 --verbose
# if the port is busy, terminate listeners then start:
openclaw gateway --force
# dev loop (auto-reload on TS changes):
pnpm gateway:watch
```

- کنفیگ ہاٹ ری لوڈ `~/.openclaw/openclaw.json` (یا `OPENCLAW_CONFIG_PATH`) کو واچ کرتا ہے۔
  - ڈیفالٹ موڈ: `gateway.reload.mode="hybrid"` (محفوظ تبدیلیاں ہاٹ-اپلائی، اہم تبدیلیوں پر ری اسٹارٹ)۔
  - ہاٹ ری لوڈ ضرورت پڑنے پر **SIGUSR1** کے ذریعے ان-پروسیس ری اسٹارٹ استعمال کرتا ہے۔
  - `gateway.reload.mode="off"` کے ساتھ غیر فعال کریں۔
- WebSocket کنٹرول پلین کو `127.0.0.1:<port>` پر بائنڈ کرتا ہے (ڈیفالٹ 18789)۔
- The same port also serves HTTP (control UI, hooks, A2UI). Single-port multiplex.
  - OpenAI Chat Completions (HTTP): [`/v1/chat/completions`](/gateway/openai-http-api)۔
  - OpenResponses (HTTP): [`/v1/responses`](/gateway/openresponses-http-api)۔
  - Tools Invoke (HTTP): [`/tools/invoke`](/gateway/tools-invoke-http-api)۔
- Starts a Canvas file server by default on `canvasHost.port` (default `18793`), serving `http://<gateway-host>:18793/__openclaw__/canvas/` from `~/.openclaw/workspace/canvas`. Disable with `canvasHost.enabled=false` or `OPENCLAW_SKIP_CANVAS_HOST=1`.
- stdout پر لاگز لکھتا ہے؛ اسے زندہ رکھنے اور لاگز گھمانے کے لیے launchd/systemd استعمال کریں۔
- خرابیوں کے ازالے کے دوران لاگ فائل سے stdio میں ڈیبگ لاگنگ (ہینڈ شیکس، req/res، ایونٹس) کی مررنگ کے لیے `--verbose` پاس کریں۔
- `--force` منتخب پورٹ پر لسٹنرز تلاش کرنے کے لیے `lsof` استعمال کرتا ہے، SIGTERM بھیجتا ہے، جسے اس نے بند کیا اس کا لاگ بناتا ہے، پھر گیٹ وے شروع کرتا ہے (اگر `lsof` غائب ہو تو فوراً ناکام ہو جاتا ہے)۔
- اگر آپ سپروائزر (launchd/systemd/mac app child-process mode) کے تحت چلاتے ہیں تو اسٹاپ/ری اسٹارٹ عموماً **SIGTERM** بھیجتا ہے؛ پرانی بلڈز میں یہ `pnpm` `ELIFECYCLE` ایگزٹ کوڈ **143** (SIGTERM) کے طور پر ظاہر ہو سکتا ہے، جو نارمل شٹ ڈاؤن ہے، کریش نہیں۔
- **SIGUSR1** مجاز ہونے پر ان-پروسیس ری اسٹارٹ ٹرگر کرتا ہے (gateway ٹول/کنفیگ اپلائی/اپڈیٹ، یا دستی ری اسٹارٹس کے لیے `commands.restart` فعال کریں)۔
- Gateway auth is required by default: set `gateway.auth.token` (or `OPENCLAW_GATEWAY_TOKEN`) or `gateway.auth.password`. Clients must send `connect.params.auth.token/password` unless using Tailscale Serve identity.
- وزرڈ اب بطورِ طے شدہ ٹوکن جنریٹ کرتا ہے، حتیٰ کہ loopback پر بھی۔
- پورٹ کی ترجیح: `--port` > `OPENCLAW_GATEWAY_PORT` > `gateway.port` > ڈیفالٹ `18789`۔

## ریموٹ رسائی

- Tailscale/VPN کو ترجیح دیں؛ بصورتِ دیگر SSH سرنگ:

  ```bash
  ssh -N -L 18789:127.0.0.1:18789 user@host
  ```

- پھر کلائنٹس سرنگ کے ذریعے `ws://127.0.0.1:18789` سے کنیکٹ کرتے ہیں۔

- اگر ٹوکن کنفیگر ہو، تو سرنگ کے ذریعے بھی کلائنٹس کو اسے `connect.params.auth.token` میں شامل کرنا ہوگا۔

## متعدد گیٹ ویز (ایک ہی ہوسٹ)

Usually unnecessary: one Gateway can serve multiple messaging channels and agents. Use multiple Gateways only for redundancy or strict isolation (ex: rescue bot).

Supported if you isolate state + config and use unique ports. Full guide: [Multiple gateways](/gateway/multiple-gateways).

سروس نام پروفائل-آگاہ ہیں:

- macOS: `bot.molt.<profile>` (legacy `com.openclaw.*` may still exist)
- Linux: `openclaw-gateway-<profile>.service`
- Windows: `OpenClaw Gateway (<profile>)`

انسٹال میٹا ڈیٹا سروس کنفیگ میں ایمبیڈ ہوتا ہے:

- `OPENCLAW_SERVICE_MARKER=openclaw`
- `OPENCLAW_SERVICE_KIND=gateway`
- `OPENCLAW_SERVICE_VERSION=<version>`

Rescue-Bot Pattern: keep a second Gateway isolated with its own profile, state dir, workspace, and base port spacing. Full guide: [Rescue-bot guide](/gateway/multiple-gateways#rescue-bot-guide).

### ڈیو پروفائل (`--dev`)

فاسٹ پاتھ: اپنے بنیادی سیٹ اپ کو چھیڑے بغیر ایک مکمل طور پر آئسولیٹڈ ڈیو انسٹینس (کنفیگ/اسٹیٹ/ورک اسپیس) چلائیں۔

```bash
openclaw --dev setup
openclaw --dev gateway --allow-unconfigured
# then target the dev instance:
openclaw --dev status
openclaw --dev health
```

ڈیفالٹس (env/فلگز/کنفیگ کے ذریعے اوور رائیڈ ہو سکتے ہیں):

- `OPENCLAW_STATE_DIR=~/.openclaw-dev`
- `OPENCLAW_CONFIG_PATH=~/.openclaw-dev/openclaw.json`
- `OPENCLAW_GATEWAY_PORT=19001` (Gateway WS + HTTP)
- براؤزر کنٹرول سروس پورٹ = `19003` (ماخوذ: `gateway.port+2`, صرف loopback)
- `canvasHost.port=19005` (ماخوذ: `gateway.port+4`)
- `agents.defaults.workspace` بطورِ طے شدہ `~/.openclaw/workspace-dev` بن جاتا ہے جب آپ `setup`/`onboard` کو `--dev` کے تحت چلاتے ہیں۔

ماخوذ پورٹس (عمومی اصول):

- بیس پورٹ = `gateway.port` (یا `OPENCLAW_GATEWAY_PORT` / `--port`)
- براؤزر کنٹرول سروس پورٹ = بیس + 2 (صرف loopback)
- `canvasHost.port = base + 4` (یا `OPENCLAW_CANVAS_HOST_PORT` / کنفیگ اوور رائیڈ)
- Browser profile CDP ports auto-allocate from `browser.controlPort + 9 .. + 108` (persisted per profile).

ہر انسٹینس کے لیے چیک لسٹ:

- منفرد `gateway.port`
- منفرد `OPENCLAW_CONFIG_PATH`
- منفرد `OPENCLAW_STATE_DIR`
- منفرد `agents.defaults.workspace`
- الگ WhatsApp نمبرز (اگر WA استعمال ہو)

ہر پروفائل کے لیے سروس انسٹال:

```bash
openclaw --profile main gateway install
openclaw --profile rescue gateway install
```

مثال:

```bash
OPENCLAW_CONFIG_PATH=~/.openclaw/a.json OPENCLAW_STATE_DIR=~/.openclaw-a openclaw gateway --port 19001
OPENCLAW_CONFIG_PATH=~/.openclaw/b.json OPENCLAW_STATE_DIR=~/.openclaw-b openclaw gateway --port 19002
```

## پروٹوکول (آپریٹر ویو)

- مکمل دستاویزات: [Gateway protocol](/gateway/protocol) اور [Bridge protocol (legacy)](/gateway/bridge-protocol)۔
- Mandatory first frame from client: `req {type:"req", id, method:"connect", params:{minProtocol,maxProtocol,client:{id,displayName?,version,platform,deviceFamily?,modelIdentifier?,mode,instanceId?}, caps, auth?, locale?, userAgent? } }`.
- Gateway جواب دیتا ہے `res {type:"res", id, ok:true, payload:hello-ok }` (یا `ok:false` غلطی کے ساتھ، پھر بند)۔
- ہینڈ شیک کے بعد:
  - ریکویسٹس: `{type:"req", id, method, params}` → `{type:"res", id, ok, payload|error}`
  - ایونٹس: `{type:"event", event, payload, seq?, stateVersion?}`
- Structured presence entries: `{host, ip, version, platform?, deviceFamily?, modelIdentifier?, mode, lastInputSeconds?, ts, reason?, tags?[], instanceId? }` (for WS clients, `instanceId` comes from `connect.client.instanceId`).
- `agent` ریسپانسز دو مرحلوں میں ہوتے ہیں: پہلے `res` ack `{runId,status:"accepted"}`، پھر رن مکمل ہونے کے بعد حتمی `res` `{runId,status:"ok"|"error",summary}`؛ اسٹریمنگ آؤٹ پٹ `event:"agent"` کے طور پر آتا ہے۔

## طریقے (ابتدائی سیٹ)

- `health` — مکمل ہیلتھ اسنیپ شاٹ (وہی اسٹرکچر جو `openclaw health --json` میں ہے)۔
- `status` — مختصر خلاصہ۔
- `system-presence` — موجودہ پریزنس فہرست۔
- `system-event` — پریزنس/سسٹم نوٹ پوسٹ کریں (اسٹرکچرڈ)۔
- `send` — فعال چینل(ز) کے ذریعے پیغام بھیجیں۔
- `agent` — ایجنٹ ٹرن چلائیں (اسی کنکشن پر ایونٹس اسٹریمنگ کے ساتھ واپس آتے ہیں)۔
- `node.list` — جوڑے گئے + اس وقت کنیکٹڈ نوڈز کی فہرست (جس میں `caps`, `deviceFamily`, `modelIdentifier`, `paired`, `connected`، اور مشتہر کردہ `commands` شامل ہیں)۔
- `node.describe` — کسی نوڈ کی وضاحت کریں (صلاحیتیں + سپورٹڈ `node.invoke` کمانڈز؛ جوڑے گئے نوڈز اور اس وقت کنیکٹڈ غیر جوڑے گئے نوڈز دونوں کے لیے کام کرتا ہے)۔
- `node.invoke` — کسی نوڈ پر کمانڈ چلائیں (مثلاً `canvas.*`, `camera.*`)۔
- `node.pair.*` — جوڑی بنانے کا لائف سائیکل (`request`, `list`, `approve`, `reject`, `verify`)۔

یہ بھی دیکھیں: پریزنس کیسے تیار/ڈی ڈپ ہوتی ہے اور ایک مستحکم `client.instanceId` کیوں اہم ہے — [Presence](/concepts/presence)۔

## ایونٹس

- `agent` — ایجنٹ رن سے اسٹریمنگ ٹول/آؤٹ پٹ ایونٹس (seq-tagged)۔
- `presence` — پریزنس اپڈیٹس (stateVersion کے ساتھ ڈیلٹاز) تمام کنیکٹڈ کلائنٹس کو پُش کی جاتی ہیں۔
- `tick` — زندہ ہونے کی تصدیق کے لیے وقفے وقفے سے keepalive/no-op۔
- `shutdown` — Gateway is exiting; payload includes `reason` and optional `restartExpectedMs`. Clients should reconnect.

## WebChat انضمام

- WebChat ایک نیٹو SwiftUI UI ہے جو ہسٹری، بھیجنے، ابورٹ، اور ایونٹس کے لیے براہِ راست Gateway WebSocket سے بات کرتا ہے۔
- ریموٹ استعمال اسی SSH/Tailscale سرنگ سے گزرتا ہے؛ اگر gateway ٹوکن کنفیگر ہو تو کلائنٹ اسے `connect` کے دوران شامل کرتا ہے۔
- macOS ایپ ایک ہی WS کے ذریعے کنیکٹ ہوتی ہے (مشترکہ کنکشن)؛ یہ ابتدائی اسنیپ شاٹ سے پریزنس ہائیڈریٹ کرتی ہے اور UI اپڈیٹ کے لیے `presence` ایونٹس سنتی ہے۔

## ٹائپنگ اور ویلیڈیشن

- سرور ہر اِن باؤنڈ فریم کو AJV کے ذریعے JSON Schema کے خلاف ویلیڈیٹ کرتا ہے جو پروٹوکول ڈیفینیشنز سے ایمٹ ہوتی ہے۔
- کلائنٹس (TS/Swift) جنریٹڈ ٹائپس استعمال کرتے ہیں (TS براہِ راست؛ Swift ریپو کے جنریٹر کے ذریعے)۔
- پروٹوکول ڈیفینیشنز سورس آف ٹروتھ ہیں؛ اسکیما/ماڈلز دوبارہ جنریٹ کریں:
  - `pnpm protocol:gen`
  - `pnpm protocol:gen:swift`

## کنکشن اسنیپ شاٹ

- `hello-ok` میں ایک `snapshot` شامل ہوتا ہے جس میں `presence`, `health`, `stateVersion`, اور `uptimeMs` کے ساتھ `policy {maxPayload,maxBufferedBytes,tickIntervalMs}` بھی شامل ہوتا ہے تاکہ کلائنٹس اضافی ریکویسٹس کے بغیر فوراً رینڈر کر سکیں۔
- `health`/`system-presence` دستی ریفریش کے لیے دستیاب رہتے ہیں، مگر کنیکٹ کے وقت درکار نہیں۔

## ایرر کوڈز (res.error اسٹرکچر)

- Errors use `{ code, message, details?, retryable?, retryAfterMs? }`.
- معیاری کوڈز:
  - `NOT_LINKED` — WhatsApp مستند نہیں۔
  - `AGENT_TIMEOUT` — ایجنٹ مقررہ ڈیڈ لائن کے اندر جواب نہیں دے سکا۔
  - `INVALID_REQUEST` — اسکیما/پیرامیٹر ویلیڈیشن ناکام۔
  - `UNAVAILABLE` — Gateway بند ہو رہا ہے یا کوئی انحصار دستیاب نہیں۔

## کیپ الائیو رویہ

- `tick` ایونٹس (یا WS ping/pong) وقفے وقفے سے ایمٹ ہوتے ہیں تاکہ ٹریفک نہ ہونے پر بھی کلائنٹس جان سکیں کہ Gateway زندہ ہے۔
- بھیجنے/ایجنٹ کی ایکنالوجمنٹس الگ ریسپانسز ہی رہتی ہیں؛ ٹِکس کو بھیجنے کے لیے اوورلوڈ نہ کریں۔

## ری پلے / گیپس

- Events are not replayed. Clients detect seq gaps and should refresh (`health` + `system-presence`) before continuing. WebChat and macOS clients now auto-refresh on gap.

## سپروِژن (macOS مثال)

- سروس کو زندہ رکھنے کے لیے launchd استعمال کریں:
  - Program: `openclaw` کا پاتھ
  - Arguments: `gateway`
  - KeepAlive: true
  - StandardOut/Err: فائل پاتھس یا `syslog`
- ناکامی پر launchd دوبارہ شروع کرتا ہے؛ مہلک غلط کنفیگریشن میں مسلسل ایگزٹ ہونا چاہیے تاکہ آپریٹر کو علم ہو۔
- LaunchAgents فی-یوزر ہوتے ہیں اور لاگ اِن سیشن درکار ہوتا ہے؛ ہیڈ لیس سیٹ اپس کے لیے کسٹم LaunchDaemon استعمال کریں (شپ نہیں کیا جاتا)۔
  - `openclaw gateway install` writes `~/Library/LaunchAgents/bot.molt.gateway.plist`
    (or `bot.molt.<profile>.plist`; legacy `com.openclaw.*` is cleaned up).
  - `openclaw doctor` LaunchAgent کنفیگ کا آڈٹ کرتا ہے اور اسے موجودہ ڈیفالٹس کے مطابق اپڈیٹ کر سکتا ہے۔

## Gateway سروس مینجمنٹ (CLI)

انسٹال/اسٹارٹ/اسٹاپ/ری اسٹارٹ/اسٹیٹس کے لیے Gateway CLI استعمال کریں:

```bash
openclaw gateway status
openclaw gateway install
openclaw gateway stop
openclaw gateway restart
openclaw logs --follow
```

نوٹس:

- `gateway status` بطورِ طے شدہ سروس کے ریزولوڈ پورٹ/کنفیگ کا استعمال کرتے ہوئے Gateway RPC کو پروب کرتا ہے ( `--url` کے ساتھ اوور رائیڈ کریں)۔
- `gateway status --deep` سسٹم-لیول اسکینز (LaunchDaemons/system units) شامل کرتا ہے۔
- `gateway status --no-probe` RPC پروب چھوڑ دیتا ہے (جب نیٹ ورکنگ ڈاؤن ہو تو مفید)۔
- `gateway status --json` اسکرپٹس کے لیے مستحکم ہے۔
- `gateway status` **سپروائزر رن ٹائم** (launchd/systemd چل رہا) کو **RPC رسائی** (WS کنیکٹ + اسٹیٹس RPC) سے الگ رپورٹ کرتا ہے۔
- `gateway status` “localhost بمقابلہ LAN bind” الجھن اور پروفائل عدم مطابقت سے بچنے کے لیے کنفیگ پاتھ + پروب ٹارگٹ پرنٹ کرتا ہے۔
- `gateway status` اس وقت آخری gateway ایرر لائن شامل کرتا ہے جب سروس چلتی نظر آئے مگر پورٹ بند ہو۔
- `logs` RPC کے ذریعے Gateway فائل لاگ کو ٹیل کرتا ہے (دستی `tail`/`grep` کی ضرورت نہیں)۔
- If other gateway-like services are detected, the CLI warns unless they are OpenClaw profile services.
  We still recommend **one gateway per machine** for most setups; use isolated profiles/ports for redundancy or a rescue bot. See [Multiple gateways](/gateway/multiple-gateways).
  - صفائی: `openclaw gateway uninstall` (موجودہ سروس) اور `openclaw doctor` (لیگیسی مائیگریشنز)۔
- `gateway install` پہلے سے انسٹال ہونے پر نو-آپ ہے؛ دوبارہ انسٹال کے لیے `openclaw gateway install --force` استعمال کریں (پروفائل/env/پاتھ تبدیلیاں)۔

بنڈلڈ mac ایپ:

- OpenClaw.app can bundle a Node-based gateway relay and install a per-user LaunchAgent labeled
  `bot.molt.gateway` (or `bot.molt.<profile>1. `; legacy `com.openclaw.*` labels still unload cleanly).
- اسے صاف طور پر روکنے کے لیے `openclaw gateway stop` استعمال کریں (یا `launchctl bootout gui/$UID/bot.molt.gateway`)۔
- ری اسٹارٹ کے لیے `openclaw gateway restart` استعمال کریں (یا `launchctl kickstart -k gui/$UID/bot.molt.gateway`)۔
  - `launchctl` صرف اسی وقت کام کرتا ہے جب LaunchAgent انسٹال ہو؛ ورنہ پہلے `openclaw gateway install` استعمال کریں۔
  - 2. لیبل کو `bot.molt.<profile>` سے بدلیں3. \` جب کسی نامزد پروفائل کو چلایا جا رہا ہو۔

## سپروِژن (systemd یوزر یونٹ)

4. OpenClaw لینکس/WSL2 پر بطورِ ڈیفالٹ ایک **systemd user service** انسٹال کرتا ہے۔ 5. ہم
   واحد صارف مشینوں کے لیے یوزر سروسز کی سفارش کرتے ہیں (سادہ ماحول، فی صارف کنفیگ)۔
5. کثیر صارف یا ہمیشہ آن سرورز کے لیے **system service** استعمال کریں (lingering کی ضرورت نہیں، مشترکہ نگرانی)۔

7. `openclaw gateway install` یوزر یونٹ لکھتا ہے۔ 8. `openclaw doctor` یونٹ کا آڈٹ کرتا ہے
   اور اسے موجودہ تجویز کردہ ڈیفالٹس کے مطابق اپڈیٹ کر سکتا ہے۔

`~/.config/systemd/user/openclaw-gateway[-<profile>].service` بنائیں:

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

لِنگرنگ فعال کریں (لاگ آؤٹ/آئیڈل کے بعد بھی یوزر سروس چلتی رہے):

```
sudo loginctl enable-linger youruser
```

9. آن بورڈنگ یہ عمل لینکس/WSL2 پر چلاتی ہے (sudo کے لیے پرامپٹ آ سکتا ہے؛ `/var/lib/systemd/linger` لکھتی ہے)۔
10. پھر سروس کو فعال کریں:

```
systemctl --user enable --now openclaw-gateway[-<profile>].service
```

11. **متبادل (system service)** - ہمیشہ آن یا کثیر صارف سرورز کے لیے، آپ یوزر یونٹ کے بجائے systemd **system** یونٹ انسٹال کر سکتے ہیں (lingering درکار نہیں)۔
12. `/etc/systemd/system/openclaw-gateway[-<profile>].service` بنائیں (اوپر والا یونٹ کاپی کریں، `WantedBy=multi-user.target` پر سوئچ کریں، `User=` + `WorkingDirectory=` سیٹ کریں)، پھر:

```
sudo systemctl daemon-reload
sudo systemctl enable --now openclaw-gateway[-<profile>].service
```

## Windows (WSL2)

Windows انسٹالیشنز کو **WSL2** استعمال کرنا چاہیے اور اوپر دیے گئے Linux systemd سیکشن کی پیروی کرنی چاہیے۔

## آپریشنل چیکس

- لائیونیس: WS کھولیں اور `req:connect` بھیجیں → `res` متوقع ہے جس میں `payload.type="hello-ok"` (اسنیپ شاٹ کے ساتھ) ہو۔
- ریڈینس: `health` کال کریں → `ok: true` اور `linkChannel` میں لنکڈ چینل متوقع ہے (جب لاگو ہو)۔
- ڈیبگ: `tick` اور `presence` ایونٹس کو سبسکرائب کریں؛ یقینی بنائیں کہ `status` لنکڈ/آتھنٹکیشن عمر دکھاتا ہے؛ پریزنس انٹریز Gateway ہوسٹ اور کنیکٹڈ کلائنٹس دکھائیں۔

## حفاظتی ضمانتیں

- بطورِ طے شدہ فی ہوسٹ ایک Gateway فرض کریں؛ اگر متعدد پروفائلز چلائیں تو پورٹس/اسٹیٹ الگ رکھیں اور درست انسٹینس کو ہدف بنائیں۔
- براہِ راست Baileys کنکشنز پر کوئی فال بیک نہیں؛ اگر Gateway ڈاؤن ہو تو بھیجنا فوراً ناکام ہو جاتا ہے۔
- نان-کنیکٹ ابتدائی فریمز یا خراب JSON مسترد کر دیے جاتے ہیں اور ساکٹ بند کر دی جاتی ہے۔
- گِریس فل شٹ ڈاؤن: بند کرنے سے پہلے `shutdown` ایونٹ ایمٹ کریں؛ کلائنٹس کو کلوز + ری کنیکٹ ہینڈل کرنا چاہیے۔

## CLI مددگار

- `openclaw gateway health|status` — Gateway WS کے ذریعے ہیلتھ/اسٹیٹس کی درخواست۔
- `openclaw message send --target <num> --message "hi" [--media ...]` — Gateway کے ذریعے بھیجیں (WhatsApp کے لیے idempotent)۔
- `openclaw agent --message "hi" --to <num>` — ایجنٹ ٹرن چلائیں (بطورِ طے شدہ حتمی نتیجے کا انتظار کرتا ہے)۔
- `openclaw gateway call <method> --params '{"k":"v"}'` — ڈیبگنگ کے لیے خام میتھڈ انووکر۔
- `openclaw gateway stop|restart` — سپروائزڈ gateway سروس کو اسٹاپ/ری اسٹارٹ کریں (launchd/systemd)۔
- Gateway ہیلپر سب کمانڈز `--url` پر چلتے ہوئے gateway فرض کرتے ہیں؛ اب وہ خودکار طور پر نیا اسپان نہیں کرتے۔

## مائیگریشن رہنمائی

- `openclaw gateway` اور لیگیسی TCP کنٹرول پورٹ کے استعمالات ختم کریں۔
- کلائنٹس کو WS پروٹوکول بولنے کے لیے اپڈیٹ کریں جس میں لازمی کنیکٹ اور اسٹرکچرڈ پریزنس شامل ہو۔
