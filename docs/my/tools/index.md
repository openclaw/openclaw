---
summary: "အမွေဆက်ခံ `openclaw-*` skills များကို အစားထိုးသည့် OpenClaw အတွက် Agent tool surface (browser, canvas, nodes, message, cron)"
read_when:
  - Agent tools များကို ထည့်သွင်းခြင်း သို့မဟုတ် ပြင်ဆင်ခြင်း
  - "`openclaw-*` skills များကို ရပ်နားခြင်း သို့မဟုတ် ပြောင်းလဲခြင်း"
title: "Tools"
---

# Tools (OpenClaw)

OpenClaw သည် browser, canvas, nodes နှင့် cron အတွက် **first-class agent tools** များကို ထုတ်ပေးထားသည်။
ဤအရာများသည် ယခင် `openclaw-*` skills များကို အစားထိုးပြီး tools များသည် typed ဖြစ်ကာ shelling မလိုအပ်သဖြင့် agent သည် တိုက်ရိုက် အသုံးပြုသင့်သည်။

## Tools များကို ပိတ်ခြင်း

`openclaw.json` ထဲတွင် `tools.allow` / `tools.deny` ကို အသုံးပြုပြီး tools များကို global အနေဖြင့် allow/deny လုပ်နိုင်သည် (deny က အနိုင်ရသည်)။ ဤအရာသည် ခွင့်မပြုထားသော tools များကို model providers များထံ မပို့စေရန် ကာကွယ်ပေးသည်။

```json5
{
  tools: { deny: ["browser"] },
}
```

မှတ်ချက်များ:

- ကိုက်ညီမှုကို အကြီးအသေးမခွဲပါ။
- `*` wildcard များကို ထောက်ပံ့ပါသည် (`"*"` သည် tools အားလုံးကို ဆိုလိုပါသည်)။
- `tools.allow` သည် မသိရှိသော သို့မဟုတ် မတင်သွင်းထားသော plugin tool အမည်များကိုသာ ကိုးကားထားပါက OpenClaw သည် သတိပေးချက်ကို မှတ်တမ်းတင်ပြီး allowlist ကို လျစ်လျူရှုကာ core tools များကို အသုံးပြုနိုင်အောင် ထားရှိပါသည်။

## Tool profiles (အခြေခံ allowlist)

`tools.profile` သည် `tools.allow`/`tools.deny` မတိုင်မီ **အခြေခံ tool allowlist** ကို သတ်မှတ်ပေးသည်။
Agent အလိုက် override: `agents.list[].tools.profile`။

Profiles:

- `minimal`: `session_status` သာလျှင်
- `coding`: `group:fs`, `group:runtime`, `group:sessions`, `group:memory`, `image`
- `messaging`: `group:messaging`, `sessions_list`, `sessions_history`, `sessions_send`, `session_status`
- `full`: ကန့်သတ်ချက်မရှိ (မသတ်မှတ်ထားသကဲ့သို့)

ဥပမာ (မက်ဆေ့ချ်ပို့ခြင်းသာ မူလသတ်မှတ်ထားပြီး Slack + Discord tools များကိုလည်း ခွင့်ပြုရန်):

```json5
{
  tools: {
    profile: "messaging",
    allow: ["slack", "discord"],
  },
}
```

ဥပမာ (coding profile ဖြစ်သော်လည်း exec/process ကို နေရာတိုင်းတွင် ပိတ်ပင်ရန်):

```json5
{
  tools: {
    profile: "coding",
    deny: ["group:runtime"],
  },
}
```

ဥပမာ (ကမ္ဘာလုံးဆိုင်ရာ coding profile၊ messaging-only support agent):

```json5
{
  tools: { profile: "coding" },
  agents: {
    list: [
      {
        id: "support",
        tools: { profile: "messaging", allow: ["slack"] },
      },
    ],
  },
}
```

## Provider-specific tool policy

