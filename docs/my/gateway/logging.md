---
summary: "Logging ပေါ်ထွက်ရာနေရာများ၊ ဖိုင် log များ၊ WS log ပုံစံများနှင့် console ဖော်မတ်ချခြင်း"
read_when:
  - Logging ထွက်ပေါ်မှု သို့မဟုတ် ဖော်မတ်များကို ပြောင်းလဲနေစဉ်
  - CLI သို့မဟုတ် gateway ထွက်ပေါ်မှုကို အမှားရှာဖွေနေစဉ်
title: "Logging"
---

# Logging

အသုံးပြုသူဘက်မြင်ကွင်းအတွက် အကျဉ်းချုပ် (CLI + Control UI + config) ကို [/logging](/logging) တွင် ကြည့်ပါ။

OpenClaw တွင် log “surfaces” နှစ်မျိုးရှိသည်—

- **Console output** (terminal / Debug UI တွင် မြင်ရသည့်အရာများ)
- **File logs** (JSON lines) ကို gateway logger က ရေးသားထားသည်

## File-based logger

- မူလ rolling log ဖိုင်တည်နေရာမှာ `/tmp/openclaw/` အောက်တွင် (နေ့စဉ် ဖိုင်တစ်ဖိုင်): `openclaw-YYYY-MM-DD.log`
  - ရက်စွဲသည် gateway host ၏ local timezone ကို အသုံးပြုသည်။
- Log ဖိုင်လမ်းကြောင်းနှင့် level ကို `~/.openclaw/openclaw.json` မှတစ်ဆင့် ပြင်ဆင်နိုင်သည်—
  - `logging.file`
  - `logging.level`

ဖိုင်ဖော်မတ်မှာ လိုင်းတစ်လိုင်းလျှင် JSON object တစ်ခုဖြစ်သည်။

Control UI Logs tab သည် gateway မှတစ်ဆင့် ဤဖိုင်ကို tail လုပ်ပြသည် (`logs.tail`)။
CLI ကလည်း ထိုအရာကို လုပ်နိုင်သည်:

```bash
openclaw logs --follow
```

**Verbose နှင့် log levels**

- **File logs** ကို `logging.level` သာလျှင် ထိန်းချုပ်သည်။
- `--verbose` သည် **console verbosity** (နှင့် WS log style) ကိုသာ သက်ရောက်ပြီး
  file log level ကို **မတိုးမြှင့်** ပါ။
- Verbose-only အသေးစိတ်အချက်အလက်များကို file logs ထဲတွင် ဖမ်းယူလိုပါက `logging.level` ကို `debug` သို့မဟုတ်
  `trace` သို့ သတ်မှတ်ပါ။

## Console capture

CLI သည် `console.log/info/warn/error/debug/trace` ကို ဖမ်းယူပြီး file logs ထဲသို့ ရေးသားပေးသည်၊
stdout/stderr သို့ ပုံနှိပ်ထုတ်ပေးခြင်းကိုလည်း ဆက်လက် လုပ်ဆောင်နေပါသည်။

Console verbosity ကို သီးခြား ပြင်ဆင်နိုင်ရန်—

- `logging.consoleLevel` (မူလ `info`)
- `logging.consoleStyle` (`pretty` | `compact` | `json`)

## Tool summary redaction

အသေးစိတ် tool summary များ (ဥပမာ `🛠️ Exec: ...`) သည် console stream ထဲသို့ မရောက်မီ sensitive token များကို ဖုံးကွယ်နိုင်သည်။ ဤအရာသည် **tools-only** ဖြစ်ပြီး file log များကို မပြောင်းလဲပါ။

- `logging.redactSensitive`: `off` | `tools` (မူလ: `tools`)
- `logging.redactPatterns`: regex string များ၏ array (မူလတန်ဖိုးများကို override လုပ်သည်)
  - Raw regex strings ကို အသုံးပြုပါ (auto `gi`) သို့မဟုတ် custom flags လိုအပ်ပါက `/pattern/flags` ကို အသုံးပြုပါ။
  - ကိုက်ညီမှုများကို ပထမ 6 + နောက်ဆုံး 4 အက္ခရာများကို ထိန်းသိမ်းပြီး (အလျား >= 18) ဖုံးကွယ်ပါမည်၊ မဟုတ်ပါက `***` ဖြစ်သည်။
  - မူလတန်ဖိုးများတွင် အများအားဖြင့် အသုံးများသော key assignment များ၊ CLI flags များ၊ JSON fields များ၊ bearer headers များ၊ PEM blocks များနှင့် လူကြိုက်များသော token prefix များကို ဖုံးအုပ်ထားသည်။

