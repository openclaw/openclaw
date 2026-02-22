---
summary: "OpenClaw သည် ပတ်ဝန်းကျင်ကိန်းရှင်များကို မည်သည့်နေရာများမှ တင်ယူသည်နှင့် ဦးစားပေးအစဉ်"
read_when:
  - မည်သည့် env vars များကို တင်ယူထားသည်နှင့် မည်သည့်အစဉ်အတိုင်းဖြစ်သည်ကို သိရန်လိုအပ်သောအခါ
  - Gateway တွင် API keys ပျောက်ဆုံးနေသည်ကို စစ်ဆေးနေသောအခါ
  - provider အတည်ပြုခြင်း သို့မဟုတ် တပ်ဆင်ထားသော ပတ်ဝန်းကျင်များကို စာရွက်တမ်းရေးသားနေသောအခါ
title: "ပတ်ဝန်းကျင်ကိန်းရှင်များ"
---

# ပတ်ဝန်းကျင်ကိန်းရှင်များ

OpenClaw သည် environment variables များကို အရင်းအမြစ် အမျိုးမျိုးမှ ယူပါသည်။ စည်းမျဉ်းမှာ **ရှိပြီးသားတန်ဖိုးများကို ဘယ်တော့မှ မအစားထိုးပါနှင့်** ဖြစ်ပါသည်။

## ဦးစားပေးအစဉ် (အမြင့်ဆုံး → အနိမ့်ဆုံး)

1. **Process environment** (မိဘ shell/daemon မှ Gateway process တွင် ရှိပြီးသား အရာများ)။
2. **လက်ရှိ အလုပ်လုပ်နေသော directory ထဲရှိ `.env`** (dotenv default; အစားမထိုးပါ)။
3. **`~/.openclaw/.env` တွင်ရှိသော Global `.env`** (aka `$OPENCLAW_STATE_DIR/.env`; အစားမထိုးပါ)။
4. **`~/.openclaw/openclaw.json` အတွင်းရှိ Config `env` block** (မရှိသေးလျှင်သာ သက်ရောက်စေသည်)။
5. **Optional login-shell import** (`env.shellEnv.enabled` သို့မဟုတ် `OPENCLAW_LOAD_SHELL_ENV=1`), မျှော်မှန်းထားသော ကီးများ မရှိသေးသည့်အခါတွင်သာ အသုံးပြုသည်။

Config ဖိုင်လုံးဝ မရှိပါက အဆင့် 4 ကို ကျော်လွှားမည်ဖြစ်ပြီး; shell import သည် ဖွင့်ထားပါက ဆက်လက် လုပ်ဆောင်မည်ဖြစ်သည်။

## Config `env` block

Inline env vars များကို သတ်မှတ်ရန် တူညီသော နည်းလမ်း ၂ မျိုး (နှစ်မျိုးလုံး အစားမထိုးပါ):

```json5
{
  env: {
    OPENROUTER_API_KEY: "sk-or-...",
    vars: {
      GROQ_API_KEY: "gsk-...",
    },
  },
}
```

## Shell env import

`env.shellEnv` သည် သင့် login shell ကို လည်ပတ်စေပြီး **မရှိသေးသော** မျှော်မှန်းထားသော ကီးများကိုသာ တင်သွင်းသည်—

```json5
{
  env: {
    shellEnv: {
      enabled: true,
      timeoutMs: 15000,
    },
  },
}
```

Env var အစားထိုးများ:

- `OPENCLAW_LOAD_SHELL_ENV=1`
- `OPENCLAW_SHELL_ENV_TIMEOUT_MS=15000`

## Config အတွင်း Env var အစားထိုးခြင်း

Config string တန်ဖိုးများအတွင်း `${VAR_NAME}` syntax ကို အသုံးပြုပြီး env vars များကို တိုက်ရိုက် ကိုးကားနိုင်သည်—

```json5
{
  models: {
    providers: {
      "vercel-gateway": {
        apiKey: "${VERCEL_GATEWAY_API_KEY}",
      },
    },
  },
}
```

အသေးစိတ်အပြည့်အစုံအတွက် [Configuration: Env var substitution](/gateway/configuration#env-var-substitution-in-config) ကို ကြည့်ပါ။

## Path ဆိုင်ရာ env var များ

| Variable               | Purpose                                                                                                                                                                                                                     |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OPENCLAW_HOME`        | Internal path resolution (`~/.openclaw/`, agent directories, sessions, credentials) အားလုံးတွင် အသုံးပြုမည့် home directory ကို override လုပ်ပါသည်။ OpenClaw ကို dedicated service user အဖြစ် run လုပ်သောအခါ အသုံးဝင်ပါသည်။ |
| `OPENCLAW_STATE_DIR`   | State directory ကို override လုပ်ပါသည် (default `~/.openclaw`)။                                                                                                                                                             |
| `OPENCLAW_CONFIG_PATH` | 1. config ဖိုင်လမ်းကြောင်းကို override လုပ်ရန် (မူလ `~/.openclaw/openclaw.json`)။                                                                                                                                           |

### 2. `OPENCLAW_HOME`

3. သတ်မှတ်ထားပါက `OPENCLAW_HOME` သည် အတွင်းပိုင်း path resolution အားလုံးအတွက် စနစ် home directory (`$HOME` / `os.homedir()`) ကို အစားထိုးပါသည်။ 4. ဤအရာသည် headless service account များအတွက် filesystem isolation အပြည့်အစုံကို ဖွင့်ပေးပါသည်။

4. **Precedence:** `OPENCLAW_HOME` > `$HOME` > `USERPROFILE` > `os.homedir()`

5. **ဥပမာ** (macOS LaunchDaemon):

```xml
7. <key>EnvironmentVariables</key>
<dict>
  <key>OPENCLAW_HOME</key>
  <string>/Users/kira</string>
</dict>
```

8. `OPENCLAW_HOME` ကို tilde path (ဥပမာ `~/svc`) အဖြစ်လည်း သတ်မှတ်နိုင်ပြီး အသုံးမပြုမီ `$HOME` ကို အသုံးပြုပြီး ချဲ့ထွင် (expand) လုပ်ပါသည်။

## ဆက်စပ်

- [Gateway configuration](/gateway/configuration)
- [FAQ: env vars နှင့် .env တင်ယူခြင်း](/help/faq#env-vars-and-env-loading)
- [Models အကြမ်းဖျဉ်း](/concepts/models)
