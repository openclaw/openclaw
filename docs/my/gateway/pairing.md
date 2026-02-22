---
summary: "iOS နှင့် အခြား အဝေးမှ နိုဒ်များအတွက် Gateway ပိုင်ဆိုင်သည့် နိုဒ် ချိတ်ဆက်မှု (ရွေးချယ်မှု B)"
read_when:
  - macOS UI မပါဘဲ နိုဒ် ချိတ်ဆက်မှု အတည်ပြုချက်များကို အကောင်အထည်ဖော်နေစဉ်
  - အဝေးမှ နိုဒ်များကို အတည်ပြုရန် CLI လုပ်ငန်းစဉ်များ ထည့်သွင်းနေစဉ်
  - Gateway ပရိုတိုကောကို နိုဒ် စီမံခန့်ခွဲမှုဖြင့် တိုးချဲ့နေစဉ်
title: "Gateway ပိုင်ဆိုင်သည့် ချိတ်ဆက်မှု"
---

# Gateway ပိုင်ဆိုင်သည့် ချိတ်ဆက်မှု (ရွေးချယ်မှု B)

ခေတ်မီ PDF.js build က browser workers/DOM globals ကို မျှော်လင့်ထားလို့ Gateway မှာ မသုံးပါဘူး။ Gateway-owned pairing မှာ **Gateway** က ဘယ် node တွေ join ခွင့်ရှိလဲဆိုတာကို ဆုံးဖြတ်တဲ့ အမှန်တရားရင်းမြစ် ဖြစ်ပါတယ်။

UIs (macOS app, နောက်လာမယ့် clients များ) က frontend တွေသာဖြစ်ပြီး pending requests တွေကို approve သို့မဟုတ် reject လုပ်ပါတယ်။
**အရေးကြီး:** WS nodes တွေက `connect` အချိန်မှာ **device pairing** (role `node`) ကို အသုံးပြုပါတယ်။
`node.pair.*` က သီးခြား pairing store တစ်ခုဖြစ်ပြီး WS handshake ကို **မထိန်းချုပ်ပါဘူး**။

## အယူအဆများ

- **Pending request**: နိုဒ်တစ်ခု ဝင်ရောက်ရန် တောင်းဆိုထားပြီး အတည်ပြုရန် လိုအပ်သည်။
- **Paired node**: အတည်ပြုထားပြီး auth token ထုတ်ပေးထားသော နိုဒ်။
- `node.pair.*` ကို အတိအကျ ခေါ်တဲ့ clients တွေပဲ ဒီ flow ကို အသုံးပြုပါတယ်။ **Transport**: Gateway WS endpoint က requests တွေကို forward လုပ်ပေးပေမယ့် membership ကို မဆုံးဖြတ်ပါဘူး။

## ချိတ်ဆက်မှု အလုပ်လုပ်ပုံ

1. နိုဒ်တစ်ခုသည် Gateway WS သို့ ချိတ်ဆက်ပြီး ချိတ်ဆက်မှုကို တောင်းဆိုသည်။
2. Gateway သည် **pending request** ကို သိမ်းဆည်းပြီး `node.pair.requested` ကို ထုတ်လွှင့်သည်။
3. သင်သည် တောင်းဆိုချက်ကို အတည်ပြု သို့မဟုတ် ငြင်းပယ်သည် (CLI သို့မဟုတ် UI)။
4. အတည်ပြုလျှင် Gateway သည် **token အသစ်** ကို ထုတ်ပေးသည် (ပြန်လည် ချိတ်ဆက်သည့်အခါ token များကို လှည့်ပြောင်းထုတ်ပေးသည်)။
5. နိုဒ်သည် token ကို အသုံးပြုပြီး ပြန်လည် ချိတ်ဆက်လာကာ “paired” ဖြစ်သွားသည်။

Pending request များသည် **၅ မိနစ်** အကြာတွင် အလိုအလျောက် သက်တမ်းကုန်ဆုံးသည်။

## CLI လုပ်ငန်းစဉ် (headless အတွက် အဆင်ပြေ)

```bash
openclaw nodes pending
openclaw nodes approve <requestId>
openclaw nodes reject <requestId>
openclaw nodes status
openclaw nodes rename --node <id|name|ip> --name "Living Room iPad"
```

`nodes status` သည် paired/ချိတ်ဆက်ပြီးသား နိုဒ်များနှင့် ၎င်းတို့၏ စွမ်းဆောင်ရည်များကို ပြသသည်။