Global default များကို မပြောင်းဘဲ provider သီးသန့် (သို့မဟုတ် `provider/model` တစ်ခုတည်း) အတွက် tools ကို **ထပ်မံ ကန့်သတ်ရန်** `tools.byProvider` ကို အသုံးပြုပါ။
Agent အလိုက် override: `agents.list[].tools.byProvider`။

၎င်းကို အခြေခံ tool profile **နောက်မှ** နှင့် allow/deny lists **မတိုင်မီ** အသုံးချသည်၊ ထို့ကြောင့် tool set ကိုသာ ပိုမို ကျဉ်းမြောင်းစေနိုင်သည်။
Provider key များသည် `provider` (ဥပမာ `google-antigravity`) သို့မဟုတ် `provider/model` (ဥပမာ `openai/gpt-5.2`) ကို လက်ခံသည်။

ဥပမာ (ကမ္ဘာလုံးဆိုင်ရာ coding profile ကို ထားရှိပြီး Google Antigravity အတွက် tools အနည်းဆုံးသာ):

```json5
{
  tools: {
    profile: "coding",
    byProvider: {
      "google-antigravity": { profile: "minimal" },
    },
  },
}
```

ဥပမာ (မတည်ငြိမ်သော endpoint အတွက် provider/model-specific allowlist):

```json5
{
  tools: {
    allow: ["group:fs", "group:runtime", "sessions_list"],
    byProvider: {
      "openai/gpt-5.2": { allow: ["group:fs", "sessions_list"] },
    },
  },
}
```

ဥပမာ (provider တစ်ခုတည်းအတွက် agent-specific override):

```json5
{
  agents: {
    list: [
      {
        id: "support",
        tools: {
          byProvider: {
            "google-antigravity": { allow: ["message", "sessions_list"] },
          },
        },
      },
    ],
  },
}
```

## Tool groups (အတိုချုံး)

Tool policy များ (global, agent, sandbox) တွင် tools များစွာသို့ ချဲ့ထွင်သည့် `group:*` entries ကို ထောက်ပံ့သည်။
`tools.allow` / `tools.deny` တွင် ထိုများကို အသုံးပြုပါ။

ရရှိနိုင်သော groups များ:

- `group:runtime`: `exec`, `bash`, `process`
- `group:fs`: `read`, `write`, `edit`, `apply_patch`
- `group:sessions`: `sessions_list`, `sessions_history`, `sessions_send`, `sessions_spawn`, `session_status`
- `group:memory`: `memory_search`, `memory_get`
- `group:web`: `web_search`, `web_fetch`
- `group:ui`: `browser`, `canvas`
- `group:automation`: `cron`, `gateway`
- `group:messaging`: `message`
- `group:nodes`: `nodes`
- `group:openclaw`: OpenClaw အတွင်းပါ built-in tools အားလုံး (provider plugins မပါဝင်)

ဥပမာ (file tools + browser ကိုသာ ခွင့်ပြုရန်):

```json5
{
  tools: {
    allow: ["group:fs", "browser"],
  },
}
```

## Plugins + tools

Plugins များသည် core set ထက် ကျော်လွန်သော **ထပ်ဆောင်း tools** (နှင့် CLI commands) ကို register လုပ်နိုင်သည်။
Install + config အတွက် [Plugins](/tools/plugin) ကိုကြည့်ပါ၊ tool usage guidance ကို prompt များထဲသို့ မည်သို့ inject လုပ်သည်ကို သိရန် [Skills](/tools/skills) ကိုကြည့်ပါ။ Plugins အချို့သည် tools များနှင့်အတူ ကိုယ်ပိုင် skills များကိုပါ ပို့ဆောင်လာသည် (ဥပမာ voice-call plugin)။

ရွေးချယ်နိုင်သော plugin tools များ:

