---
summary: "စမ်းသပ်ကိရိယာအစုံအလင်: unit/e2e/live စုစည်းမှုများ၊ Docker runners များနှင့် စမ်းသပ်မှုတစ်ခုချင်းစီက ဖုံးလွှမ်းသည့်အရာများ"
read_when:
  - ဒေသတွင်း သို့မဟုတ် CI တွင် စမ်းသပ်မှုများ လည်ပတ်စေသောအခါ
  - မော်ဒယ်/ပံ့ပိုးသူ ဘတ်ဂ်များအတွက် regression များ ထည့်သွင်းနေသောအခါ
  - Gateway + အေးဂျင့် အပြုအမူကို debug လုပ်နေသောအခါ
title: "စမ်းသပ်ခြင်း"
---

# စမ်းသပ်ခြင်း

OpenClaw တွင် Vitest စမ်းသပ်စုစည်းမှု သုံးခု (unit/integration, e2e, live) နှင့် Docker runners အနည်းငယ် ပါဝင်သည်။

ဤစာရွက်စာတမ်းသည် “ဘယ်လို စမ်းသပ်ကြသလဲ” ကိုညွှန်ပြသော လမ်းညွှန်ဖြစ်သည်—

- စုစည်းမှုတစ်ခုချင်းစီက ဖုံးလွှမ်းသည့်အရာများ (နှင့် ရည်ရွယ်ချက်အရ မဖုံးလွှမ်းသည့်အရာများ)
- ပုံမှန်လုပ်ငန်းစဉ်များအတွက် လည်ပတ်ရန် အမိန့်များ (ဒေသတွင်း၊ pre-push၊ debugging)
- Live စမ်းသပ်မှုများက credential များကို ဘယ်လို ရှာဖွေပြီး မော်ဒယ်/ပံ့ပိုးသူများကို ဘယ်လို ရွေးချယ်သလဲ
- လက်တွေ့ကမ္ဘာ မော်ဒယ်/ပံ့ပိုးသူ ပြဿနာများအတွက် regression များ ထည့်သွင်းနည်း

## အမြန်စတင်ရန်

ပုံမှန်နေ့စဉ်—

- Full gate (push မတိုင်မီ မျှော်မှန်းထားသည်): `pnpm build && pnpm check && pnpm test`

စမ်းသပ်မှုများကို ထိတွေ့ပြင်ဆင်ထားသည် သို့မဟုတ် ယုံကြည်ချက် ပိုလိုအပ်ပါက—

- Coverage gate: `pnpm test:coverage`
- E2E စုစည်းမှု: `pnpm test:e2e`

လက်တွေ့ ပံ့ပိုးသူများ/မော်ဒယ်များကို debugging လုပ်နေပါက (အမှန်တကယ်သော creds လိုအပ်)—

- Live စုစည်းမှု (မော်ဒယ်များ + gateway tool/image probes): `pnpm test:live`

အကြံပြုချက်: မအောင်မြင်သော case တစ်ခုသာ လိုအပ်ပါက အောက်တွင် ဖော်ပြထားသော allowlist env vars များဖြင့် live စမ်းသပ်မှုများကို ကျဉ်းမြောင်းစေခြင်းကို ဦးစားပေးပါ။

## စမ်းသပ်စုစည်းမှုများ (ဘယ်မှာ ဘာလုပ်သလဲ)

စုစည်းမှုများကို “လက်တွေ့အဆင့် မြင့်လာခြင်း” (နှင့် flakiness/ကုန်ကျစရိတ် မြင့်လာခြင်း) ဟု တွေးပါ—

### Unit / integration (မူလသတ်မှတ်)

- အမိန့်: `pnpm test`
- Config: `vitest.config.ts`
- ဖိုင်များ: `src/**/*.test.ts`
- Scope:
  - စင်ကြယ်သော unit စမ်းသပ်မှုများ
  - In-process integration စမ်းသပ်မှုများ (gateway auth, routing, tooling, parsing, config)
  - သိရှိထားသော ဘတ်ဂ်များအတွက် သတ်မှတ်ထားသော regression များ
- မျှော်မှန်းချက်များ:
  - CI တွင် လည်ပတ်မည်
  - အမှန်တကယ်သော key များ မလိုအပ်
  - မြန်ဆန်၍ တည်ငြိမ်ရမည်

### E2E (gateway smoke)

- အမိန့်: `pnpm test:e2e`
- Config: `vitest.e2e.config.ts`
- ဖိုင်များ: `src/**/*.e2e.test.ts`
- Scope:
  - Multi-instance gateway end-to-end အပြုအမူ
  - WebSocket/HTTP မျက်နှာပြင်များ၊ node pairing နှင့် ပိုမိုလေးလံသော ကွန်ရက်ဆိုင်ရာအချက်များ
