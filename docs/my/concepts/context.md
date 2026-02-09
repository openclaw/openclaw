---
summary: "Context: မော်ဒယ်က ဘာတွေကို မြင်နေလဲ၊ ဘယ်လို တည်ဆောက်ထားလဲ၊ ဘယ်လို စစ်ဆေးနိုင်လဲ"
read_when:
  - OpenClaw မှာ “context” ဆိုတာ ဘာကို ဆိုလိုသလဲ နားလည်ချင်တဲ့အခါ
  - မော်ဒယ်က ဘာကြောင့် အချက်အလက်တစ်ခုကို “သိနေ” သို့မဟုတ် “မေ့သွား” သလဲ ဆိုတာ စစ်ဆေးနေတဲ့အခါ
  - context အလွန်အကျွံ သုံးစွဲမှုကို လျှော့ချချင်တဲ့အခါ (/context, /status, /compact)
title: "Context"
---

# Context

6. “Context” ဆိုသည်မှာ **run တစ်ကြိမ်အတွက် OpenClaw က model ဆီသို့ ပို့သော အရာအားလုံး** ကို ဆိုလိုပါသည်။ 7. ၎င်းကို model ၏ **context window** (token limit) ဖြင့် ကန့်သတ်ထားပါသည်။

အစပြုသူအတွက် စိတ်ကူးပုံစံ—

- **System prompt** (OpenClaw က တည်ဆောက်ထားသော): စည်းမျဉ်းများ၊ ကိရိယာများ၊ Skills စာရင်း၊ အချိန်/ runtime အချက်အလက်များ၊ နှင့် inject လုပ်ထားသော workspace ဖိုင်များ။
- **Conversation history**: ဒီ session အတွင်း သင်ပို့တဲ့ မက်ဆေ့ချ်များ + assistant ရဲ့ မက်ဆေ့ချ်များ။
- **Tool calls/results + attachments**: command output များ၊ ဖိုင်ဖတ်ထားမှုများ၊ ပုံ/အသံ စသည့် အချက်အလက်များ။

Context ဟာ “memory” နဲ့ _မတူပါ_။ memory ကို disk ပေါ်မှာ သိမ်းဆည်းပြီး နောက်မှ ပြန်တင်နိုင်ပေမယ့် context ကတော့ မော်ဒယ်ရဲ့ လက်ရှိ window အတွင်းမှာ ပါနေတဲ့ အရာတွေပါ။

## Quick start (context ကို စစ်ဆေးခြင်း)

- `/status` → “window ဘယ်လောက် ပြည့်နေပြီလဲ” ကို အမြန်ကြည့်နိုင်တဲ့ view + session settings။
- `/context list` → inject လုပ်ထားတာတွေ + အရွယ်အစား ခန့်မှန်းချက်များ (ဖိုင်တစ်ခုချင်းစီ + စုစုပေါင်း)။
- `/context detail` → ပိုမို အသေးစိတ် ခွဲခြမ်းချက်များ: ဖိုင်တစ်ခုချင်းစီ၊ tool schema အရွယ်အစားများ၊ skill entry တစ်ခုချင်းစီအရွယ်အစားများ၊ နှင့် system prompt အရွယ်အစား။
- `/usage tokens` → ပုံမှန် reply များရဲ့ အောက်မှာ reply တစ်ခုပြီးတိုင်း အသုံးပြုမှု footer ကို ထည့်ပေါင်းပြပါ။
- `/compact` → အဟောင်း history ကို အကျဉ်းချုပ်တစ်ခုအဖြစ် ပြောင်းပြီး window နေရာလွတ် ဖန်တီးပါ။

ထပ်မံကြည့်ရှုရန်: [Slash commands](/tools/slash-commands), [Token use & costs](/reference/token-use), [Compaction](/concepts/compaction)။

## Example output

တန်ဖိုးများက မော်ဒယ်၊ ပံ့ပိုးသူ၊ tool policy နဲ့ workspace ထဲမှာ ပါရှိတဲ့ အရာများအပေါ် မူတည်ပြီး ကွဲပြားနိုင်ပါတယ်။

### `/context list`