- [Lobster](/tools/lobster): ပြန်လည်စတင်နိုင်သော approvals များပါဝင်သည့် typed workflow runtime (Gateway ဟို့စ် ပေါ်တွင် Lobster CLI လိုအပ်ပါသည်)။
- [LLM Task](/tools/llm-task): structured workflow output အတွက် JSON-only LLM step (schema validation ရွေးချယ်နိုင်)။

## Tool inventory

### `apply_patch`

ဖိုင်တစ်ခု သို့မဟုတ် များစွာတွင် structured patches များကို အသုံးချပါ။ Multi-hunk edits အတွက် အသုံးပြုပါ။
Experimental: `tools.exec.applyPatch.enabled` မှတဆင့် enable လုပ်ပါ (OpenAI models များသာ)။

### `exec`

workspace အတွင်း shell commands များကို လည်ပတ်စေပါ။

အခြေခံ parameters:

- `command` (လိုအပ်)
- `yieldMs` (timeout အပြီး auto-background; မူလ 10000)
- `background` (ချက်ချင်း background)
- `timeout` (စက္ကန့်; ကျော်လွန်ပါက process ကို သတ်ပစ်မည်၊ မူလ 1800)
- `elevated` (bool; elevated mode ကို ဖွင့်/ခွင့်ပြုထားပါက ဟို့စ် ပေါ်တွင် လည်ပတ်စေမည်; agent သည် sandboxed ဖြစ်သည့်အခါတွင်သာ အပြုအမူ ပြောင်းလဲပါသည်)
- `host` (`sandbox | gateway | node`)
- `security` (`deny | allowlist | full`)
- `ask` (`off | on-miss | always`)
- `node` (`host=node` အတွက် node id/name)
- တကယ့် TTY လိုအပ်ပါသလား? `pty: true` ကို သတ်မှတ်ပါ။

မှတ်ချက်များ:

- background သို့ ပို့ထားပါက `sessionId` ပါသော `status: "running"` ကို ပြန်ပေးပါသည်။
- background sessions များကို poll/log/write/kill/clear လုပ်ရန် `process` ကို အသုံးပြုပါ။
- `process` ကို ခွင့်မပြုထားပါက `exec` သည် synchronous အဖြစ် လည်ပတ်ပြီး `yieldMs`/`background` ကို လျစ်လျူရှုပါသည်။
- `elevated` သည် `tools.elevated` နှင့် မည်သည့် `agents.list[].tools.elevated` override မဆို (နှစ်ဖက်စလုံး ခွင့်ပြုရပါမည်) ဖြင့် gate လုပ်ထားပြီး `host=gateway` + `security=full` အတွက် alias ဖြစ်ပါသည်။
- `elevated` သည် agent သည် sandboxed ဖြစ်သည့်အခါတွင်သာ အပြုအမူ ပြောင်းလဲပါသည် (မဟုတ်ပါက no-op)။
- `host=node` သည် macOS companion app သို့မဟုတ် headless node host (`openclaw node run`) ကို ဦးတည်နိုင်ပါသည်။
- Gateway/နိုဒ် approvals နှင့် allowlists: [Exec approvals](/tools/exec-approvals)။

### `process`

background exec sessions များကို စီမံခန့်ခွဲပါ။

အခြေခံ actions:

- `list`, `poll`, `log`, `write`, `kill`, `clear`, `remove`

မှတ်ချက်များ:

- `poll` သည် ပြီးဆုံးပါက output အသစ်နှင့် exit status ကို ပြန်ပေးပါသည်။
- `log` သည် line-based `offset`/`limit` ကို ထောက်ပံ့ပါသည် (`offset` ကို မထည့်ပါက နောက်ဆုံး N လိုင်းများကို ယူပါသည်)။
- `process` သည် agent တစ်ခုချင်းစီအလိုက် scope ဖြစ်ပြီး အခြား agent များ၏ sessions များကို မမြင်နိုင်ပါ။

### `web_search`

Brave Search API ကို အသုံးပြု၍ ဝဘ်ကို ရှာဖွေပါ။