## API မျက်နှာပြင် (gateway protocol)

Events:

- `node.pair.requested` — pending request အသစ် ဖန်တီးသည့်အခါ ထုတ်လွှင့်သည်။
- `node.pair.resolved` — တောင်းဆိုချက်ကို အတည်ပြု/ငြင်းပယ်/သက်တမ်းကုန်ဆုံးသည့်အခါ ထုတ်လွှင့်သည်။

Methods:

- `node.pair.request` — pending request ကို ဖန်တီး သို့မဟုတ် ပြန်အသုံးပြုသည်။
- `node.pair.list` — pending + paired နိုဒ်များကို စာရင်းပြုစုသည်။
- `node.pair.approve` — pending request ကို အတည်ပြုသည် (token ထုတ်ပေးသည်)။
- `node.pair.reject` — pending request ကို ငြင်းပယ်သည်။
- `node.pair.verify` — `{ nodeId, token }` ကို စစ်ဆေးသည်။

မှတ်ချက်များ:

- `node.pair.request` သည် နိုဒ်တစ်ခုချင်းစီအလိုက် idempotent ဖြစ်သည်—ခေါ်ဆိုမှုများကို ထပ်ခါတလဲလဲ ပြုလုပ်လျှင် တူညီသော pending request ကို ပြန်ပေးသည်။
- အတည်ပြုမှုသည် **အမြဲတမ်း** token အသစ်ကို ဖန်တီးပေးသည်; `node.pair.request` မှ token ကို ဘယ်တော့မှ ပြန်မပေးပါ။
- တောင်းဆိုချက်များတွင် အလိုအလျောက် အတည်ပြု လုပ်ငန်းစဉ်များအတွက် အချက်ပြအနေဖြင့် `silent: true` ပါဝင်နိုင်သည်။

## အလိုအလျောက် အတည်ပြုခြင်း (macOS အက်ပ်)

macOS အက်ပ်သည် အောက်ပါအခြေအနေများတွင် **silent approval** ကို စမ်းသပ်နိုင်သည်—

- တောင်းဆိုချက်ကို `silent` ဟု အမှတ်အသားပြုထားပြီး
- အက်ပ်သည် တူညီသော အသုံးပြုသူကို အသုံးပြုပြီး Gateway ဟို့စ်သို့ SSH ချိတ်ဆက်မှုကို စစ်ဆေးအတည်ပြုနိုင်သောအခါ

Silent approval မအောင်မြင်ပါက ပုံမှန် “Approve/Reject” မေးခွန်းသို့ ပြန်လည် သွားသည်။

## သိုလှောင်မှု (ဒေသခံ၊ သီးသန့်)

ချိတ်ဆက်မှု အခြေအနေကို Gateway state directory အောက်တွင် သိမ်းဆည်းထားသည် (မူလ `~/.openclaw`)—

- `~/.openclaw/nodes/paired.json`
- `~/.openclaw/nodes/pending.json`

`OPENCLAW_STATE_DIR` ကို override လုပ်ပါက `nodes/` ဖိုလ်ဒါသည် ၎င်းနှင့်အတူ ရွှေ့ပြောင်းမည်ဖြစ်သည်။

လုံခြုံရေး မှတ်ချက်များ—

- Token များသည် လျှို့ဝှက်ချက်များဖြစ်သည်; `paired.json` ကို အရေးကြီးအချက်အလက်အဖြစ် ဆက်ဆံပါ။
- Token ကို လှည့်ပြောင်းထုတ်ပေးရန် အတည်ပြုခြင်းကို ထပ်မံ လိုအပ်သည် (သို့မဟုတ် နိုဒ် entry ကို ဖျက်ပစ်ရပါမည်)။

## Transport အပြုအမူ

- Transport သည် **stateless** ဖြစ်ပြီး အဖွဲ့ဝင်မှုကို သိမ်းဆည်းမထားပါ။
- Gateway သည် အော့ဖ်လိုင်းဖြစ်နေပါက သို့မဟုတ် ချိတ်ဆက်မှုကို ပိတ်ထားပါက နိုဒ်များ ချိတ်ဆက်နိုင်မည်မဟုတ်ပါ။
- Gateway သည် remote mode တွင် ရှိနေသော်လည်း ချိတ်ဆက်မှုသည် အဝေးရှိ Gateway ၏ သိုလှောင်ရုံနှင့် ဆက်လက် ပြုလုပ်သည်။
