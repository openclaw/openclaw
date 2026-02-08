---
summary: "WhatsApp အုပ်စု မက်ဆေ့ချ် ကိုင်တွယ်ပုံဆိုင်ရာ အပြုအမူနှင့် ဖွဲ့စည်းပြင်ဆင်မှု (mentionPatterns ကို surface များအကြား မျှဝေထားသည်)"
read_when:
  - အုပ်စု မက်ဆေ့ချ် စည်းမျဉ်းများ သို့မဟုတ် mention များကို ပြောင်းလဲသောအခါ
title: "အုပ်စု မက်ဆေ့ချ်များ"
x-i18n:
  source_path: channels/group-messages.md
  source_hash: 181a72f12f5021af
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:54:14Z
---

# အုပ်စု မက်ဆေ့ချ်များ (WhatsApp web channel)

ရည်ရွယ်ချက်: Clawd ကို WhatsApp အုပ်စုများထဲတွင် ပါဝင်စေပြီး ping လုပ်ခံရသည့်အချိန်မှသာ နိုးထစေခြင်း၊ ထို့အပြင် ထို thread ကို ကိုယ်ရေးကိုယ်တာ DM ဆက်ရှင်နှင့် ခွဲထားခြင်း။

မှတ်ချက်: `agents.list[].groupChat.mentionPatterns` ကို ယခု Telegram/Discord/Slack/iMessage များတွင်လည်း အသုံးပြုနေပါသည်; ဤစာတမ်းသည် WhatsApp အထူးပြု အပြုအမူများကိုသာ အဓိကထား ရေးသားထားပါသည်။ agent များစွာ ပါဝင်သော setup များအတွက် `agents.list[].groupChat.mentionPatterns` ကို agent တစ်ခုချင်းစီအလိုက် သတ်မှတ်ပါ (သို့မဟုတ် global fallback အဖြစ် `messages.groupChat.mentionPatterns` ကို အသုံးပြုနိုင်ပါသည်)။

## အကောင်အထည်ဖော်ပြီးသား အရာများ (2025-12-03)