အခြေခံ parameters:

- `query` (လိုအပ်)
- `count` (1–10; မူလ `tools.web.search.maxResults` မှ)

မှတ်ချက်များ:

- Brave API key လိုအပ်ပါသည် (အကြံပြုချက်: `openclaw configure --section web` သို့မဟုတ် `BRAVE_API_KEY` ကို သတ်မှတ်ပါ)။
- `tools.web.search.enabled` ဖြင့် ဖွင့်ပါ။
- အဖြေများကို cache ထားပါသည် (မူလ 15 မိနစ်)။
- တပ်ဆင်မှုအတွက် [Web tools](/tools/web) ကို ကြည့်ပါ။

### `web_fetch`

URL တစ်ခုမှ ဖတ်ရလွယ်ကူသော အကြောင်းအရာကို ယူ၍ ထုတ်ယူပါ (HTML → markdown/text)။

အခြေခံ parameters:

- `url` (လိုအပ်)
- `extractMode` (`markdown` | `text`)
- `maxChars` (စာမျက်နှာရှည်များကို truncate)

မှတ်ချက်များ:

- `tools.web.fetch.enabled` ဖြင့် ဖွင့်ပါ။
- `maxChars` ကို `tools.web.fetch.maxCharsCap` ဖြင့် ကန့်သတ်ထားပါသည် (မူလ 50000)။
- အဖြေများကို cache ထားပါသည် (မူလ 15 မိနစ်)။
- JS-heavy sites များအတွက် browser tool ကို ဦးစားပေးပါ။
- တပ်ဆင်မှုအတွက် [Web tools](/tools/web) ကို ကြည့်ပါ။
- ရွေးချယ်နိုင်သော anti-bot fallback အတွက် [Firecrawl](/tools/firecrawl) ကို ကြည့်ပါ။

### `browser`

OpenClaw က စီမံခန့်ခွဲထားသော dedicated browser ကို ထိန်းချုပ်ပါ။

အခြေခံ actions:

- `status`, `start`, `stop`, `tabs`, `open`, `focus`, `close`
- `snapshot` (aria/ai)
- `screenshot` (image block + `MEDIA:<path>` ကို ပြန်ပေးပါသည်)
- `act` (UI actions: click/type/press/hover/drag/select/fill/resize/wait/evaluate)
- `navigate`, `console`, `pdf`, `upload`, `dialog`

Profile စီမံခန့်ခွဲမှု:

- `profiles` — status ပါသော browser profiles အားလုံးကို စာရင်းပြုစုပါ
- `create-profile` — auto-allocated port ဖြင့် profile အသစ် ဖန်တီးပါ (သို့မဟုတ် `cdpUrl`)
- `delete-profile` — browser ကို ရပ်တန့်၍ user data ကို ဖျက်ပြီး config မှ ဖယ်ရှားပါ (local သာ)
- `reset-profile` — profile ၏ port ပေါ်ရှိ orphan process ကို သတ်ပါ (local သာ)

အများဆုံး အသုံးများသော parameters:

- `profile` (ရွေးချယ်နိုင်; မူလ `browser.defaultProfile`)
- `target` (`sandbox` | `host` | `node`)
- `node` (ရွေးချယ်နိုင်; သတ်မှတ်ထားသော node id/name ကို ရွေးချယ်)
  မှတ်ချက်များ:
- `browser.enabled=true` လိုအပ်ပါသည် (မူလ `true`; ပိတ်ရန် `false` ကို သတ်မှတ်ပါ)။
- Actions အားလုံးသည် multi-instance အတွက် ရွေးချယ်နိုင်သော `profile` parameter ကို လက်ခံပါသည်။
- `profile` မထည့်ပါက `browser.defaultProfile` ကို အသုံးပြုပါသည် (မူလ "chrome")။
- Profile အမည်များ: lowercase alphanumeric + hyphens သာ (အများဆုံး 64 စာလုံး)။
- Port range: 18800-18899 (~100 profiles အများဆုံး)။
- Remote profiles များသည် attach-only ဖြစ်ပြီး (start/stop/reset မလုပ်နိုင်ပါ)။
- browser-capable node ချိတ်ဆက်ထားပါက tool သည် အလိုအလျောက် route လုပ်နိုင်ပါသည် (သင် `target` ဖြင့် pin မလုပ်ထားလျှင်)။
- Playwright တင်ထားပါက `snapshot` သည် မူလ `ai` ကို အသုံးပြုပါသည်; accessibility tree အတွက် `aria` ကို အသုံးပြုပါ။
- `snapshot` သည် role-snapshot options (`interactive`, `compact`, `depth`, `selector`) ကိုလည်း ထောက်ပံ့ပြီး `e12` ကဲ့သို့သော refs များကို ပြန်ပေးပါသည်။
- `act` သည် `snapshot` မှ `ref` လိုအပ်ပါသည် (AI snapshots မှ numeric `12` သို့မဟုတ် role snapshots မှ `e12`)။ CSS selector အနည်းအကျဉ်းလိုအပ်ချက်များအတွက် `evaluate` ကို အသုံးပြုပါ။
- မူလအားဖြင့် `act` → `wait` ကို ရှောင်ရှားပါ; ယုံကြည်စိတ်ချရသော UI state မရှိသော အထူးအခြေအနေများတွင်သာ အသုံးပြုပါ။
- `upload` သည် arming ပြီးနောက် auto-click လုပ်ရန် ရွေးချယ်နိုင်သော `ref` ကို ပေးပို့နိုင်ပါသည်။
- `upload` သည် `inputRef` (aria ref) သို့မဟုတ် `element` (CSS selector) ကိုလည်း ထောက်ပံ့ပြီး `<input type="file">` ကို တိုက်ရိုက် သတ်မှတ်နိုင်ပါသည်။

### `canvas`

node Canvas ကို လည်ပတ်စေပါ (present, eval, snapshot, A2UI)။

အခြေခံ actions:

- `present`, `hide`, `navigate`, `eval`
- `snapshot` (image block + `MEDIA:<path>` ကို ပြန်ပေးပါသည်)
- `a2ui_push`, `a2ui_reset`

မှတ်ချက်များ:

- အောက်ခံအနေဖြင့် gateway `node.invoke` ကို အသုံးပြုပါသည်။
- `node` မပေးထားပါက tool သည် default (ချိတ်ဆက်ထားသော node တစ်ခုတည်း သို့မဟုတ် local mac node) ကို ရွေးပါသည်။
- A2UI သည် v0.8 သာ ( `createSurface` မရှိပါ) ဖြစ်ပြီး CLI သည် v0.9 JSONL ကို line errors ဖြင့် ပယ်ချပါသည်။
- Quick smoke: `openclaw nodes canvas a2ui push --node <id> --text "Hello from A2UI"`။

### `nodes`

paired nodes များကို ရှာဖွေ၍ ဦးတည်ပါ၊ အသိပေးချက်များ ပို့ပါ၊ camera/screen ကို ဖမ်းယူပါ။

အခြေခံ actions:

- `status`, `describe`
- `pending`, `approve`, `reject` (pairing)
- `notify` (macOS `system.notify`)
- `run` (macOS `system.run`)
- `camera_snap`, `camera_clip`, `screen_record`
- `location_get`

မှတ်ချက်များ:

- Camera/screen commands များသည် node app ကို foreground တွင် ထားရှိရန် လိုအပ်ပါသည်။
- Images များသည် image blocks + `MEDIA:<path>` ကို ပြန်ပေးပါသည်။
- Videos များသည် `FILE:<path>` (mp4) ကို ပြန်ပေးပါသည်။
- Location သည် JSON payload (lat/lon/accuracy/timestamp) ကို ပြန်ပေးပါသည်။
- `run` params: `command` argv array; ရွေးချယ်နိုင်သော `cwd`, `env` (`KEY=VAL`), `commandTimeoutMs`, `invokeTimeoutMs`, `needsScreenRecording`။