- မျှော်မှန်းချက်များ:
  - Pipeline တွင် enable လုပ်ထားပါက CI တွင် လည်ပတ်မည်
  - အမှန်တကယ်သော key များ မလိုအပ်
  - Unit စမ်းသပ်မှုများထက် အစိတ်အပိုင်းများ ပိုများ (အချိန်ပိုယူနိုင်)

### Live (လက်တွေ့ ပံ့ပိုးသူများ + လက်တွေ့ မော်ဒယ်များ)

- အမိန့်: `pnpm test:live`
- Config: `vitest.live.config.ts`
- ဖိုင်များ: `src/**/*.live.test.ts`
- မူလသတ်မှတ်: `pnpm test:live` ဖြင့် **enable** ဖြစ်သည် (`OPENCLAW_LIVE_TEST=1` ကို သတ်မှတ်ပေးသည်)
- Scope:
  - “ယနေ့နေ့စွဲတွင် အမှန်တကယ် creds ဖြင့် ဤပံ့ပိုးသူ/မော်ဒယ် အလုပ်လုပ်နေပါသလား?”
  - ပံ့ပိုးသူ ဖော်မတ် ပြောင်းလဲမှုများ၊ tool-calling အပြုအမူလှည့်ကွက်များ၊ auth ပြဿနာများနှင့် rate limit အပြုအမူများကို ဖမ်းမိရန်
- မျှော်မှန်းချက်များ:
  - CI-stable မဟုတ်ရန် ရည်ရွယ်ထားသည် (လက်တွေ့ ကွန်ရက်များ၊ ပံ့ပိုးသူ မူဝါဒများ၊ quota များ၊ outage များ)
  - ငွေကုန်ကျစရိတ် / rate limit အသုံးပြုမှု ရှိသည်
  - “အားလုံး” ထက် ကျဉ်းမြောင်းသော subset များကို လည်ပတ်စေခြင်းကို ဦးစားပေးပါ
  - Live လည်ပတ်မှုများသည် ပျောက်နေသော API key များကို ရယူရန် `~/.profile` ကို source လုပ်မည်
  - Anthropic key rotation: `OPENCLAW_LIVE_ANTHROPIC_KEYS="sk-...,sk-..."` (သို့) `OPENCLAW_LIVE_ANTHROPIC_KEY=sk-...` ကို သတ်မှတ်ပါ သို့မဟုတ် `ANTHROPIC_API_KEY*` vars များကို အများအပြား သတ်မှတ်ပါ; rate limit ဖြစ်ပါက စမ်းသပ်မှုများက ပြန်ကြိုးစားမည်

## ဘယ်စုစည်းမှုကို လည်ပတ်သင့်သလဲ?

ဤဆုံးဖြတ်ဇယားကို အသုံးပြုပါ—

- Logic/tests ကို ပြင်ဆင်နေပါက: `pnpm test` (အပြောင်းအလဲများ များပါက `pnpm test:coverage` ကိုပါ)
- Gateway networking / WS protocol / pairing ကို ထိတွေ့ပါက: `pnpm test:e2e` ကို ထည့်ပါ
- “ကျွန်တော့် bot မလုပ်တော့ဘူး” / ပံ့ပိုးသူအလိုက် မအောင်မြင်မှုများ / tool calling ကို debugging လုပ်ပါက: ကျဉ်းမြောင်းထားသော `pnpm test:live` ကို လည်ပတ်ပါ

## Live: မော်ဒယ် smoke (profile keys)

Live စမ်းသပ်မှုများကို အလွှာ နှစ်ခု ခွဲထားပြီး မအောင်မြင်မှုများကို ခွဲခြားနိုင်စေရန်—

- “Direct model” သည် ပံ့ပိုးသူ/မော်ဒယ်က ပေးထားသော key ဖြင့် အနည်းဆုံး အဖြေပြန်နိုင်ကြောင်း ပြသည်။
- “Gateway smoke” သည် မော်ဒယ်အတွက် gateway+အေးဂျင့် pipeline အပြည့်အစုံ (sessions, history, tools, sandbox policy စသည်) အလုပ်လုပ်ကြောင်း ပြသည်။

### အလွှာ ၁: Direct model completion (gateway မပါ)

- စမ်းသပ်မှု: `src/agents/models.profiles.live.test.ts`
- ရည်မှန်းချက်:
  - ရှာဖွေတွေ့ရှိထားသော မော်ဒယ်များကို စာရင်းပြုစုခြင်း
  - ကိုယ်ပိုင် creds ရှိသည့် မော်ဒယ်များကို ရွေးချယ်ရန် `getApiKeyForModel` ကို အသုံးပြုခြင်း
  - မော်ဒယ်တစ်ခုချင်းစီအတွက် completion အနည်းငယ် (လိုအပ်ပါက ရည်ရွယ်ထားသော regression များ) လည်ပတ်ခြင်း
- Enable လုပ်နည်း:
  - `pnpm test:live` (သို့) Vitest ကို တိုက်ရိုက် ခေါ်ဆိုပါက `OPENCLAW_LIVE_TEST=1`