- Activation modes: `mention` (default) သို့မဟုတ် `always`။ `mention` တွင် ping လိုအပ်ပါသည် (WhatsApp အမှန်တကယ် @-mentions ကို `mentionedJids` ဖြင့်၊ regex patterns များ၊ သို့မဟုတ် bot ၏ E.164 ကို စာသားအတွင်း မည်သည့်နေရာမဆို ထည့်သွင်းခြင်း)။ `always` သည် မက်ဆေ့ချ်တိုင်းတွင် agent ကို နိုးထစေသော်လည်း အဓိပ္ပါယ်ရှိသော တန်ဖိုး ထည့်ပေးနိုင်သည့်အခါမှသာ ပြန်ကြားသင့်ပြီး မဟုတ်ပါက silent token `NO_REPLY` ကို ပြန်ပေးပါသည်။ Default များကို config (`channels.whatsapp.groups`) တွင် သတ်မှတ်နိုင်ပြီး အုပ်စုအလိုက် `/activation` ဖြင့် override လုပ်နိုင်ပါသည်။ `channels.whatsapp.groups` ကို သတ်မှတ်ထားပါက group allowlist အဖြစ်လည်း လုပ်ဆောင်ပါသည် (`"*"` ကို ထည့်သွင်းပါက အားလုံးကို ခွင့်ပြုပါသည်)။
- Group policy: `channels.whatsapp.groupPolicy` သည် အုပ်စု မက်ဆေ့ချ်များကို လက်ခံမလား (`open|disabled|allowlist`) ကို ထိန်းချုပ်ပါသည်။ `allowlist` သည် `channels.whatsapp.groupAllowFrom` ကို အသုံးပြုပါသည် (fallback: အတိအကျ `channels.whatsapp.allowFrom`)။ Default သည် `allowlist` ဖြစ်ပြီး ပို့သူများကို ထည့်သွင်းမချင်း ပိတ်ထားပါသည်။
- Per-group sessions: session key များသည် `agent:<agentId>:whatsapp:group:<jid>` ကဲ့သို့ ဖြစ်သောကြောင့် `/verbose on` သို့မဟုတ် `/think high` (standalone မက်ဆေ့ချ်များအဖြစ် ပို့ရပါသည်) ကဲ့သို့သော command များသည် ထိုအုပ်စုအတွင်းသာ သက်ရောက်ပါသည်; ကိုယ်ရေးကိုယ်တာ DM state ကို မထိခိုက်ပါ။ အုပ်စု thread များအတွက် heartbeats များကို ကျော်လွှားထားပါသည်။
- Context injection: run ကို မဖြစ်စေခဲ့သော **pending-only** အုပ်စု မက်ဆေ့ချ်များ (default 50) ကို `[Chat messages since your last reply - for context]` အောက်တွင် prefix လုပ်ထားပြီး trigger ဖြစ်စေသည့် စာကြောင်းကို `[Current message - respond to this]` အောက်တွင် ထည့်သွင်းပါသည်။ session အတွင်း ရှိပြီးသား မက်ဆေ့ချ်များကို ထပ်မံ inject မလုပ်ပါ။
- Sender surfacing: အုပ်စု batch တစ်ခုချင်းစီ၏ အဆုံးတွင် ယခု `[from: Sender Name (+E164)]` ကို ထည့်သွင်းထားသောကြောင့် Pi သည် ပြောဆိုနေသူကို သိနိုင်ပါသည်။
- Ephemeral/view-once: စာသား/mentions များကို ထုတ်ယူမီ အဲဒီများကို unwrap လုပ်ပါသည်၊ ထို့ကြောင့် အတွင်းရှိ ping များသည် ဆက်လက် trigger ဖြစ်ပါသည်။
- Group system prompt: အုပ်စု ဆက်ရှင်၏ ပထမဆုံး turn တွင် (နှင့် `/activation` သည် mode ကို ပြောင်းလဲသည့်အခါတိုင်း) system prompt ထဲသို့ `You are replying inside the WhatsApp group "<subject>". Group members: Alice (+44...), Bob (+43...), … Activation: trigger-only … Address the specific sender noted in the message context.` ကဲ့သို့သော စာတိုတိုတစ်ခုကို inject လုပ်ပါသည်။ metadata မရရှိနိုင်ပါကလည်း agent ကို အုပ်စု chat ဖြစ်ကြောင်း ပြောကြားထားပါသည်။

## Config example (WhatsApp)

WhatsApp သည် text body အတွင်း visual `@` ကို ဖယ်ရှားသည့်အခါတွင်ပါ display-name ping များ အလုပ်လုပ်စေရန် `~/.openclaw/openclaw.json` ထဲသို့ `groupChat` block တစ်ခုကို ထည့်ပါ—

```json5
{
  channels: {
    whatsapp: {
      groups: {
        "*": { requireMention: true },
      },
    },
  },
  agents: {
    list: [
      {
        id: "main",
        groupChat: {
          historyLimit: 50,
          mentionPatterns: ["@?openclaw", "\\+?15555550123"],
        },
      },
    ],
  },
}
```

Notes:

- regex များသည် case-insensitive ဖြစ်ပြီး `@openclaw` ကဲ့သို့သော display-name ping နှင့် `+`/spaces ပါဝင်ခြင်း သို့မဟုတ် မပါဝင်ခြင်းနှင့်အတူ raw number ကိုလည်း ဖုံးလွှမ်းပါသည်။
- WhatsApp သည် လူတစ်ဦးက contact ကို တို့လိုက်သည့်အခါ `mentionedJids` ဖြင့် canonical mentions များကို ဆက်လက်ပို့ပေးနေသဖြင့် number fallback သည် မကြာခဏ မလိုအပ်သော်လည်း အထောက်အကူဖြစ်သော safety net တစ်ခု ဖြစ်ပါသည်။

### Activation command (owner-only)

အုပ်စု chat command ကို အသုံးပြုပါ—