ဥပမာ (`run`):

```json
{
  "action": "run",
  "node": "office-mac",
  "command": ["echo", "Hello"],
  "env": ["FOO=bar"],
  "commandTimeoutMs": 12000,
  "invokeTimeoutMs": 45000,
  "needsScreenRecording": false
}
```

### `image`

သတ်မှတ်ထားသော image model ဖြင့် ပုံကို ခွဲခြမ်းစိတ်ဖြာပါ။

အခြေခံ parameters:

- `image` (လိုအပ်သော path သို့မဟုတ် URL)
- `prompt` (ရွေးချယ်နိုင်; မူလ "Describe the image.")
- `model` (ရွေးချယ်နိုင်သော override)
- `maxBytesMb` (ရွေးချယ်နိုင်သော size cap)

မှတ်ချက်များ:

- `agents.defaults.imageModel` ကို (primary သို့မဟုတ် fallbacks) အဖြစ် ဖွဲ့စည်းထားသည့်အခါတွင်သာ ရရှိနိုင်ပါသည်၊ သို့မဟုတ် သင်၏ default model + configured auth မှ implicit image model ကို ခန့်မှန်းနိုင်သည့်အခါ (best-effort pairing)။
- Main chat model နှင့် သီးခြားလွတ်လပ်စွာ image model ကို တိုက်ရိုက် အသုံးပြုပါသည်။

### `message`

Discord/Google Chat/Slack/Telegram/WhatsApp/Signal/iMessage/MS Teams တစ်လျှောက် မက်ဆေ့ချ်များနှင့် channel actions များကို ပို့ပါ။

အခြေခံ actions:

- `send` (စာသား + ရွေးချယ်နိုင်သော မီဒီယာ; MS Teams သည် Adaptive Cards အတွက် `card` ကိုလည်း ထောက်ပံ့)
- `poll` (WhatsApp/Discord/MS Teams polls)
- `react` / `reactions` / `read` / `edit` / `delete`
- `pin` / `unpin` / `list-pins`
- `permissions`
- `thread-create` / `thread-list` / `thread-reply`
- `search`
- `sticker`
- `member-info` / `role-info`
- `emoji-list` / `emoji-upload` / `sticker-upload`
- `role-add` / `role-remove`
- `channel-info` / `channel-list`
- `voice-status`
- `event-list` / `event-create`
- `timeout` / `kick` / `ban`

မှတ်ချက်များ:

- `send` သည် WhatsApp ကို Gateway မှတဆင့် route လုပ်ပါသည်; အခြား channels များသည် တိုက်ရိုက် သွားပါသည်။
- `poll` သည် WhatsApp နှင့် MS Teams အတွက် Gateway ကို အသုံးပြုပါသည်; Discord polls များသည် တိုက်ရိုက် သွားပါသည်။
- Message tool call တစ်ခုကို active chat session နှင့် ချိတ်ထားပါက context ပေါက်ကြားမှုကို ရှောင်ရန် ထို session ၏ target သို့သာ ပို့ပါသည်။

### `cron`

Gateway cron jobs နှင့် wakeups များကို စီမံခန့်ခွဲပါ။

အခြေခံ actions:

- `status`, `list`
- `add`, `update`, `remove`, `run`, `runs`
- `wake` (system event ကို enqueue လုပ်ပြီး ရွေးချယ်နိုင်သော ချက်ချင်း heartbeat)

မှတ်ချက်များ:

- `add` သည် cron job object အပြည့်အစုံကို မျှော်လင့်ပါသည် (`cron.add` RPC နှင့် schema တူညီ)။
- `update` သည် `{ jobId, patch }` ကို အသုံးပြုပါသည် (compatibility အတွက် `id` ကို လက်ခံပါသည်)။