```
🧠 Context breakdown
Workspace: <workspaceDir>
Bootstrap max/file: 20,000 chars
Sandbox: mode=non-main sandboxed=false
System prompt (run): 38,412 chars (~9,603 tok) (Project Context 23,901 chars (~5,976 tok))

Injected workspace files:
- AGENTS.md: OK | raw 1,742 chars (~436 tok) | injected 1,742 chars (~436 tok)
- SOUL.md: OK | raw 912 chars (~228 tok) | injected 912 chars (~228 tok)
- TOOLS.md: TRUNCATED | raw 54,210 chars (~13,553 tok) | injected 20,962 chars (~5,241 tok)
- IDENTITY.md: OK | raw 211 chars (~53 tok) | injected 211 chars (~53 tok)
- USER.md: OK | raw 388 chars (~97 tok) | injected 388 chars (~97 tok)
- HEARTBEAT.md: MISSING | raw 0 | injected 0
- BOOTSTRAP.md: OK | raw 0 chars (~0 tok) | injected 0 chars (~0 tok)

Skills list (system prompt text): 2,184 chars (~546 tok) (12 skills)
Tools: read, edit, write, exec, process, browser, message, sessions_send, …
Tool list (system prompt text): 1,032 chars (~258 tok)
Tool schemas (JSON): 31,988 chars (~7,997 tok) (counts toward context; not shown as text)
Tools: (same as above)

Session tokens (cached): 14,250 total / ctx=32,000
```

### `/context detail`

```
🧠 Context breakdown (detailed)
…
Top skills (prompt entry size):
- frontend-design: 412 chars (~103 tok)
- oracle: 401 chars (~101 tok)
… (+10 more skills)

Top tools (schema size):
- browser: 9,812 chars (~2,453 tok)
- exec: 6,240 chars (~1,560 tok)
… (+N more tools)
```

## Context window ထဲကို ဘာတွေ တွက်သွင်းသလဲ

မော်ဒယ်လက်ခံရရှိတဲ့ အရာအားလုံးကို တွက်သွင်းပါတယ်—

- System prompt (အပိုင်းအားလုံး)။
- Conversation history။
- Tool calls + tool results။
- Attachments / transcripts (ပုံ၊ အသံ၊ ဖိုင်များ)။
- Compaction summaries နှင့် pruning artifacts များ။
- Provider ရဲ့ “wrappers” သို့မဟုတ် hidden headers (မမြင်ရပေမယ့် တိုင်ချက်ထဲ ဝင်ပါတယ်)။

## OpenClaw က system prompt ကို ဘယ်လို တည်ဆောက်သလဲ

8. System prompt သည် **OpenClaw ပိုင်ဆိုင်သော အရာ** ဖြစ်ပြီး run တစ်ကြိမ်စီတွင် ပြန်လည် တည်ဆောက်ပါသည်။ 9. ၎င်းတွင် ပါဝင်သည်မှာ:

- Tool စာရင်း + အကျဉ်းချုပ် ဖော်ပြချက်များ။
- Skills စာရင်း (metadata သာ; အောက်တွင် ကြည့်ပါ)။
- Workspace တည်နေရာ။
- အချိန် (UTC + သတ်မှတ်ထားပါက အသုံးပြုသူ အချိန်သို့ ပြောင်းလဲထားသည်)။
- Runtime metadata (ဟို့စ်/OS/မော်ဒယ်/စဉ်းစားမှု)။
- **Project Context** အောက်မှာ inject လုပ်ထားသော workspace bootstrap ဖိုင်များ။

အသေးစိတ် ခွဲခြမ်းချက်: [System Prompt](/concepts/system-prompt)။

## Inject လုပ်ထားသော workspace ဖိုင်များ (Project Context)

ပုံမှန်အားဖြင့် OpenClaw က workspace ဖိုင်အစုတစ်ခုကို (ရှိပါက) inject လုပ်ပါတယ်—

- `AGENTS.md`
- `SOUL.md`
- `TOOLS.md`
- `IDENTITY.md`
- `USER.md`
- `HEARTBEAT.md`
- `BOOTSTRAP.md` (ပထမဆုံး run တွင်သာ)

10. Large files များကို file တစ်ခုချင်းစီအလိုက် `agents.defaults.bootstrapMaxChars` (default `20000` chars) ဖြင့် truncate လုပ်ပါသည်။ 11. `/context` သည် **raw vs injected** size များနှင့် truncation ဖြစ်ပေါ်ခဲ့သလား ဆိုသည်ကို ပြသပါသည်။

## Skills: inject လုပ်ထားတာ vs လိုအပ်မှ load လုပ်တာ

12. System prompt ထဲတွင် compact ဖြစ်သော **skills list** (name + description + location) ပါဝင်ပါသည်။ 13. ဤစာရင်းတွင် အမှန်တကယ် overhead ရှိပါသည်။

14. Skill instructions များကို default အနေဖြင့် မထည့်သွင်းပါ။ 15. Model သည် လိုအပ်သည့်အချိန်တွင်သာ skill ၏ `SKILL.md` ကို **ဖတ်ရန် မျှော်လင့်ထားပါသည်**။

## Tools: ကုန်ကျစရိတ် နှစ်မျိုးရှိပါတယ်