- ဤစုစည်းမှုကို အမှန်တကယ် လည်ပတ်စေရန် `OPENCLAW_LIVE_MODELS=modern` (သို့) ခေတ်သစ် alias ဖြစ်သော `all` ကို သတ်မှတ်ပါ; မဟုတ်ပါက `pnpm test:live` ကို gateway smoke အတွက် အာရုံစိုက်စေရန် skip လုပ်မည်
- မော်ဒယ်ရွေးချယ်နည်း:
  - ခေတ်သစ် allowlist ကို လည်ပတ်ရန် `OPENCLAW_LIVE_MODELS=modern` (Opus/Sonnet/Haiku 4.5, GPT-5.x + Codex, Gemini 3, GLM 4.7, MiniMax M2.1, Grok 4)
  - `OPENCLAW_LIVE_MODELS=all` သည် ခေတ်သစ် allowlist အတွက် alias ဖြစ်သည်
  - သို့မဟုတ် `OPENCLAW_LIVE_MODELS="openai/gpt-5.2,anthropic/claude-opus-4-6,..."` (comma allowlist)
- ပံ့ပိုးသူ ရွေးချယ်နည်း:
  - `OPENCLAW_LIVE_PROVIDERS="google,google-antigravity,google-gemini-cli"` (comma allowlist)
- Key များရင်းမြစ်:
  - မူလသတ်မှတ်: profile store နှင့် env fallbacks
  - **profile store** သာ အသုံးပြုစေရန် `OPENCLAW_LIVE_REQUIRE_PROFILE_KEYS=1` ကို သတ်မှတ်ပါ
- ဤအလွှာ ရှိရခြင်း၏ အကြောင်းရင်း:
  - “ပံ့ပိုးသူ API ပျက်နေသည် / key မမှန်” ကို “gateway အေးဂျင့် pipeline ပျက်နေသည်” မှ ခွဲခြားပေးနိုင်ရန်
  - သေးငယ်ပြီး သီးခြား regression များ ပါဝင်ရန် (ဥပမာ: OpenAI Responses/Codex Responses reasoning replay + tool-call flows)

### အလွှာ ၂: Gateway + dev အေးဂျင့် smoke (“@openclaw” အမှန်တကယ် လုပ်သည့်အရာ)

- စမ်းသပ်မှု: `src/gateway/gateway-models.profiles.live.test.ts`
- ရည်မှန်းချက်:
  - In-process gateway တစ်ခုကို စတင်လည်ပတ်စေခြင်း
  - `agent:dev:*` session တစ်ခုကို ဖန်တီး/ပြင်ဆင်ခြင်း (run တစ်ကြိမ်စီအလိုက် မော်ဒယ် override)
  - key ရှိသည့် မော်ဒယ်များကို လှည့်လည်ပြီး အောက်ပါအချက်များကို အတည်ပြုခြင်း:
    - “အဓိပ္ပါယ်ရှိသော” အဖြေ (tool မပါ)
    - အမှန်တကယ် tool invocation တစ်ခု အလုပ်လုပ်ကြောင်း (read probe)
    - အပို tool probes (exec+read probe) ကို ရွေးချယ်အသုံးပြုနိုင်ခြင်း
    - OpenAI regression လမ်းကြောင်းများ (tool-call-only → follow-up) ဆက်လက် အလုပ်လုပ်နေခြင်း
- Probe အသေးစိတ်များ (မအောင်မြင်မှုများကို လျင်မြန်စွာ ရှင်းပြနိုင်ရန်):
  - `read` probe: စမ်းသပ်မှုသည် workspace တွင် nonce ဖိုင်တစ်ခုကို ရေးပြီး အေးဂျင့်အား `read` ပြုလုပ်ကာ nonce ကို ပြန်လည် echo ပြုလုပ်ရန် တောင်းဆိုသည်။
  - `exec+read` probe: စမ်းသပ်မှုသည် အေးဂျင့်အား nonce ကို temp ဖိုင်တစ်ခုသို့ `exec`-ရေးစေပြီး ထို့နောက် `read` ပြန်လည် ဖတ်ခိုင်းသည်။
  - image probe: စမ်းသပ်မှုသည် ထုတ်လုပ်ထားသော PNG (ကြောင် + အလွဲသတ်မှတ်ထားသော ကုဒ်) ကို တွဲဖက်ပို့ပြီး မော်ဒယ်မှ `cat <CODE>` ကို ပြန်ပေးရန် မျှော်လင့်သည်။
  - Implementation ကို ကိုးကားရန်: `src/gateway/gateway-models.profiles.live.test.ts` နှင့် `src/gateway/live-image-probe.ts`။
- Enable လုပ်နည်း:
  - `pnpm test:live` (သို့) Vitest ကို တိုက်ရိုက် ခေါ်ဆိုပါက `OPENCLAW_LIVE_TEST=1`