### `gateway`

လည်ပတ်နေသော Gateway process ကို ပြန်စတင်ခြင်း သို့မဟုတ် updates များကို အသုံးချပါ (in-place)။

အခြေခံ actions:

- `restart` (authorizes + in-process restart အတွက် `SIGUSR1` ကို ပို့ပါသည်; in-place restart အတွက် `openclaw gateway`)
- `config.get` / `config.schema`
- `config.apply` (validate + config ရေးသား + restart + wake)
- `config.patch` (partial update ကို merge + restart + wake)
- `update.run` (update ကို လည်ပတ် + restart + wake)

မှတ်ချက်များ:

- လည်ပတ်နေသော အဖြေကို မဖြတ်တောက်ရန် `delayMs` (မူလ 2000) ကို အသုံးပြုပါ။
- `restart` ကို မူလအားဖြင့် ပိတ်ထားပြီး `commands.restart: true` ဖြင့် ဖွင့်ပါ။

### `sessions_list` / `sessions_history` / `sessions_send` / `sessions_spawn` / `session_status`

Sessions များကို စာရင်းပြုစုပါ၊ transcript history ကို စစ်ဆေးပါ၊ သို့မဟုတ် အခြား session သို့ ပို့ပါ။

အခြေခံ parameters:

- `sessions_list`: `kinds?`, `limit?`, `activeMinutes?`, `messageLimit?` (0 = မရှိ)
- `sessions_history`: `sessionKey` (သို့မဟုတ် `sessionId`), `limit?`, `includeTools?`
- `sessions_send`: `sessionKey` (သို့မဟုတ် `sessionId`), `message`, `timeoutSeconds?` (0 = fire-and-forget)
- `sessions_spawn`: `task`, `label?`, `agentId?`, `model?`, `runTimeoutSeconds?`, `cleanup?`
- `session_status`: `sessionKey?` (မူလ current; `sessionId` ကို လက်ခံ), `model?` (`default` ဖြင့် override ကို ရှင်းလင်း)

မှတ်ချက်များ:

- `main` သည် canonical direct-chat key ဖြစ်ပြီး global/unknown များကို ဖုံးကွယ်ထားပါသည်။
- `messageLimit > 0` သည် session တစ်ခုချင်းစီအလိုက် နောက်ဆုံး N မက်ဆေ့ချ်များကို ယူပါသည် (tool messages များကို စစ်ထုတ်ထားသည်)။
- `timeoutSeconds > 0` ဖြစ်ပါက `sessions_send` သည် နောက်ဆုံး ပြီးဆုံးမှုကို စောင့်ဆိုင်းပါသည်။
- Delivery/announce သည် ပြီးဆုံးပြီးနောက် ဖြစ်ပြီး best-effort ဖြစ်ပါသည်; `status: "ok"` သည် agent run ပြီးဆုံးကြောင်းကိုသာ အတည်ပြုပေးပြီး announce ပို့ပြီးကြောင်းကို မအာမခံပါ။
- `sessions_spawn` သည် sub-agent run တစ်ခုကို စတင်ကာ requester chat သို့ announce reply ကို ပြန်တင်ပါသည်။
- `sessions_spawn` သည် non-blocking ဖြစ်ပြီး ချက်ချင်း `status: "accepted"` ကို ပြန်ပေးပါသည်။
- `sessions_send` သည် reply‑back ping‑pong ကို လည်ပတ်စေပါသည် (ရပ်ရန် `REPLY_SKIP` ကို ပြန်ပါ; turns အများဆုံး `session.agentToAgent.maxPingPongTurns`၊ 0–5)။
- ping‑pong အပြီးတွင် target agent သည် **announce step** ကို လည်ပတ်ပါသည်; announcement ကို ဖိနှိပ်ရန် `ANNOUNCE_SKIP` ကို ပြန်ပါ။

