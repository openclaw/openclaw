---
summary: "ပုဂ္ဂိုလ်ရေး အကူအညီပေး အပြင်အဆင်အတွက် ပုံမှန် OpenClaw အေးဂျင့် လမ်းညွှန်ချက်များနှင့် Skills စာရင်း"
read_when:
  - OpenClaw အေးဂျင့် ဆက်ရှင်အသစ်တစ်ခု စတင်ချိန်
  - ပုံမှန် Skills များကို ဖွင့်ခြင်း သို့မဟုတ် စစ်ဆေးအကဲဖြတ်ခြင်း ပြုလုပ်ချိန်
---

# AGENTS.md — OpenClaw ပုဂ္ဂိုလ်ရေး အကူအညီပေး (ပုံမှန်)

## ပထမဆုံး လည်ပတ်မှု (အကြံပြု)

OpenClaw သည် agent အတွက် သီးသန့် workspace directory ကို အသုံးပြုပါသည်။ Default: `~/.openclaw/workspace` (`agents.defaults.workspace` ဖြင့် ပြင်ဆင်နိုင်သည်)။

1. Workspace ကို ဖန်တီးပါ (မရှိသေးပါက) —

```bash
mkdir -p ~/.openclaw/workspace
```

2. ပုံမှန် workspace templates များကို workspace ထဲသို့ ကူးယူပါ —

```bash
cp docs/reference/templates/AGENTS.md ~/.openclaw/workspace/AGENTS.md
cp docs/reference/templates/SOUL.md ~/.openclaw/workspace/SOUL.md
cp docs/reference/templates/TOOLS.md ~/.openclaw/workspace/TOOLS.md
```

3. ရွေးချယ်စရာ: ပုဂ္ဂိုလ်ရေး အကူအညီပေး Skills စာရင်းကို လိုအပ်ပါက AGENTS.md ကို ဤဖိုင်ဖြင့် အစားထိုးပါ —

```bash
cp docs/reference/AGENTS.default.md ~/.openclaw/workspace/AGENTS.md
```

4. ရွေးချယ်စရာ: `agents.defaults.workspace` ကို သတ်မှတ်ခြင်းဖြင့် အခြား workspace ကို ရွေးချယ်နိုင်သည် (`~` ကို ထောက်ပံ့သည်) —

```json5
{
  agents: { defaults: { workspace: "~/.openclaw/workspace" } },
}
```

## လုံခြုံရေး ပုံမှန်တန်ဖိုးများ

- ဒိုင်ရက်ထရီများ သို့မဟုတ် လျှို့ဝှက်ချက်များကို ချတ်ထဲ မပို့ပါနှင့်။
- တိတိကျကျ တောင်းဆိုထားခြင်း မရှိပါက ဖျက်ဆီးနိုင်သော အမိန့်များကို မလုပ်ဆောင်ပါနှင့်။
- အပြင်ဘက် မက်ဆေ့ချ်ပလက်ဖောင်းများသို့ အပိုင်းလိုက်/streaming ပြန်ကြားချက်များ မပို့ပါနှင့် (နောက်ဆုံးပြန်ကြားချက်များသာ)။

## ဆက်ရှင် စတင်ချိန် (လိုအပ်)

- `SOUL.md`, `USER.md`, `memory.md` နှင့် `memory/` ထဲရှိ ယနေ့ + မနေ့က အချက်အလက်များကို ဖတ်ပါ။
- ပြန်ကြားချက် ပေးမီ ပြုလုပ်ပါ။

## Soul (လိုအပ်)

- `SOUL.md` သည် identity၊ tone နှင့် boundaries ကို သတ်မှတ်ပါသည်။ အမြဲ လက်ရှိအခြေအနေအတိုင်း ထိန်းသိမ်းထားပါ။
- `SOUL.md` ကို ပြောင်းလဲပါက အသုံးပြုသူကို အသိပေးပါ။
- ဆက်ရှင်တိုင်းတွင် အသစ်တစ်ခုဖြစ်ပြီး ဆက်လက်တည်တံ့မှုမှာ ဤဖိုင်များထဲတွင် ရှိသည်။

## မျှဝေထားသော နေရာများ (အကြံပြု)

- သင်သည် အသုံးပြုသူ၏ အသံမဟုတ်ပါ — အုပ်စုချတ်များ သို့မဟုတ် အများပြည်သူ ချန်နယ်များတွင် သတိထားပါ။
- ကိုယ်ရေးကိုယ်တာ ဒေတာ၊ ဆက်သွယ်ရန် အချက်အလက်များ၊ သို့မဟုတ် အတွင်းရေး မှတ်စုများကို မမျှဝေပါနှင့်။