- `/activation mention`
- `/activation always`

ဤအရာကို owner number (`channels.whatsapp.allowFrom` မှ သတ်မှတ်ထားသော၊ သို့မဟုတ် မသတ်မှတ်ထားပါက bot ၏ E.164) သာ ပြောင်းလဲနိုင်ပါသည်။ လက်ရှိ activation mode ကို ကြည့်ရန် အုပ်စုအတွင်း standalone မက်ဆေ့ချ်အဖြစ် `/status` ကို ပို့ပါ။

## အသုံးပြုနည်း

1. OpenClaw ကို လည်ပတ်နေသော သင့် WhatsApp အကောင့်ကို အုပ်စုထဲသို့ ထည့်ပါ။
2. `@openclaw …` ဟုပြောပါ (သို့မဟုတ် နံပါတ်ကို ထည့်သွင်းပါ)။ `groupPolicy: "open"` ကို မသတ်မှတ်ထားလျှင် allowlist ထဲရှိ ပို့သူများသာ trigger လုပ်နိုင်ပါသည်။
3. agent prompt တွင် မကြာသေးမီ အုပ်စု context နှင့် အဆုံးတွင် `[from: …]` marker ကို ထည့်သွင်းပေးထားသဖြင့် မှန်ကန်သော လူကို ကိုင်တွယ်ဖြေကြားနိုင်ပါသည်။
4. Session-level directives (`/verbose on`, `/think high`, `/new` သို့မဟုတ် `/reset`, `/compact`) သည် ထိုအုပ်စု၏ ဆက်ရှင်အတွက်သာ သက်ရောက်ပါသည်; register ဖြစ်စေရန် standalone မက်ဆေ့ချ်များအဖြစ် ပို့ပါ။ သင့်ကိုယ်ရေးကိုယ်တာ DM ဆက်ရှင်သည် လွတ်လပ်စွာ ဆက်လက်ရှိနေပါသည်။

## စမ်းသပ်ခြင်း / အတည်ပြုခြင်း

- Manual smoke:
  - အုပ်စုထဲတွင် `@openclaw` ping တစ်ခု ပို့ပြီး ပို့သူအမည်ကို ရည်ညွှန်းသော ပြန်ကြားချက် ရှိကြောင်း အတည်ပြုပါ။
  - ဒုတိယ ping တစ်ခု ပို့ပြီး history block ပါဝင်လာကြောင်းနှင့် နောက် turn တွင် ပြန်လည်ရှင်းလင်းသွားကြောင်း စစ်ဆေးပါ။
- Gateway logs ကို စစ်ဆေးပါ (`--verbose` ဖြင့် run လုပ်ပါ)၊ `from: <groupJid>` နှင့် `[from: …]` suffix ကို ပြသထားသော `inbound web message` entries များကို တွေ့ရပါမည်။

## သိထားသင့်သော အချက်များ

- အုပ်စုများအတွက် heartbeats များကို ဆူညံသည့် broadcast များ မဖြစ်စေရန် ရည်ရွယ်ချက်ရှိရှိ ကျော်လွှားထားပါသည်။
- Echo suppression သည် ပေါင်းစည်းထားသော batch string ကို အသုံးပြုပါသည်; mention မပါဘဲ တူညီသော စာသားကို နှစ်ကြိမ်ပို့ပါက ပထမတစ်ကြိမ်သာ ပြန်ကြားချက် ရရှိပါမည်။
- Session store entries များသည် session store (`~/.openclaw/agents/<agentId>/sessions/sessions.json` default) အတွင်း `agent:<agentId>:whatsapp:group:<jid>` အဖြစ် ပေါ်လာပါမည်; entry မရှိခြင်းသည် အုပ်စုမှ run ကို မ trigger လုပ်ရသေးကြောင်းသာ ဆိုလိုပါသည်။
- အုပ်စုများအတွင်း typing indicators များသည် `agents.defaults.typingMode` ကို လိုက်နာပြီး (default: mention မခံရပါက `message`) ဖြစ်ပါသည်။
