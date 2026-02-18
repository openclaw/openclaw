---
summary: "OpenClaw ရှိ OAuth — တိုကင်လဲလှယ်မှု၊ သိမ်းဆည်းမှု၊ နှင့် အကောင့်အများအပြား ပုံစံများ"
read_when:
  - OpenClaw OAuth ကို အစမှအဆုံး နားလည်လိုသောအခါ
  - တိုကင် မမှန်တော့ခြင်း / ထွက်ခွာသွားခြင်း ပြဿနာများကို ကြုံတွေ့သောအခါ
  - setup-token သို့မဟုတ် OAuth auth လမ်းကြောင်းများကို လိုအပ်သောအခါ
  - အကောင့်အများအပြား သို့မဟုတ် ပရိုဖိုင် လမ်းကြောင်းပြုလုပ်ခြင်းကို လိုအပ်သောအခါ
title: "OAuth"
---

# OAuth

၁၅။ OpenClaw သည် OAuth ကို ပံ့ပိုးပေးသော providers များအတွက် “subscription auth” ကို support လုပ်ပါသည် (အထူးသဖြင့် **OpenAI Codex (ChatGPT OAuth)**)။ ၁၆။ Anthropic subscriptions များအတွက် **setup-token** flow ကို အသုံးပြုပါ။ ၁၇။ ဤစာမျက်နှာတွင် ရှင်းပြထားသည်မှာ:

- OAuth **token exchange** အလုပ်လုပ်ပုံ (PKCE)
- တိုကင်များကို **ဘယ်နေရာမှာ သိမ်းဆည်းထားသည်** (နှင့် အကြောင်းရင်း)
- **အကောင့်အများအပြား** ကို ကိုင်တွယ်နည်း (profiles + per-session overrides)

၁၈။ OpenClaw သည် ကိုယ်ပိုင် OAuth သို့မဟုတ် API-key flows များပါဝင်သော **provider plugins** များကိုလည်း support လုပ်ပါသည်။ ၁၉။ အောက်ပါအတိုင်း run လုပ်ပါ:

```bash
openclaw models auth login --provider <id>
```

## Token sink (ဘာကြောင့် လိုအပ်သလဲ)

၂၀။ OAuth providers များသည် login/refresh flows အတွင်း **refresh token အသစ်တစ်ခု** ကို မကြာခဏ ထုတ်ပေးလေ့ရှိပါသည်။ ၂၁။ Provider အချို့ (သို့မဟုတ် OAuth clients အချို့) သည် user/app တစ်ခုတည်းအတွက် အသစ်သော refresh token ထုတ်ပေးသည့်အခါ အဟောင်း refresh tokens များကို invalidate လုပ်နိုင်ပါသည်။

လက်တွေ့ တွေ့ရတတ်သော လက္ခဏာ—

- OpenClaw မှတစ်ဆင့် _နှင့်_ Claude Code / Codex CLI မှတစ်ဆင့် login ဝင်ထားပါက နောက်ပိုင်းတွင် တစ်ဖက်က မမျှော်လင့်ဘဲ “logged out” ဖြစ်သွားခြင်း

ယင်းကို လျှော့ချရန် OpenClaw သည် `auth-profiles.json` ကို **token sink** အဖြစ် ဆောင်ရွက်စေပါသည်—

- runtime သည် အထောက်အထားများကို **တစ်နေရာတည်း** မှ ဖတ်ယူသည်
- ပရိုဖိုင် အများအပြားကို ထိန်းသိမ်းထားနိုင်ပြီး လမ်းကြောင်းရွေးချယ်မှုကို သေချာစွာ ဆောင်ရွက်နိုင်သည်

## Storage (တိုကင်များ ဘယ်မှာ ရှိသလဲ)

လျှို့ဝှက်ချက်များကို **အေးဂျင့်တစ်ခုချင်းစီအလိုက်** သိမ်းဆည်းထားပါသည်—

- Auth profiles (OAuth + API keys): `~/.openclaw/agents/<agentId>/agent/auth-profiles.json`
- Runtime cache (အလိုအလျောက် စီမံခန့်ခွဲထားသည်; မပြင်ဆင်ပါနှင့်): `~/.openclaw/agents/<agentId>/agent/auth.json`

Legacy import-only ဖိုင် (ထောက်ပံ့ဆဲ ဖြစ်သော်လည်း အဓိက သိုလှောင်ရာ မဟုတ်ပါ)—

- `~/.openclaw/credentials/oauth.json` (ပထမဆုံး အသုံးပြုချိန်တွင် `auth-profiles.json` သို့ import လုပ်ပါသည်)