## Gateway WebSocket logs

Gateway သည် WebSocket protocol logs များကို မုဒ်နှစ်မျိုးဖြင့် ပုံနှိပ်ထုတ်ပေးသည်—

- **Normal mode (`--verbose` မရှိ)**: “စိတ်ဝင်စားဖွယ်” RPC ရလဒ်များကိုသာ ပုံနှိပ်သည်—
  - အမှားများ (`ok=false`)
  - နှေးကွေးသော ခေါ်ဆိုမှုများ (မူလ threshold: `>= 50ms`)
  - parse errors
- **Verbose mode (`--verbose`)**: WS request/response traffic အားလုံးကို ပုံနှိပ်သည်။

### WS log style

`openclaw gateway` သည် gateway တစ်ခုချင်းစီအလိုက် style ပြောင်းလဲမှုကို ထောက်ပံ့သည်—

- `--ws-log auto` (မူလ): normal mode ကို အကောင်းဆုံးလုပ်ဆောင်ထားပြီး; verbose mode တွင် compact output ကို အသုံးပြုသည်
- `--ws-log compact`: verbose ဖြစ်ချိန်တွင် compact output (paired request/response)
- `--ws-log full`: verbose ဖြစ်ချိန်တွင် frame တစ်ခုချင်းစီအလိုက် full output
- `--compact`: `--ws-log compact` အတွက် alias

ဥပမာများ—

```bash
# optimized (only errors/slow)
openclaw gateway

# show all WS traffic (paired)
openclaw gateway --verbose --ws-log compact

# show all WS traffic (full meta)
openclaw gateway --verbose --ws-log full
```

## Console formatting (subsystem logging)

Console formatter သည် **TTY-aware** ဖြစ်ပြီး အစီအစဉ်တကျ prefix ပါသော လိုင်းများကို ပုံမှန်တူညီစွာ ထုတ်ပေးသည်။
Subsystem logger များသည် output ကို အုပ်စုလိုက်ထားပြီး ဖတ်ရှုရ လွယ်ကူစေသည်။

အပြုအမူများ—

- လိုင်းတိုင်းတွင် **Subsystem prefixes** (ဥပမာ `[gateway]`, `[canvas]`, `[tailscale]`)
- **Subsystem colors** (subsystem တစ်ခုချင်းစီအလိုက် တည်ငြိမ်) နှင့် level coloring
- **Output သည် TTY ဖြစ်ပါက သို့မဟုတ် rich terminal ကဲ့သို့သော ပတ်ဝန်းကျင်ဟု ထင်ရှားပါက အရောင်အသုံးပြုသည်** (`TERM`/`COLORTERM`/`TERM_PROGRAM`)၊ `NO_COLOR` ကို လေးစားလိုက်နာသည်
- **Subsystem prefix အတိုချုံ့ခြင်း**: ရှေ့ဆုံးရှိ `gateway/` + `channels/` ကို ဖယ်ရှားပြီး နောက်ဆုံး segment ၂ ခုကိုသာ ထိန်းသိမ်းသည် (ဥပမာ `whatsapp/outbound`)
- **Subsystem အလိုက် sub-loggers** (auto prefix + structured field `{ subsystem }`)
- QR/UX output အတွက် **`logRaw()`** (prefix မရှိ၊ formatting မရှိ)
- **Console styles** (ဥပမာ `pretty | compact | json`)
- **Console log level** သည် file log level နှင့် သီးခြားဖြစ်သည် (file သည် `logging.level` ကို `debug`/`trace` သို့ သတ်မှတ်ထားပါက အသေးစိတ်အပြည့်အစုံကို ဆက်လက် ထိန်းသိမ်းထားသည်)
- **WhatsApp message bodies** ကို `debug` တွင် log လုပ်ထားသည် (`--verbose` ကို အသုံးပြု၍ ကြည့်ရှုနိုင်သည်)

ဤနည်းဖြင့် ရှိပြီးသား file logs များကို တည်ငြိမ်စေထားစဉ် interactive output ကိုလည်း စစ်ဆေးဖတ်ရှုရ လွယ်ကူစေသည်။
