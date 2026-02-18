---
summary: "ဘယ်အရာတွေက ငွေကုန်ကျနိုင်တယ်၊ ဘယ်ကီးတွေကို အသုံးပြုထားတယ်ဆိုတာ၊ အသုံးပြုမှုကို ဘယ်လိုကြည့်ရှုမလဲဆိုတာကို စစ်ဆေးခြင်း"
read_when:
  - အခကြေးငွေရှိသော API များကို ခေါ်နိုင်သော အင်္ဂါရပ်များကို နားလည်လိုသောအခါ
  - ကီးများ၊ ကုန်ကျစရိတ်များနှင့် အသုံးပြုမှုမြင်သာမှုကို စစ်ဆေးလိုသောအခါ
  - /status သို့မဟုတ် /usage ကုန်ကျစရိတ် အစီရင်ခံမှုကို ရှင်းပြရန်လိုသောအခါ
title: "API အသုံးပြုမှုနှင့် ကုန်ကျစရိတ်များ"
---

# API အသုံးပြုမှုနှင့် ကုန်ကျစရိတ်များ

ဤစာရွက်စာတမ်းတွင် **API keys ကို ခေါ်ယူနိုင်သော features များ** နှင့် ၎င်းတို့၏ ကုန်ကျစရိတ် ပေါ်ထွက်လာရာ နေရာများကို စာရင်းပြုစုထားပါသည်။ ၎င်းသည် provider usage သို့မဟုတ် paid API calls ကို ဖန်တီးနိုင်သော OpenClaw features များကို အဓိက အာရုံစိုက်ထားပါသည်။

## ကုန်ကျစရိတ်များ ပြသသည့်နေရာများ (chat + CLI)

**ဆက်ရှင်တစ်ခုချင်းစီအလိုက် ကုန်ကျစရိတ် အကျဉ်းချုပ်**

- `/status` သည် လက်ရှိ ဆက်ရှင် မော်ဒယ်၊ context အသုံးပြုမှုနှင့် နောက်ဆုံးတုံ့ပြန်ချက်၏ tokens များကို ပြသသည်။
- မော်ဒယ်က **API-key auth** ကို အသုံးပြုပါက `/status` သည် နောက်ဆုံးတုံ့ပြန်ချက်အတွက် **ခန့်မှန်း ကုန်ကျစရိတ်** ကိုပါ ပြသသည်။

**မက်ဆေ့ချ်တစ်ခုချင်းစီအောက် ကုန်ကျစရိတ် ဖူတာ**

- `/usage full` သည် မက်ဆေ့ချ်တုံ့ပြန်ချက်တိုင်း၏ အောက်တွင် အသုံးပြုမှု ဖူတာကို ထည့်သွင်းပြီး **ခန့်မှန်း ကုန်ကျစရိတ်** (API-key သာလျှင်) ကို ပါဝင်စေသည်။
- `/usage tokens` သည် tokens များကိုသာ ပြသပြီး OAuth flow များတွင် ဒေါ်လာ ကုန်ကျစရိတ်ကို ဖျောက်ထားသည်။

**CLI အသုံးပြုမှု ပြတင်းပေါက်များ (provider quota များ)**

- `openclaw status --usage` နှင့် `openclaw channels list` တို့သည် provider **အသုံးပြုမှု ပြတင်းပေါက်များ** ကို ပြသသည်
  (မက်ဆေ့ချ်တစ်ခုချင်းစီအလိုက် ကုန်ကျစရိတ် မဟုတ်ဘဲ quota အကျဉ်းချုပ်များ)။

အသေးစိတ်နှင့် ဥပမာများအတွက် [Token use & costs](/reference/token-use) ကို ကြည့်ပါ။

## ကီးများကို ဘယ်လို ရှာဖွေတွေ့ရှိသလဲ

OpenClaw သည် အောက်ပါနေရာများမှ အထောက်အထားများကို ရယူနိုင်သည်-

- **Auth profiles** (အေးဂျင့်တစ်ခုချင်းစီအလိုက်၊ `auth-profiles.json` တွင် သိမ်းဆည်းထားသည်)။
- **Environment variables** (ဥပမာ `OPENAI_API_KEY`, `BRAVE_API_KEY`, `FIRECRAWL_API_KEY`)။
- **Config** (`models.providers.*.apiKey`, `tools.web.search.*`, `tools.web.fetch.firecrawl.*`,
  `memorySearch.*`, `talk.apiKey`)။
- **Skills** (`skills.entries.<name>``.apiKey`) သည် key များကို skill process env သို့ export လုပ်နိုင်ပါသည်။

## ကီးများကို သုံးစွဲနိုင်သော အင်္ဂါရပ်များ

### 1. အခြေခံ မော်ဒယ် တုံ့ပြန်ချက်များ (chat + tools)

reply သို့မဟုတ် tool call တစ်ခုချင်းစီသည် **လက်ရှိ model provider** (OpenAI, Anthropic, စသည်) ကို အသုံးပြုပါသည်။ ၎င်းသည် usage နှင့် cost ၏ အဓိက အရင်းအမြစ် ဖြစ်ပါသည်။

စျေးနှုန်း ဖွဲ့စည်းမှုအတွက် [Models](/providers/models) နှင့် ပြသပုံအတွက် [Token use & costs](/reference/token-use) ကို ကြည့်ပါ။