Tools တွေက context ကို နည်းလမ်း နှစ်မျိုးနဲ့ သက်ရောက်စေပါတယ်—

1. System prompt ထဲက **Tool list စာသား** (“Tooling” အနေနဲ့ သင်မြင်ရတာ)။
2. 16. **Tool schemas** (JSON)။ 17. Model က tools များကို ခေါ်နိုင်ရန်အတွက် ၎င်းတို့ကို model ဆီသို့ ပို့ပါသည်။ 18. သင် plain text အဖြစ် မမြင်ရသော်လည်း ၎င်းတို့သည် context ထဲတွင် ရေတွက်ပါသည်။

`/context detail` က အကြီးဆုံး tool schema များကို ခွဲပြထားလို့ ဘာတွေက အဓိက占နေသလဲ သိနိုင်ပါတယ်။

## Commands, directives, နှင့် “inline shortcuts”

19. Slash commands များကို Gateway မှ ကိုင်တွယ်ပါသည်။ 20. အပြုအမူ မျိုးစုံ ရှိပါသည်:

- **Standalone commands**: မက်ဆေ့ချ်တစ်ခုလုံးက `/...` သာ ဖြစ်နေရင် command အဖြစ် run လုပ်ပါတယ်။
- **Directives**: `/think`, `/verbose`, `/reasoning`, `/elevated`, `/model`, `/queue` တွေကို မော်ဒယ် မမြင်ခင် ဖယ်ရှားလိုက်ပါတယ်။
  - Directive-only မက်ဆေ့ချ်တွေက session settings ကို ဆက်လက် ထိန်းသိမ်းထားပါတယ်။
  - ပုံမှန် မက်ဆေ့ချ်ထဲက inline directives တွေက မက်ဆေ့ချ်တစ်ခုချင်းစီအတွက် hint အဖြစ် အလုပ်လုပ်ပါတယ်။
- **Inline shortcuts** (allowlist ထဲရှိ ပို့သူများသာ): ပုံမှန် မက်ဆေ့ချ်အတွင်းက `/...` token အချို့က ချက်ချင်း run လုပ်နိုင်ပါတယ် (ဥပမာ– “hey /status”)၊ ပြီးရင် ကျန်တဲ့ စာသားကို မော်ဒယ် မမြင်ခင် ဖယ်ရှားပါတယ်။

အသေးစိတ်: [Slash commands](/tools/slash-commands)။

## Sessions, compaction, နှင့် pruning (ဘာတွေ ဆက်လက် ရှိနေသလဲ)

မက်ဆေ့ချ်တွေကြား ဘာတွေ ဆက်လက် ရှိနေမလဲ ဆိုတာ mechanism အပေါ် မူတည်ပါတယ်—

- **Normal history** က policy အရ compact/prune မလုပ်မချင်း session transcript ထဲမှာ ဆက်ရှိနေပါတယ်။
- **Compaction** က အကျဉ်းချုပ်တစ်ခုကို transcript ထဲ သိမ်းထားပြီး မကြာသေးတဲ့ မက်ဆေ့ချ်တွေကို မပြောင်းလဲဘဲ ထားပါတယ်။
- **Pruning** က run တစ်ခါအတွက် _in-memory_ prompt ထဲက tool results အဟောင်းတွေကို ဖယ်ရှားပေမယ့် transcript ကို မပြန်ရေးပါဘူး။

စာရွက်စာတမ်းများ: [Session](/concepts/session), [Compaction](/concepts/compaction), [Session pruning](/concepts/session-pruning)။

## `/context` က တကယ် ဘာကို အစီရင်ခံသလဲ

`/context` က ရနိုင်တဲ့အခါ **run-built** system prompt report နောက်ဆုံးဗားရှင်းကို ဦးစားပေး အသုံးပြုပါတယ်—

- `System prompt (run)` = နောက်ဆုံး embedded (tool-အသုံးပြုနိုင်သော) run မှ ဖမ်းယူထားပြီး session store ထဲ သိမ်းထားသော အချက်အလက်။
- `System prompt (estimate)` = run report မရှိတဲ့အခါ (သို့) report မထုတ်ပေးတဲ့ CLI backend ဖြင့် run လုပ်တဲ့အခါ အချိန်နှင့်တပြေးညီ တွက်ချက်ထားသော အချက်အလက်။

ဘယ်လိုပဲဖြစ်ဖြစ်၊ အရွယ်အစားများနဲ့ အဓိက ပါဝင်သူများကိုသာ အစီရင်ခံပြီး system prompt အပြည့်အစုံ သို့မဟုတ် tool schemas ကိုတော့ မဖော်ပြပါဘူး။