### `agents_list`

လက်ရှိ session မှ `sessions_spawn` ဖြင့် ဦးတည်နိုင်သော agent ids များကို စာရင်းပြုစုပါ။

မှတ်ချက်များ:

- ရလဒ်ကို agent တစ်ခုချင်းစီအလိုက် allowlists (`agents.list[].subagents.allowAgents`) ဖြင့် ကန့်သတ်ထားပါသည်။
- `["*"]` ကို ဖွဲ့စည်းထားပါက tool သည် ဖွဲ့စည်းထားသော agents အားလုံးကို ထည့်သွင်းပြီး `allowAny: true` ကို အမှတ်အသားပြုပါသည်။

## Parameters (အများပြားအသုံးများ)

Gateway-backed tools (`canvas`, `nodes`, `cron`):

- `gatewayUrl` (မူလ `ws://127.0.0.1:18789`)
- `gatewayToken` (auth ကို ဖွင့်ထားပါက)
- `timeoutMs`

မှတ်ချက်: `gatewayUrl` ကို သတ်မှတ်ထားပါက `gatewayToken` ကို တိတိကျကျ ထည့်သွင်းပါ။ Tools များသည် override များအတွက် config သို့မဟုတ် environment credentials ကို အမွေဆက်ခံမထားဘဲ၊ လိုအပ်သော credentials ကို တိတိကျကျ မထည့်ပါက အမှားဖြစ်သည်။

Browser tool:

- `profile` (ရွေးချယ်နိုင်; မူလ `browser.defaultProfile`)
- `target` (`sandbox` | `host` | `node`)
- `node` (ရွေးချယ်နိုင်; သတ်မှတ်ထားသော node id/name ကို pin လုပ်ရန်)

## အကြံပြု Agent flows များ

Browser automation:

1. `browser` → `status` / `start`
2. `snapshot` (ai သို့မဟုတ် aria)
3. `act` (click/type/press)
4. မြင်သာသော အတည်ပြုချက် လိုအပ်ပါက `screenshot`

Canvas render:

1. `canvas` → `present`
2. `a2ui_push` (ရွေးချယ်နိုင်)
3. `snapshot`

Node targeting:

1. `nodes` → `status`
2. ရွေးချယ်ထားသော node ပေါ်တွင် `describe`
3. `notify` / `run` / `camera_snap` / `screen_record`

## လုံခြုံရေး

- တိုက်ရိုက် `system.run` ကို ရှောင်ပါ; အသုံးပြုသူ၏ ထင်ရှားသော ခွင့်ပြုချက်ရှိသည့်အခါတွင်သာ `nodes` → `run` ကို အသုံးပြုပါ။
- Camera/screen ဖမ်းယူမှုအတွက် အသုံးပြုသူ၏ ခွင့်ပြုချက်ကို လေးစားပါ။
- Media commands များကို ခေါ်မီ ခွင့်ပြုချက်များကို သေချာစေရန် `status/describe` ကို အသုံးပြုပါ။

## Agent ထံသို့ tools များကို တင်ပြပုံ

Tools များကို parallel channels နှစ်ခုဖြင့် ထုတ်ဖော်ပြသပါသည်:

1. **System prompt text**: လူဖတ်လို့ရသော စာရင်း + လမ်းညွှန်ချက်များ။
2. **Tool schema**: model API သို့ ပို့သော structured function definitions များ။

အဆိုပါအချက်သည် agent သည် “ရှိနေသော tools များ” နှင့် “မည်သို့ ခေါ်ဆိုရမည်” ကို နှစ်မျိုးလုံး မြင်နိုင်သည်ဟု ဆိုလိုသည်။ System prompt သို့မဟုတ် schema ထဲတွင် မပေါ်လာသော tool တစ်ခုကို model က ခေါ်ဆိုနိုင်မည် မဟုတ်ပါ။