- မော်ဒယ်ရွေးချယ်နည်း:
  - မူလသတ်မှတ်: ခေတ်သစ် allowlist (Opus/Sonnet/Haiku 4.5, GPT-5.x + Codex, Gemini 3, GLM 4.7, MiniMax M2.1, Grok 4)
  - `OPENCLAW_LIVE_GATEWAY_MODELS=all` သည် ခေတ်သစ် allowlist အတွက် alias ဖြစ်သည်
  - သို့မဟုတ် `OPENCLAW_LIVE_GATEWAY_MODELS="provider/model"` (သို့ comma စာရင်း) ကို သတ်မှတ်ကာ ကျဉ်းမြောင်းစေပါ
- ပံ့ပိုးသူ ရွေးချယ်နည်း (“OpenRouter အားလုံး” ကို ရှောင်ရန်):
  - `OPENCLAW_LIVE_GATEWAY_PROVIDERS="google,google-antigravity,google-gemini-cli,openai,anthropic,zai,minimax"` (comma allowlist)
- Tool + image probes များသည် ဤ live စမ်းသပ်မှုတွင် အမြဲဖွင့်ထားသည်:
  - `read` probe + `exec+read` probe (tool stress)
  - မော်ဒယ်က image input ကို ကြေညာထားပါက image probe လည်ပတ်မည်
  - Flow (အမြင့်ဆုံးအဆင့်):
    - စမ်းသပ်မှုသည် “CAT” + random code ပါဝင်သည့် သေးငယ်သော PNG တစ်ခုကို ထုတ်လုပ်သည် (`src/gateway/live-image-probe.ts`)
    - `agent` `attachments: [{ mimeType: "image/png", content: "<base64>" }]` ဖြင့် ပို့သည်
    - Gateway သည် attachment များကို `images[]` အဖြစ် ခွဲခြမ်းစိတ်ဖြာသည် (`src/gateway/server-methods/agent.ts` + `src/gateway/chat-attachments.ts`)
    - Embedded အေးဂျင့်သည် multimodal user message ကို မော်ဒယ်ထံ ပို့သည်
    - Assertion: အဖြေတွင် `cat` + ကုဒ် ပါဝင်ရမည် (OCR သည်းခံမှု: အနည်းငယ်သော အမှားများကို ခွင့်ပြု)

အကြံပြုချက်: ကိုယ့်စက်ပေါ်တွင် ဘာတွေ စမ်းသပ်နိုင်သည်ကို (နှင့် တိကျသော `provider/model` id များကို) ကြည့်ရန်—

```bash
openclaw models list
openclaw models list --json
```

## Live: Anthropic setup-token smoke

- စမ်းသပ်မှု: `src/agents/anthropic.setup-token.live.test.ts`
- ရည်မှန်းချက်: Claude Code CLI setup-token (သို့) paste လုပ်ထားသော setup-token profile ဖြင့် Anthropic prompt တစ်ခုကို completion လုပ်နိုင်ကြောင်း အတည်ပြုရန်။
- Enable:
  - `pnpm test:live` (သို့) Vitest ကို တိုက်ရိုက် ခေါ်ဆိုပါက `OPENCLAW_LIVE_TEST=1`
  - `OPENCLAW_LIVE_SETUP_TOKEN=1`
- Token ရင်းမြစ်များ (တစ်ခုရွေး):
  - Profile: `OPENCLAW_LIVE_SETUP_TOKEN_PROFILE=anthropic:setup-token-test`
  - Raw token: `OPENCLAW_LIVE_SETUP_TOKEN_VALUE=sk-ant-oat01-...`
- မော်ဒယ် override (ရွေးချယ်နိုင်):
  - `OPENCLAW_LIVE_SETUP_TOKEN_MODEL=anthropic/claude-opus-4-6`

Setup ဥပမာ:

```bash
openclaw models auth paste-token --provider anthropic --profile-id anthropic:setup-token-test
OPENCLAW_LIVE_SETUP_TOKEN=1 OPENCLAW_LIVE_SETUP_TOKEN_PROFILE=anthropic:setup-token-test pnpm test:live src/agents/anthropic.setup-token.live.test.ts
```

## Live: CLI backend smoke (Claude Code CLI သို့မဟုတ် အခြား ဒေသတွင်း CLI များ)

- စမ်းသပ်မှု: `src/gateway/gateway-cli-backend.live.test.ts`
- ရည်မှန်းချက်: မူလ config ကို မထိတွေ့ဘဲ Gateway + အေးဂျင့် pipeline ကို ဒေသတွင်း CLI backend ဖြင့် အတည်ပြုရန်။
- Enable:
  - `pnpm test:live` (သို့) Vitest ကို တိုက်ရိုက် ခေါ်ဆိုပါက `OPENCLAW_LIVE_TEST=1`
  - `OPENCLAW_LIVE_CLI_BACKEND=1`
- မူလသတ်မှတ်များ:
  - မော်ဒယ်: `claude-cli/claude-sonnet-4-5`
  - အမိန့်: `claude`
  - Args: `["-p","--output-format","json","--dangerously-skip-permissions"]`
