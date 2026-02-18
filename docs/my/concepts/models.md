---
summary: "Models CLI: စာရင်းပြုစုခြင်း၊ သတ်မှတ်ခြင်း၊ အလယ်အလတ်အမည်များ၊ အစားထိုး fallback များ၊ စကန်လုပ်ခြင်း၊ အခြေအနေ"
read_when:
  - Models CLI (models list/set/scan/aliases/fallbacks) ကို ထည့်သွင်းခြင်း သို့မဟုတ် ပြင်ဆင်ခြင်း
  - မော်ဒယ် fallback အပြုအမူ သို့မဟုတ် ရွေးချယ်မှု UX ကို ပြောင်းလဲခြင်း
  - မော်ဒယ် စကန် probe များ (tools/images) ကို အပ်ဒိတ်လုပ်ခြင်း
title: "Models CLI"
---

# Models CLI

See [/concepts/model-failover](/concepts/model-failover) for auth profile
rotation, cooldowns, and how that interacts with fallbacks.
Quick provider overview + examples: [/concepts/model-providers](/concepts/model-providers).

## မော်ဒယ် ရွေးချယ်မှု အလုပ်လုပ်ပုံ

OpenClaw သည် မော်ဒယ်များကို အောက်ပါ အစဉ်အတိုင်း ရွေးချယ်သည်-

1. **Primary** မော်ဒယ် (`agents.defaults.model.primary` သို့မဟုတ် `agents.defaults.model`)။
2. `agents.defaults.model.fallbacks` အတွင်းရှိ **Fallbacks** များ (အစဉ်လိုက်)။
3. **Provider auth failover** သည် နောက်ထပ် မော်ဒယ်သို့ မရွှေ့ခင် provider အတွင်း၌ ဖြစ်ပေါ်သည်။

ဆက်စပ်အချက်များ-

- `agents.defaults.models` သည် OpenClaw အသုံးပြုနိုင်သော မော်ဒယ်များ (aliases အပါအဝင်) ၏ allowlist/catalog ဖြစ်သည်။
- `agents.defaults.imageModel` ကို **Primary မော်ဒယ်က ပုံများကို မလက်ခံနိုင်သောအခါသာ** အသုံးပြုသည်။
- အေးဂျင့်တစ်ခုချင်းစီအလိုက် မူလတန်ဖိုးများသည် bindings များနှင့်အတူ `agents.list[].model` ကို အသုံးပြုပြီး `agents.defaults.model` ကို override လုပ်နိုင်သည် ( [/concepts/multi-agent](/concepts/multi-agent) ကိုကြည့်ပါ)။

## အမြန် မော်ဒယ် ရွေးချယ်ချက်များ (အတွေ့အကြုံအခြေပြု)

- **GLM**: coding/tool calling အတွက် နည်းနည်း ပိုကောင်းသည်။
- **MiniMax**: စာရေးသားမှုနှင့် vibe အတွက် ပိုကောင်းသည်။

## Setup wizard (အကြံပြု)

config ကို ကိုယ်တိုင် မပြင်ချင်ပါက onboarding wizard ကို chạy ပါ-

```bash
openclaw onboard
```

ဤ wizard သည် model + auth ကို common provider များအတွက် သတ်မှတ်ပေးနိုင်ပြီး **OpenAI Code (Codex) subscription** (OAuth) နှင့် **Anthropic** (API key အကြံပြု; `claude
setup-token` ကိုလည်း ထောက်ပံ့သည်) ကို ပါဝင်စေသည်။

## Config keys (အကျဉ်းချုပ်)

- `agents.defaults.model.primary` နှင့် `agents.defaults.model.fallbacks`
- `agents.defaults.imageModel.primary` နှင့် `agents.defaults.imageModel.fallbacks`
- `agents.defaults.models` (allowlist + aliases + provider params)
- `models.providers` (`models.json` ထဲသို့ custom provider များရေးထည့်သည်)

Model refs are normalized to lowercase. Provider aliases like `z.ai/*` normalize
to `zai/*`.

