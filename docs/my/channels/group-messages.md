---
summary: "WhatsApp အုပ်စု မက်ဆေ့ချ် ကိုင်တွယ်ပုံဆိုင်ရာ အပြုအမူနှင့် ဖွဲ့စည်းပြင်ဆင်မှု (mentionPatterns ကို surface များအကြား မျှဝေထားသည်)"
read_when:
  - အုပ်စု မက်ဆေ့ချ် စည်းမျဉ်းများ သို့မဟုတ် mention များကို ပြောင်းလဲသောအခါ
title: "အုပ်စု မက်ဆေ့ချ်များ"
---

# အုပ်စု မက်ဆေ့ချ်များ (WhatsApp web channel)

ရည်ရွယ်ချက်: Clawd ကို WhatsApp အုပ်စုများထဲတွင် ပါဝင်စေပြီး ping လုပ်ခံရသည့်အချိန်မှသာ နိုးထစေခြင်း၊ ထို့အပြင် ထို thread ကို ကိုယ်ရေးကိုယ်တာ DM ဆက်ရှင်နှင့် ခွဲထားခြင်း။

Note: `agents.list[].groupChat.mentionPatterns` is now used by Telegram/Discord/Slack/iMessage as well; this doc focuses on WhatsApp-specific behavior. For multi-agent setups, set `agents.list[].groupChat.mentionPatterns` per agent (or use `messages.groupChat.mentionPatterns` as a global fallback).

## အကောင်အထည်ဖော်ပြီးသား အရာများ (2025-12-03)

- Activation modes: `mention` (default) or `always`. `mention` requires a ping (real WhatsApp @-mentions via `mentionedJids`, regex patterns, or the bot’s E.164 anywhere in the text). `always` wakes the agent on every message but it should reply only when it can add meaningful value; otherwise it returns the silent token `NO_REPLY`. Defaults can be set in config (`channels.whatsapp.groups`) and overridden per group via `/activation`. When `channels.whatsapp.groups` is set, it also acts as a group allowlist (include `"*"` to allow all).
- Group policy: `channels.whatsapp.groupPolicy` controls whether group messages are accepted (`open|disabled|allowlist`). `allowlist` uses `channels.whatsapp.groupAllowFrom` (fallback: explicit `channels.whatsapp.allowFrom`). Default is `allowlist` (blocked until you add senders).
- Per-group sessions: session keys look like `agent:<agentId>:whatsapp:group:<jid>` so commands such as `/verbose on` or `/think high` (sent as standalone messages) are scoped to that group; personal DM state is untouched. Heartbeats are skipped for group threads.
- Context injection: **pending-only** group messages (default 50) that _did not_ trigger a run are prefixed under `[Chat messages since your last reply - for context]`, with the triggering line under `[Current message - respond to this]`. Messages already in the session are not re-injected.
- Sender surfacing: အုပ်စု batch တစ်ခုချင်းစီ၏ အဆုံးတွင် ယခု `[from: Sender Name (+E164)]` ကို ထည့်သွင်းထားသောကြောင့် Pi သည် ပြောဆိုနေသူကို သိနိုင်ပါသည်။
- Ephemeral/view-once: စာသား/mentions များကို ထုတ်ယူမီ အဲဒီများကို unwrap လုပ်ပါသည်၊ ထို့ကြောင့် အတွင်းရှိ ping များသည် ဆက်လက် trigger ဖြစ်ပါသည်။
- Group system prompt: on the first turn of a group session (and whenever `/activation` changes the mode) we inject a short blurb into the system prompt like `You are replying inside the WhatsApp group "<subject>". Group members: Alice (+44...), Bob (+43...), … Activation: trigger-only … Address the specific sender noted in the message context.` If metadata isn’t available we still tell the agent it’s a group chat.

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

Only the owner number (from `channels.whatsapp.allowFrom`, or the bot’s own E.164 when unset) can change this. Send `/status` as a standalone message in the group to see the current activation mode.

## အသုံးပြုနည်း

1. OpenClaw ကို လည်ပတ်နေသော သင့် WhatsApp အကောင့်ကို အုပ်စုထဲသို့ ထည့်ပါ။
2. Say `@openclaw …` (or include the number). Only allowlisted senders can trigger it unless you set `groupPolicy: "open"`.
3. agent prompt တွင် မကြာသေးမီ အုပ်စု context နှင့် အဆုံးတွင် `[from: …]` marker ကို ထည့်သွင်းပေးထားသဖြင့် မှန်ကန်သော လူကို ကိုင်တွယ်ဖြေကြားနိုင်ပါသည်။
4. Session-level directives (`/verbose on`, `/think high`, `/new` or `/reset`, `/compact`) apply only to that group’s session; send them as standalone messages so they register. Your personal DM session remains independent.

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