- Overrides (ရွေးချယ်နိုင်):
  - `OPENCLAW_LIVE_CLI_BACKEND_MODEL="claude-cli/claude-opus-4-6"`
  - `OPENCLAW_LIVE_CLI_BACKEND_MODEL="codex-cli/gpt-5.3-codex"`
  - `OPENCLAW_LIVE_CLI_BACKEND_COMMAND="/full/path/to/claude"`
  - `OPENCLAW_LIVE_CLI_BACKEND_ARGS='["-p","--output-format","json","--permission-mode","bypassPermissions"]'`
  - `OPENCLAW_LIVE_CLI_BACKEND_CLEAR_ENV='["ANTHROPIC_API_KEY","ANTHROPIC_API_KEY_OLD"]'`
  - `OPENCLAW_LIVE_CLI_BACKEND_IMAGE_PROBE=1` သည် အမှန်တကယ် image attachment တစ်ခုကို ပို့ရန် (paths များကို prompt ထဲသို့ ထည့်သွင်းသည်)
  - `OPENCLAW_LIVE_CLI_BACKEND_IMAGE_ARG="--image"` သည် image ဖိုင်လမ်းကြောင်းများကို prompt ထဲသို့ ထည့်သွင်းမည့်အစား CLI args အဖြစ် ပို့ရန်
  - `OPENCLAW_LIVE_CLI_BACKEND_IMAGE_MODE="repeat"` (သို့) `"list"` သည် `IMAGE_ARG` ကို သတ်မှတ်ထားသောအခါ image args များကို ဘယ်လို ပို့မည်ကို ထိန်းချုပ်ရန်
  - `OPENCLAW_LIVE_CLI_BACKEND_RESUME_PROBE=1` သည် ဒုတိယ turn ကို ပို့ပြီး resume flow ကို အတည်ပြုရန်
- `OPENCLAW_LIVE_CLI_BACKEND_DISABLE_MCP_CONFIG=0` သည် Claude Code CLI MCP config ကို ဆက်လက် enable ထားရန် (မူလသတ်မှတ်သည် MCP config ကို ယာယီ အလွတ်ဖိုင်ဖြင့် disable လုပ်သည်)

ဥပမာ:

```bash
OPENCLAW_LIVE_CLI_BACKEND=1 \
  OPENCLAW_LIVE_CLI_BACKEND_MODEL="claude-cli/claude-sonnet-4-5" \
  pnpm test:live src/gateway/gateway-cli-backend.live.test.ts
```

### အကြံပြု live recipes

ကျဉ်းမြောင်း၍ ထင်ရှားသော allowlist များသည် အမြန်ဆုံးနှင့် flakiness အနည်းဆုံး ဖြစ်သည်—

- မော်ဒယ်တစ်ခုတည်း၊ direct (gateway မပါ):
  - `OPENCLAW_LIVE_MODELS="openai/gpt-5.2" pnpm test:live src/agents/models.profiles.live.test.ts`

- မော်ဒယ်တစ်ခုတည်း၊ gateway smoke:
  - `OPENCLAW_LIVE_GATEWAY_MODELS="openai/gpt-5.2" pnpm test:live src/gateway/gateway-models.profiles.live.test.ts`

- ပံ့ပိုးသူ အမျိုးအစားအများအပြားအပေါ် tool calling:
  - `OPENCLAW_LIVE_GATEWAY_MODELS="openai/gpt-5.2,anthropic/claude-opus-4-6,google/gemini-3-flash-preview,zai/glm-4.7,minimax/minimax-m2.1" pnpm test:live src/gateway/gateway-models.profiles.live.test.ts`

- Google ကို အာရုံစိုက်ခြင်း (Gemini API key + Antigravity):
  - Gemini (API key): `OPENCLAW_LIVE_GATEWAY_MODELS="google/gemini-3-flash-preview" pnpm test:live src/gateway/gateway-models.profiles.live.test.ts`
  - Antigravity (OAuth): `OPENCLAW_LIVE_GATEWAY_MODELS="google-antigravity/claude-opus-4-6-thinking,google-antigravity/gemini-3-pro-high" pnpm test:live src/gateway/gateway-models.profiles.live.test.ts`

မှတ်ချက်များ:

- `google/...` သည် Gemini API (API key) ကို အသုံးပြုသည်။
- `google-antigravity/...` သည် Antigravity OAuth bridge (Cloud Code Assist စတိုင် အေးဂျင့် endpoint) ကို အသုံးပြုသည်။
- `google-gemini-cli/...` သည် ကိုယ့်စက်ပေါ်ရှိ local Gemini CLI ကို အသုံးပြုသည် (သီးခြား auth + tooling အပြုအမူများ)။
- Gemini API နှင့် Gemini CLI:
  - API: OpenClaw သည် Google ၏ hosted Gemini API ကို HTTP ဖြင့် ခေါ်ဆိုသည် (API key / profile auth); အသုံးပြုသူအများစုက “Gemini” ဟု ဆိုသည်မှာ ဤအရာကို ဆိုလိုသည်။
  - CLI: OpenClaw သည် ဒေသတွင်း `gemini` binary ကို shell ထုတ်ခေါ်သည်; ၎င်းတွင် ကိုယ်ပိုင် auth ရှိပြီး အပြုအမူ ကွာခြားနိုင်သည် (streaming/tool support/version skew)။