### 2. မီဒီယာ နားလည်မှု (audio/image/video)

Inbound media များကို reply မစတင်မီ summarize/transcribe လုပ်နိုင်ပါသည်။ ၎င်းသည် model/provider APIs များကို အသုံးပြုပါသည်။

- Audio: OpenAI / Groq / Deepgram (ကီးများ ရှိပါက **အလိုအလျောက် ဖွင့်ထားသည်**)။
- Image: OpenAI / Anthropic / Google။
- Video: Google။

[Media understanding](/nodes/media-understanding) ကို ကြည့်ပါ။

### 3. မှတ်ဉာဏ် embeddings + အဓိပ္ပါယ်အခြေပြု ရှာဖွေမှု

Remote provider များအတွက် ပြင်ဆင်ထားပါက အဓိပ္ပါယ်အခြေပြု မှတ်ဉာဏ် ရှာဖွေမှုသည် **embedding API များ** ကို အသုံးပြုသည်-

- `memorySearch.provider = "openai"` → OpenAI embeddings
- `memorySearch.provider = "gemini"` → Gemini embeddings
- `memorySearch.provider = "voyage"` → Voyage embeddings
- Local embeddings မအောင်မြင်ပါက remote provider သို့ အစားထိုး အသုံးပြုနိုင်သည်

`memorySearch.provider = "local"` ဖြင့် local အဖြစ် ထားနိုင်ပြီး (API အသုံးပြုမှု မရှိပါ)။

[Memory](/concepts/memory) ကို ကြည့်ပါ။

### 4. Web search tool (Brave / Perplexity via OpenRouter)

`web_search` သည် API ကီးများကို အသုံးပြုပြီး အသုံးပြုမှု ကုန်ကျစရိတ် ဖြစ်ပေါ်နိုင်သည်-

- **Brave Search API**: `BRAVE_API_KEY` သို့မဟုတ် `tools.web.search.apiKey`
- **Perplexity** (OpenRouter မှတစ်ဆင့်): `PERPLEXITY_API_KEY` သို့မဟုတ် `OPENROUTER_API_KEY`

**Brave free tier (ရက်ရော):**

- **လစဉ် 2,000 requests**
- **စက္ကန့်လျှင် 1 request**
- **အတည်ပြုရန် ခရက်ဒစ်ကတ် လိုအပ်သည်** (အဆင့်မြှင့်မချင်း အခကြေးငွေ မရှိ)

[Web tools](/tools/web) ကို ကြည့်ပါ။

### 5. Web fetch tool (Firecrawl)

API ကီး ရှိပါက `web_fetch` သည် **Firecrawl** ကို ခေါ်နိုင်သည်-

- `FIRECRAWL_API_KEY` သို့မဟုတ် `tools.web.fetch.firecrawl.apiKey`

Firecrawl မပြင်ဆင်ထားပါက tool သည် direct fetch + readability သို့ ပြန်လည်ကျသွားပြီး (အခကြေးငွေရှိသော API မဟုတ်ပါ)။

[Web tools](/tools/web) ကို ကြည့်ပါ။

### 6. Provider အသုံးပြုမှု အကျဉ်းချုပ်များ (status/health)

Some status commands call **provider usage endpoints** to display quota windows or auth health.
ဤအရာများသည် ပုံမှန်အားဖြင့် low-volume calls များဖြစ်သော်လည်း provider APIs များကို ထိတွေ့နေဆဲ ဖြစ်ပါသည် —

- `openclaw status --usage`
- `openclaw models status --json`

[Models CLI](/cli/models) ကို ကြည့်ပါ။

### 7. Compaction safeguard အကျဉ်းချုပ်

Compaction safeguard သည် **လက်ရှိ မော်ဒယ်** ကို အသုံးပြုပြီး ဆက်ရှင် မှတ်တမ်းကို အကျဉ်းချုပ်နိုင်ပြီး၊ လည်ပတ်သောအခါ provider API များကို ခေါ်သည်။

[Session management + compaction](/reference/session-management-compaction) ကို ကြည့်ပါ။

### 8. မော်ဒယ် scan / probe

`openclaw models scan` သည် OpenRouter မော်ဒယ်များကို probe လုပ်နိုင်ပြီး probe ကို ဖွင့်ထားပါက `OPENROUTER_API_KEY` ကို အသုံးပြုသည်။

[Models CLI](/cli/models) ကို ကြည့်ပါ။

### 9. Talk (speech)

Talk mode ကို ပြင်ဆင်ထားပါက **ElevenLabs** ကို ခေါ်နိုင်သည်-

- `ELEVENLABS_API_KEY` သို့မဟုတ် `talk.apiKey`

[Talk mode](/nodes/talk) ကို ကြည့်ပါ။

### 10. Skills (third-party APIs)

Skills များသည် `skills.entries.<name>` တွင် `apiKey` ကို သိမ်းဆည်းနိုင်ပါသည်။`.apiKey` skill တစ်ခုက ထို key ကို external APIs များအတွက် အသုံးပြုပါက skill ၏ provider အလိုက် ကုန်ကျစရိတ်များ ဖြစ်ပေါ်နိုင်ပါသည်။

[Skills](/tools/skills) ကို ကြည့်ပါ။