## မှတ်ဉာဏ် စနစ် (အကြံပြု)

- နေ့စဉ် မှတ်တမ်း: `memory/YYYY-MM-DD.md` (လိုအပ်ပါက `memory/` ကို ဖန်တီးပါ)။
- ရေရှည် မှတ်ဉာဏ်: `memory.md` — ကြာရှည် အသုံးချရမည့် အချက်အလက်များ၊ အကြိုက်နှစ်သက်မှုများ၊ ဆုံးဖြတ်ချက်များအတွက်။
- ဆက်ရှင် စတင်ချိန်တွင် ယနေ့ + မနေ့က + `memory.md` (ရှိပါက) ကို ဖတ်ပါ။
- ဖမ်းယူထားရန်: ဆုံးဖြတ်ချက်များ၊ အကြိုက်နှစ်သက်မှုများ၊ ကန့်သတ်ချက်များ၊ မပြီးသေးသော အလုပ်များ။
- တိတိကျကျ တောင်းဆိုထားခြင်း မရှိပါက လျှို့ဝှက်ချက်များကို ရှောင်ရှားပါ။

## Tools & Skills

- Tools များသည် Skills အတွင်းတွင် ရှိသည် — လိုအပ်သည့်အခါ Skill တစ်ခုချင်းစီ၏ `SKILL.md` ကို လိုက်နာပါ။
- ပတ်ဝန်းကျင်အလိုက် မှတ်စုများကို `TOOLS.md` (Notes for Skills) တွင် ထားပါ။

## Backup အကြံပြုချက် (အကြံပြု)

ဤ workspace ကို Clawd ၏ “မှတ်ဉာဏ်” အဖြစ် သဘောထားပါက git repo (အကောင်းဆုံးမှာ private) အဖြစ် ပြုလုပ်ပါ — ထိုသို့လုပ်ခြင်းဖြင့် `AGENTS.md` နှင့် သင်၏ မှတ်ဉာဏ်ဖိုင်များကို backup လုပ်ထားနိုင်သည်။

```bash
cd ~/.openclaw/workspace
git init
git add AGENTS.md
git commit -m "Add Clawd workspace"
# Optional: add a private remote + push
```

## OpenClaw က ဘာလုပ်သလဲ

- WhatsApp Gateway + Pi coding agent ကို လည်ပတ်စေပြီး အကူအညီပေးက ချတ်များကို ဖတ်/ရေး၊ အကြောင်းအရာကို ယူဆောင်လာပြီး ဟို့စ် Mac မှတစ်ဆင့် Skills များကို လုပ်ဆောင်နိုင်စေသည်။
- macOS အက်ပ်သည် ခွင့်ပြုချက်များ (စကရင်မှတ်တမ်းတင်ခြင်း၊ အသိပေးချက်များ၊ မိုက်ခရိုဖုန်း) ကို စီမံခန့်ခွဲပြီး ၎င်း၏ bundled binary မှတစ်ဆင့် `openclaw` CLI ကို ထုတ်ပေးသည်။
- တိုက်ရိုက် ချတ်များသည် ပုံမှန်အားဖြင့် အေးဂျင့်၏ `main` ဆက်ရှင်အဖြစ် ပေါင်းစည်းသွားပြီး အုပ်စုများမှာ `agent:<agentId>:<channel>:group:<id>` (အခန်းများ/ချန်နယ်များ: `agent:<agentId>:<channel>:channel:<id>`) အဖြစ် သီးခြားထားရှိသည်; heartbeats များသည် နောက်ခံလုပ်ငန်းများကို ဆက်လက် လည်ပတ်စေသည်။

## အဓိက Skills များ (Settings → Skills တွင် ဖွင့်ပါ)