## Live: မော်ဒယ် မက်ထရစ်စ် (ဘာတွေကို ဖုံးလွှမ်းထားသလဲ)

Live သည် opt-in ဖြစ်သဖြင့် တိကျသော “CI မော်ဒယ်စာရင်း” မရှိသော်လည်း၊ key ရှိသော dev စက်ပေါ်တွင် ပုံမှန် ဖုံးလွှမ်းသင့်သည့် **အကြံပြု** မော်ဒယ်များမှာ အောက်ပါအတိုင်းဖြစ်သည်။

### ခေတ်သစ် smoke set (tool calling + image)

အလုပ်လုပ်နေသင့်ကြောင်း မျှော်လင့်ထားသော “အသုံးများသော မော်ဒယ်များ” run ဖြစ်သည်—

- OpenAI (Codex မပါ): `openai/gpt-5.2` (ရွေးချယ်နိုင်: `openai/gpt-5.1`)
- OpenAI Codex: `openai-codex/gpt-5.3-codex` (ရွေးချယ်နိုင်: `openai-codex/gpt-5.3-codex-codex`)
- Anthropic: `anthropic/claude-opus-4-6` (သို့) `anthropic/claude-sonnet-4-5`)
- Google (Gemini API): `google/gemini-3-pro-preview` နှင့် `google/gemini-3-flash-preview` (အဟောင်း Gemini 2.x မော်ဒယ်များကို ရှောင်ပါ)
- Google (Antigravity): `google-antigravity/claude-opus-4-6-thinking` နှင့် `google-antigravity/gemini-3-flash`
- Z.AI (GLM): `zai/glm-4.7`
- MiniMax: `minimax/minimax-m2.1`

Tools + image ဖြင့် gateway smoke ကို လည်ပတ်ရန်:
`OPENCLAW_LIVE_GATEWAY_MODELS="openai/gpt-5.2,openai-codex/gpt-5.3-codex,anthropic/claude-opus-4-6,google/gemini-3-pro-preview,google/gemini-3-flash-preview,google-antigravity/claude-opus-4-6-thinking,google-antigravity/gemini-3-flash,zai/glm-4.7,minimax/minimax-m2.1" pnpm test:live src/gateway/gateway-models.profiles.live.test.ts`

### အခြေခံ: tool calling (Read + ရွေးချယ်နိုင်သော Exec)

ပံ့ပိုးသူ မိသားစုတစ်ခုလျှင် အနည်းဆုံး တစ်ခုရွေးပါ—

- OpenAI: `openai/gpt-5.2` (သို့) `openai/gpt-5-mini`)
- Anthropic: `anthropic/claude-opus-4-6` (သို့) `anthropic/claude-sonnet-4-5`)
- Google: `google/gemini-3-flash-preview` (သို့) `google/gemini-3-pro-preview`)
- Z.AI (GLM): `zai/glm-4.7`
- MiniMax: `minimax/minimax-m2.1`

ရွေးချယ်နိုင်သော အပို ဖုံးလွှမ်းမှု (ရှိရင် ကောင်း):

- xAI: `xai/grok-4` (သို့) နောက်ဆုံး ရနိုင်သော မော်ဒယ်)
- Mistral: `mistral/`… (သင်ဖွင့်ထားသော “tools” အသုံးပြုနိုင်သော model တစ်ခုကို ရွေးချယ်ပါ)
- Cerebras: `cerebras/`… (သင် ဝင်ရောက်ခွင့် ရှိရင်)
- LM Studio: `lmstudio/`… (local; tool calling သည် API mode ပေါ်မူတည်သည်)

### Vision: image ပို့ခြင်း (attachment → multimodal message)

`OPENCLAW_LIVE_GATEWAY_MODELS` ထဲတွင် image ကို ကိုင်တွယ်နိုင်သော model အနည်းဆုံး တစ်ခု (Claude/Gemini/OpenAI vision-capable variants စသည်) ကို ထည့်သွင်းပါ။ image probe ကို စမ်းသပ်ရန်။

### Aggregators / အစားထိုး gateway များ

Key များ enable ဖြစ်ပါက အောက်ပါများမှတဆင့် စမ်းသပ်နိုင်သည်—

- OpenRouter: `openrouter/...` (မော်ဒယ် ရာချီ; tool+image စွမ်းရည်ရှိ candidate များကို ရှာရန် `openclaw models scan` ကို အသုံးပြုပါ)
- OpenCode Zen: `opencode/...` (auth ကို `OPENCODE_API_KEY` / `OPENCODE_ZEN_API_KEY` ဖြင့်)