၂၂။ အထက်ပါအရာအားလုံးသည် `$OPENCLAW_STATE_DIR` (state dir override) ကိုလည်း လေးစားလိုက်နာပါသည်။ ၂၃။ အပြည့်အစုံ reference: [/gateway/configuration](/gateway/configuration#auth-storage-oauth--api-keys)

## Anthropic setup-token (subscription auth)

မည်သည့် စက်မဆိုတွင် `claude setup-token` ကို လုပ်ဆောင်ပြီး ထွက်လာသော တိုကင်ကို OpenClaw ထဲသို့ ကူးထည့်ပါ—

```bash
openclaw models auth setup-token --provider anthropic
```

အခြားနေရာတွင် တိုကင်ကို ဖန်တီးထားပြီးသား ဖြစ်ပါက ကိုယ်တိုင် ကူးထည့်နိုင်ပါသည်—

```bash
openclaw models auth paste-token --provider anthropic
```

စစ်ဆေးရန်—

```bash
openclaw models status
```

## OAuth exchange (login အလုပ်လုပ်ပုံ)

OpenClaw ၏ interactive login လမ်းကြောင်းများကို `@mariozechner/pi-ai` တွင် အကောင်အထည်ဖော်ထားပြီး wizard များ/commands များနှင့် ချိတ်ဆက်ထားပါသည်။

### Anthropic (Claude Pro/Max) setup-token

Flow ပုံစံ—

1. `claude setup-token` ကို လုပ်ဆောင်ပါ
2. တိုကင်ကို OpenClaw ထဲသို့ ကူးထည့်ပါ
3. token auth profile အဖြစ် သိမ်းဆည်းပါ (refresh မရှိ)

Wizard လမ်းကြောင်းမှာ `openclaw onboard` → auth choice `setup-token` (Anthropic) ဖြစ်ပါသည်။

### OpenAI Codex (ChatGPT OAuth)

Flow ပုံစံ (PKCE)—

1. PKCE verifier/challenge + အမှတ်မဲ့ `state` ကို ဖန်တီးပါ
2. `https://auth.openai.com/oauth/authorize?...` ကို ဖွင့်ပါ
3. `http://127.0.0.1:1455/auth/callback` တွင် callback ကို ဖမ်းယူရန် ကြိုးစားပါ
4. callback ကို bind မလုပ်နိုင်ပါက (သို့မဟုတ် remote/headless ဖြစ်ပါက) redirect URL/code ကို ကူးထည့်ပါ
5. `https://auth.openai.com/oauth/token` တွင် exchange ပြုလုပ်ပါ
6. access token မှ `accountId` ကို ထုတ်ယူပြီး `{ access, refresh, expires, accountId }` ကို သိမ်းဆည်းပါ

Wizard လမ်းကြောင်းမှာ `openclaw onboard` → auth choice `openai-codex` ဖြစ်ပါသည်။

## Refresh + expiry

Profile များတွင် `expires` အချိန်တံဆိပ်ကို သိမ်းဆည်းထားပါသည်။

Runtime အချိန်တွင်—

- `expires` သည် အနာဂတ်တွင် ရှိနေပါက → သိမ်းဆည်းထားသော access token ကို အသုံးပြုပါ
- သက်တမ်းကုန်ပါက → (file lock အောက်တွင်) refresh လုပ်ပြီး သိမ်းဆည်းထားသော အထောက်အထားများကို အစားထိုးရေးသားပါ

Refresh လမ်းကြောင်းသည် အလိုအလျောက် ဖြစ်ပါသည်; ပုံမှန်အားဖြင့် တိုကင်များကို ကိုယ်တိုင် စီမံခန့်ခွဲရန် မလိုအပ်ပါ။

## အကောင့်အများအပြား (profiles) + routing

ပုံစံ နှစ်မျိုး—

### 1. ဦးစားပေး: အေးဂျင့် ခွဲခြားအသုံးပြုခြင်း

“ကိုယ်ရေးကိုယ်တာ” နှင့် “အလုပ်” ကို မည်သည့်အခါမှ မပေါင်းစပ်စေချင်ပါက အေးဂျင့်များကို သီးခြားခွဲအသုံးပြုပါ (sessions + credentials + workspace သီးခြား)—

```bash
openclaw agents add work
openclaw agents add personal
```

ထို့နောက် အေးဂျင့်တစ်ခုချင်းစီအလိုက် auth ကို (wizard ဖြင့်) ဖွဲ့စည်းပြီး ချတ်များကို မှန်ကန်သော အေးဂျင့်သို့ လမ်းကြောင်းပြုလုပ်ပါ။

### 2. အဆင့်မြင့်: အေးဂျင့်တစ်ခုအတွင်း ပရိုဖိုင် အများအပြား

`auth-profiles.json` သည် provider တစ်ခုတည်းအတွက် profile ID အများအပြားကို ပံ့ပိုးပါသည်။

အသုံးပြုမည့် ပရိုဖိုင်ကို ရွေးချယ်ရန်—

- config ordering ဖြင့် အလုံးစုံ အဆင့်တွင် (`auth.order`)
- session တစ်ခုချင်းစီအလိုက် `/model ...@<profileId>` ဖြင့်

ဥပမာ (session override)—

- `/model Opus@anthropic:work`

ရှိပြီးသား profile ID များကို ကြည့်ရန်—

- `openclaw channels list --json` (`auth[]` ကို ပြသပါသည်)

ဆက်စပ်စာရွက်စာတမ်းများ—

- [/concepts/model-failover](/concepts/model-failover) (rotation + cooldown စည်းမျဉ်းများ)
- [/tools/slash-commands](/tools/slash-commands) (command surface)