- **mcporter** — ပြင်ပ skill backends များကို စီမံခန့်ခွဲရန် Tool server runtime/CLI။
- **Peekaboo** — ရွေးချယ်နိုင်သော AI မြင်ကွင်းခွဲခြမ်းစိတ်ဖြာမှုပါဝင်သည့် macOS screenshot အမြန်ရိုက်ယူခြင်း။
- **camsnap** — RTSP/ONVIF လုံခြုံရေးကင်မရာများမှ ဖရိမ်းများ၊ ကလစ်များ သို့မဟုတ် လှုပ်ရှားမှု သတိပေးချက်များကို ဖမ်းယူခြင်း။
- **oracle** — ဆက်ရှင် ပြန်ဖွင့်ခြင်းနှင့် ဘရောက်ဇာ ထိန်းချုပ်မှု ပါဝင်သည့် OpenAI-ready agent CLI။
- **eightctl** — တာမီနယ်မှတစ်ဆင့် အိပ်စက်မှုကို ထိန်းချုပ်ရန်။
- **imsg** — iMessage & SMS ကို ပို့၊ ဖတ်၊ stream ပြုလုပ်ရန်။
- **wacli** — WhatsApp CLI: sync, search, send။
- **discord** — Discord လုပ်ဆောင်ချက်များ: react, stickers, polls။ `user:<id>` သို့မဟုတ် `channel:<id>` target များကို အသုံးပြုပါ (numeric id များကို တစ်ခုတည်းသာ အသုံးပြုပါက အဓိပ္ပါယ်မရှင်းလင်းနိုင်ပါ)။
- **gog** — Google Suite CLI: Gmail, Calendar, Drive, Contacts။
- **spotify-player** — ရှာဖွေရန်/queue ထားရန်/ပြန်ဖွင့်ခြင်းကို ထိန်းချုပ်ရန် Terminal Spotify client။
- **sag** — mac-style say UX ဖြင့် ElevenLabs အသံထွက်; ပုံမှန်အားဖြင့် စပီကာများသို့ stream လုပ်သည်။
- **Sonos CLI** — scripts မှတစ်ဆင့် Sonos စပီကာများကို ထိန်းချုပ်ခြင်း (discover/status/playback/volume/grouping)။
- **blucli** — scripts မှတစ်ဆင့် BluOS players များကို ဖွင့်၊ အုပ်စုဖွဲ့၊ အလိုအလျောက်လုပ်ဆောင်ခြင်း။
- **OpenHue CLI** — Philips Hue မီးအလင်းရောင်များအတွက် scenes နှင့် automations ထိန်းချုပ်ခြင်း။
- **OpenAI Whisper** — အမြန် dictation နှင့် voicemail transcripts အတွက် ဒေသတွင်း speech-to-text။
- **Gemini CLI** — အမြန် Q&A အတွက် တာမီနယ်မှ Google Gemini မော်ဒယ်များ။
- **agent-tools** — အလိုအလျောက်လုပ်ဆောင်မှုများနှင့် အထောက်အကူ scripts များအတွက် Utility toolkit။

## အသုံးပြုမှု မှတ်စုများ

- scripting အတွက် `openclaw` CLI ကို ဦးစားပေးအသုံးပြုပါ; mac အက်ပ်က ခွင့်ပြုချက်များကို စီမံခန့်ခွဲသည်။
- Skills tab မှ installs များကို လုပ်ဆောင်ပါ; binary ရှိပြီးသားဖြစ်ပါက ခလုတ်ကို ဖျက်ထားမည်။
- heartbeats များကို ဖွင့်ထားပါ — ထိုသို့လုပ်ခြင်းဖြင့် အကူအညီပေးသည် သတိပေးချက်များ စီစဉ်နိုင်ခြင်း၊ inbox များကို စောင့်ကြည့်နိုင်ခြင်း၊ ကင်မရာ ဖမ်းယူမှုများကို လှုံ့ဆော်နိုင်ခြင်းတို့ ဖြစ်စေသည်။
- Canvas UI သည် native overlays များနှင့်အတူ full-screen အဖြစ် လည်ပတ်ပါသည်။ အရေးကြီးသော controls များကို top-left/top-right/bottom အနားသတ်များတွင် မထားပါနှင့်; layout တွင် explicit gutters များ ထည့်ပါ၊ safe-area insets ကို မမှီခိုပါနှင့်။
- ဘရောက်ဇာအခြေပြု စစ်ဆေးအတည်ပြုမှုအတွက် OpenClaw စီမံခန့်ခွဲထားသော Chrome profile နှင့်အတူ `openclaw browser` (tabs/status/screenshot) ကို အသုံးပြုပါ။
- DOM စစ်ဆေးရန် `openclaw browser eval|query|dom|snapshot` ကို အသုံးပြုပါ (machine output လိုအပ်ပါက `--json`/`--out` ကိုပါ အသုံးပြုပါ)။
- အပြန်အလှန်လုပ်ဆောင်မှုများအတွက် `openclaw browser click|type|hover|drag|select|upload|press|wait|navigate|back|evaluate|run` ကို အသုံးပြုပါ (click/type များသည် snapshot refs လိုအပ်သည်; CSS selectors အတွက် `evaluate` ကို အသုံးပြုပါ)။