Live မက်ထရစ်စ်တွင် ထည့်သွင်းနိုင်သော ပံ့ပိုးသူများ (creds/config ရှိပါက):

- Built-in: `openai`, `openai-codex`, `anthropic`, `google`, `google-vertex`, `google-antigravity`, `google-gemini-cli`, `zai`, `openrouter`, `opencode`, `xai`, `groq`, `cerebras`, `mistral`, `github-copilot`
- `models.providers` မှတဆင့် (custom endpoints): `minimax` (cloud/API) နှင့် OpenAI/Anthropic-compatible proxy မည်သည့်အရာမဆို (LM Studio, vLLM, LiteLLM စသည်)

အကြံပြုချက်: docs ထဲတွင် “all models” ကို hardcode မလုပ်ပါနှင့်။ အာဏာရှိသော စာရင်းမှာ သင့်စက်ပေါ်တွင် `discoverModels(...)` ပြန်လာသည့်အရာ + ရရှိနိုင်သော key များ ဖြစ်ပါသည်။

## Credentials (မည်သည့်အခါမှ commit မလုပ်ပါ)

Live tests တွေက CLI လိုပဲ credentials ကို ရှာဖွေ တွေ့ရှိပါတယ်။ လက်တွေ့ဆိုင်ရာ အကျိုးသက်ရောက်မှုများ:

- CLI အလုပ်လုပ်ပါက live စမ်းသပ်မှုများလည်း တူညီသော key များကို ရှာဖွေတွေ့ရှိသင့်သည်။

- Live စမ်းသပ်မှုတစ်ခုက “no creds” ဟု ဆိုပါက `openclaw models list` / မော်ဒယ်ရွေးချယ်မှုကို debug လုပ်သည့် နည်းတူ debug လုပ်ပါ။

- Profile store: `~/.openclaw/credentials/` (အကြံပြု; စမ်းသပ်မှုများတွင် “profile keys” ဟု ဆိုသည်မှာ ဤအရာ)

- Config: `~/.openclaw/openclaw.json` (သို့) `OPENCLAW_CONFIG_PATH`)

Env key များကို ယုံကြည်အသုံးပြုလိုပါက (ဥပမာ `~/.profile` တွင် export လုပ်ထားခြင်း) `source ~/.profile` ပြုလုပ်ပြီးနောက် ဒေသတွင်း စမ်းသပ်မှုများကို လည်ပတ်ပါ သို့မဟုတ် အောက်ပါ Docker runners များကို အသုံးပြုပါ (၎င်းတို့သည် `~/.profile` ကို container ထဲသို့ mount လုပ်နိုင်သည်)။

## Deepgram live (အသံမှ စာသားပြန်ရေး)

- စမ်းသပ်မှု: `src/media-understanding/providers/deepgram/audio.live.test.ts`
- ဖွင့်ရန်: `DEEPGRAM_API_KEY=... DEEPGRAM_LIVE_TEST=1 pnpm test:live src/media-understanding/providers/deepgram/audio.live.test.ts`

## Docker runners (ရွေးချယ်နိုင်သော “Linux တွင် အလုပ်လုပ်ကြောင်း” စစ်ဆေးမှုများ)

Repo Docker image အတွင်း `pnpm test:live` ကို လည်ပတ်စေပြီး သင့်ဒေသတွင်း config dir နှင့် workspace ကို mount လုပ်ကာ (`~/.profile` ကို mount လုပ်ထားပါက source လုပ်သည်)—

- Direct models: `pnpm test:docker:live-models` (script: `scripts/test-live-models-docker.sh`)
- Gateway + dev အေးဂျင့်: `pnpm test:docker:live-gateway` (script: `scripts/test-live-gateway-models-docker.sh`)
- Onboarding wizard (TTY, scaffolding အပြည့်အစုံ): `pnpm test:docker:onboard` (script: `scripts/e2e/onboard-docker.sh`)
- Gateway networking (containers နှစ်ခု, WS auth + health): `pnpm test:docker:gateway-network` (script: `scripts/e2e/gateway-network-docker.sh`)
- Plugins (custom extension load + registry smoke): `pnpm test:docker:plugins` (script: `scripts/e2e/plugins-docker.sh`)

အသုံးဝင်သော env vars များ—

