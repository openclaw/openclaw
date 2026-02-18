---
summary: "OpenClaw က typing indicator များကို ပြသသည့်အချိန်နှင့် ၎င်းတို့ကို ချိန်ညှိပုံ"
read_when:
  - typing indicator အပြုအမူ သို့မဟုတ် မူလသတ်မှတ်ချက်များကို ပြောင်းလဲနေချိန်
title: "Typing Indicators"
---

# Typing indicators

Typing indicators များကို run တစ်ခု လည်ပတ်နေစဉ် chat channel သို့ ပို့ပေးပါသည်။ **ဘယ်အချိန်** typing စတင်မည်ကို ထိန်းချုပ်ရန် `agents.defaults.typingMode` ကို အသုံးပြုပြီး **ဘယ်လောက် မကြာခဏ** refresh လုပ်မည်ကို ထိန်းချုပ်ရန် `typingIntervalSeconds` ကို အသုံးပြုပါ။

## Defaults

`agents.defaults.typingMode` ကို **မသတ်မှတ်ထားပါက**, OpenClaw သည် ယခင် legacy အပြုအမူကို ဆက်လက်အသုံးပြုသည်။

- **Direct chats**: model loop စတင်သည်နှင့် ချက်ချင်း typing စတင်သည်။
- **Group chats with a mention**: ချက်ချင်း typing စတင်သည်။
- **Group chats without a mention**: မက်ဆေ့ချ် စာသား စတင် streaming လုပ်သည့်အချိန်မှသာ typing စတင်သည်။
- **Heartbeat runs**: typing ကို ပိတ်ထားသည်။

## Modes

`agents.defaults.typingMode` ကို အောက်ပါတစ်ခုအဖြစ် သတ်မှတ်ပါ—

- `never` — ဘယ်အချိန်မဆို typing indicator မပြပါ။
- `instant` — run သည် နောက်ပိုင်းတွင် silent reply token ကိုသာ ပြန်ပေးသော်လည်း **model loop စတင်သည်နှင့် ချက်ချင်း** typing စတင်သည်။
- `thinking` — **ပထမ reasoning delta** တွင် typing စတင်သည် (run အတွက် `reasoningLevel: "stream"` လိုအပ်သည်)။
- `message` — **ပထမ non-silent text delta** တွင် typing စတင်သည် (`NO_REPLY` silent token ကို လျစ်လျူရှုသည်)။

“ဘယ်လောက်စောစော အလုပ်လုပ်သလဲ” အစဉ်—
`never` → `message` → `thinking` → `instant`

## Configuration

```json5
{
  agent: {
    typingMode: "thinking",
    typingIntervalSeconds: 6,
  },
}
```

Session တစ်ခုချင်းစီအလိုက် mode သို့မဟုတ် cadence ကို override လုပ်နိုင်သည်—

```json5
{
  session: {
    typingMode: "message",
    typingIntervalSeconds: 4,
  },
}
```

## Notes

- `message` mode သည် silent-only replies (ဥပမာ အထွက်ကို ဖိနှိပ်ရန် အသုံးပြုသည့် `NO_REPLY` token) အတွက် typing ကို မပြပါ။
- `thinking` သည် run က reasoning ကို stream လုပ်သောအခါ (`reasoningLevel: "stream"`) မှသာ ဖြစ်ပေါ်ပါသည်။
  မော်ဒယ်က reasoning deltas မထုတ်ပေးပါက typing မစတင်ပါ။
- Heartbeat များတွင် mode မည်သို့ပင်ဖြစ်စေ typing ကို မည်သည့်အခါမျှ မပြပါ။
- `typingIntervalSeconds` သည် **refresh cadence** ကိုသာ ထိန်းချုပ်ပြီး စတင်ချိန်ကို မထိန်းချုပ်ပါ။
  ပုံမှန်တန်ဖိုးမှာ 6 စက္ကန့် ဖြစ်ပါသည်။