Provider configuration ဥပမာများ (OpenCode Zen အပါအဝင်) ကို
[/gateway/configuration](/gateway/configuration#opencode-zen-multi-model-proxy) တွင် တွေ့နိုင်သည်။

## “Model is not allowed” (နှင့် အဖြေများ ရပ်သွားရသည့် အကြောင်းရင်း)

If `agents.defaults.models` is set, it becomes the **allowlist** for `/model` and for
session overrides. When a user selects a model that isn’t in that allowlist,
OpenClaw returns:

```
Model "provider/model" is not allowed. Use /model to list available models.
```

This happens **before** a normal reply is generated, so the message can feel
like it “didn’t respond.” The fix is to either:

- မော်ဒယ်ကို `agents.defaults.models` ထဲ ထည့်ပါ၊ သို့မဟုတ်
- allowlist ကို ရှင်းလင်းပါ (`agents.defaults.models` ကို ဖယ်ရှားပါ)၊ သို့မဟုတ်
- `/model list` ထဲမှ မော်ဒယ်တစ်ခုကို ရွေးပါ။

Example allowlist config-

```json5
{
  agent: {
    model: { primary: "anthropic/claude-sonnet-4-5" },
    models: {
      "anthropic/claude-sonnet-4-5": { alias: "Sonnet" },
      "anthropic/claude-opus-4-6": { alias: "Opus" },
    },
  },
}
```

## ချတ်အတွင်း မော်ဒယ် ပြောင်းလဲခြင်း (`/model`)

ပြန်စတင်စရာမလိုဘဲ လက်ရှိ session အတွက် မော်ဒယ်ကို ပြောင်းလဲနိုင်သည်-

```
/model
/model list
/model 3
/model openai/gpt-5.2
/model status
```

မှတ်ချက်များ-

- `/model` (နှင့် `/model list`) သည် ကျစ်လစ်သော နံပါတ်ပေးထားသည့် picker (model family + ရရှိနိုင်သော providers) ဖြစ်သည်။
- `/model <#>` သည် ထို picker ထဲမှ ရွေးချယ်သည်။
- `/model status` သည် အသေးစိတ် မြင်ကွင်း (auth candidates နှင့် သတ်မှတ်ထားပါက provider endpoint `baseUrl` + `api` mode) ဖြစ်သည်။
- Model refs are parsed by splitting on the **first** `/`. Use `provider/model` when typing `/model <ref>`.
- မော်ဒယ် ID ကိုယ်တိုင်တွင် `/` (OpenRouter-style) ပါဝင်ပါက provider prefix ကို ထည့်ရပါမည် (ဥပမာ- `/model openrouter/moonshotai/kimi-k2`)။
- Provider ကို မထည့်ပါက OpenClaw သည် ထို input ကို alias သို့မဟုတ် **default provider** အတွက် မော်ဒယ်အဖြစ် ကိုင်တွယ်မည်ဖြစ်ပြီး (model ID ထဲတွင် `/` မရှိသည့်အခါတွင်သာ အလုပ်လုပ်သည်)။

Command အပြည့်အစုံ အပြုအမူ/config: [Slash commands](/tools/slash-commands)။

## CLI commands

```bash
openclaw models list
openclaw models status
openclaw models set <provider/model>
openclaw models set-image <provider/model>

openclaw models aliases list
openclaw models aliases add <alias> <provider/model>
openclaw models aliases remove <alias>

openclaw models fallbacks list
openclaw models fallbacks add <provider/model>
openclaw models fallbacks remove <provider/model>
openclaw models fallbacks clear

openclaw models image-fallbacks list
openclaw models image-fallbacks add <provider/model>
openclaw models image-fallbacks remove <provider/model>
openclaw models image-fallbacks clear
```

`openclaw models` (subcommand မပါ) သည် `models status` အတွက် shortcut ဖြစ်သည်။

### `models list`

Shows configured models by default. Useful flags:

- `--all`: catalog အပြည့်အစုံ
- `--local`: local provider များသာ
- `--provider <name>`: provider အလိုက် filter လုပ်ရန်
- `--plain`: မော်ဒယ် တစ်ခုလျှင် တစ်ကြောင်း
- `--json`: machine‑readable output

### `models status`

Shows the resolved primary model, fallbacks, image model, and an auth overview
of configured providers. It also surfaces OAuth expiry status for profiles found
in the auth store (warns within 24h by default). `--plain` prints only the
resolved primary model.
OAuth status is always shown (and included in `--json` output). If a configured
provider has no credentials, `models status` prints a **Missing auth** section.
JSON includes `auth.oauth` (warn window + profiles) and `auth.providers`
(effective auth per provider).
Use `--check` for automation (exit `1` when missing/expired, `2` when expiring).

Anthropic အတွက် အကြံပြု auth သည် Claude Code CLI setup-token ဖြစ်သည် (ဘယ်နေရာမှာမဆို chạy နိုင်ပြီး လိုအပ်ပါက Gateway ဟို့စ် တွင် paste လုပ်ပါ)-

```bash
claude setup-token
openclaw models status
```

## Scanning (OpenRouter free models)

`openclaw models scan` သည် OpenRouter ၏ **free model catalog** ကို စစ်ဆေးပြီး
tool နှင့် image ထောက်ပံ့မှုကို စမ်းသပ် probe လုပ်ရန် optional အနေဖြင့် လုပ်နိုင်သည်။

Key flags-

- `--no-probe`: live probe မလုပ်ဘဲ (metadata သာ)
- `--min-params <b>`: အနည်းဆုံး parameter အရွယ်အစား (ဘီလီယံ)
- `--max-age-days <days>`: အဟောင်းမော်ဒယ်များကို ကျော်သွားရန်
- `--provider <name>`: provider prefix filter
- `--max-candidates <n>`: fallback စာရင်း အရွယ်အစား
- `--set-default`: ပထမဆုံး ရွေးချယ်မှုကို `agents.defaults.model.primary` သို့ သတ်မှတ်ရန်
- `--set-image`: ပထမဆုံး image ရွေးချယ်မှုကို `agents.defaults.imageModel.primary` သို့ သတ်မှတ်ရန်

Probing requires an OpenRouter API key (from auth profiles or
`OPENROUTER_API_KEY`). Without a key, use `--no-probe` to list candidates only.

Scan ရလဒ်များကို အောက်ပါ အစဉ်အတိုင်း အဆင့်သတ်မှတ်သည်-

1. Image ထောက်ပံ့မှု
2. Tool latency
3. Context အရွယ်အစား
4. Parameter အရေအတွက်

Input

- OpenRouter `/models` စာရင်း (filter `:free`)
- OpenRouter API key ကို auth profiles သို့မဟုတ် `OPENROUTER_API_KEY` မှ လိုအပ်သည် ( [/environment](/help/environment) ကိုကြည့်ပါ)
- Optional filters: `--max-age-days`, `--min-params`, `--provider`, `--max-candidates`
- Probe controls: `--timeout`, `--concurrency`

When run in a TTY, you can select fallbacks interactively. In non‑interactive
mode, pass `--yes` to accept defaults.

## Models registry (`models.json`)

Custom providers in `models.providers` are written into `models.json` under the
agent directory (default `~/.openclaw/agents/<agentId>/models.json`). This file
is merged by default unless `models.mode` is set to `replace`.