- `OPENCLAW_CONFIG_DIR=...` (မူလသတ်မှတ်: `~/.openclaw`) ကို `/home/node/.openclaw` သို့ mount လုပ်သည်
- `OPENCLAW_WORKSPACE_DIR=...` (မူလသတ်မှတ်: `~/.openclaw/workspace`) ကို `/home/node/.openclaw/workspace` သို့ mount လုပ်သည်
- `OPENCLAW_PROFILE_FILE=...` (မူလသတ်မှတ်: `~/.profile`) ကို `/home/node/.profile` သို့ mount လုပ်ပြီး စမ်းသပ်မှုများ မစတင်မီ source လုပ်သည်
- `OPENCLAW_LIVE_GATEWAY_MODELS=...` / `OPENCLAW_LIVE_MODELS=...` ဖြင့် run ကို ကျဉ်းမြောင်းစေပါ
- `OPENCLAW_LIVE_REQUIRE_PROFILE_KEYS=1` ဖြင့် creds များကို profile store မှသာ ရယူစေပါ (env မဟုတ်)

## Docs sanity

Doc ပြင်ဆင်ပြီးနောက် docs စစ်ဆေးမှုများကို လည်ပတ်ပါ: `pnpm docs:list`။

## Offline regression (CI-လုံခြုံ)

အမှန်တကယ် ပံ့ပိုးသူများ မပါဘဲ “pipeline အမှန်တကယ်” regression များ—

- Gateway tool calling (mock OpenAI, real gateway + အေးဂျင့် loop): `src/gateway/gateway.tool-calling.mock-openai.test.ts`
- Gateway wizard (WS `wizard.start`/`wizard.next`, config ရေးသားပြီး auth အတည်ပြု): `src/gateway/gateway.wizard.e2e.test.ts`

## Agent ယုံကြည်နိုင်မှု evals (skills)

CI-လုံခြုံဖြစ်ပြီး “agent ယုံကြည်နိုင်မှု evals” ကဲ့သို့ လုပ်ဆောင်သော စမ်းသပ်မှုအချို့ ရှိပြီးသားဖြစ်သည်—

- Real gateway + အေးဂျင့် loop ဖြင့် mock tool-calling (`src/gateway/gateway.tool-calling.mock-openai.test.ts`)။
- Session wiring နှင့် config အကျိုးသက်ရောက်မှုများကို အတည်ပြုသော end-to-end wizard flows (`src/gateway/gateway.wizard.e2e.test.ts`)။

Skills အတွက် မရှိသေးသည့်အရာများ ([Skills](/tools/skills) ကို ကြည့်ပါ)—

- **ဆုံးဖြတ်ချက်ချခြင်း:** prompt တွင် skills များ စာရင်းပြုလုပ်ထားသောအခါ အေးဂျင့်က သင့်တော်သော skill ကို ရွေးချယ်နိုင်သလား (သို့) မသက်ဆိုင်သည့်အရာများကို ရှောင်ရှားနိုင်သလား?
- **လိုက်နာမှု:** အသုံးမပြုမီ `SKILL.md` ကို ဖတ်ပြီး လိုအပ်သော အဆင့်များ/args များကို လိုက်နာသလား?
- **Workflow စာချုပ်များ:** tool အစဉ်လိုက်၊ session history ဆက်လက်သယ်ဆောင်မှု၊ sandbox အကန့်အသတ်များကို အတည်ပြုသော multi-turn စင်နာရီယိုများ။

အနာဂတ် evals များသည် အရင်ဆုံး deterministic ဖြစ်နေသင့်သည်—

- Mock providers များကို အသုံးပြုကာ tool calls + အစဉ်လိုက်၊ skill ဖိုင်ဖတ်ခြင်းနှင့် session wiring ကို အတည်ပြုသော scenario runner တစ်ခု။
- Skill ကို အာရုံစိုက်သည့် scenario အနည်းငယ် (အသုံးပြု vs ရှောင်ရှား, gating, prompt injection)။
- CI-လုံခြုံ စုစည်းမှု တည်ဆောက်ပြီးမှသာ optional live evals (opt-in, env-gated) ကို ထည့်သွင်းရန်။

## Regressions ထည့်သွင်းခြင်း (လမ်းညွှန်)

Live တွင် တွေ့ရှိသော ပံ့ပိုးသူ/မော်ဒယ် ပြဿနာတစ်ခုကို ပြုပြင်ပြီးပါက—

- ဖြစ်နိုင်ပါက CI-လုံခြုံ regression တစ်ခု ထည့်ပါ (provider ကို mock/stub လုပ်ခြင်း သို့မဟုတ် request-shape ပြောင်းလဲမှုကို တိတိကျကျ ဖမ်းယူခြင်း)
- Live-only ဖြစ်ရန် မလွဲမရှောင်သာပါက (rate limits, auth မူဝါဒများ) live စမ်းသပ်မှုကို ကျဉ်းမြောင်းစေပြီး env vars ဖြင့် opt-in လုပ်ထားပါ
- ဘတ်ဂ်ကို ဖမ်းမိနိုင်သည့် အနည်းဆုံး အလွှာကို ဦးစားပေးပါ—
  - provider request conversion/replay ဘတ်ဂ် → direct models စမ်းသပ်မှု
  - gateway session/history/tool pipeline ဘတ်ဂ် → gateway live smoke သို့မဟုတ် CI-လုံခြုံ gateway mock စမ်းသပ်မှု
