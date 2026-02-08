---
summary: "`openclaw devices` အတွက် CLI ကိုးကားချက် (စက်ပစ္စည်းတွဲချိတ်ခြင်း + တိုကင် လှည့်ပြောင်းခြင်း/ပြန်လည်ရုပ်သိမ်းခြင်း)"
read_when:
  - စက်ပစ္စည်း တွဲချိတ်ရန် တောင်းဆိုမှုများကို သင် အတည်ပြုနေသောအခါ
  - စက်ပစ္စည်း တိုကင်များကို လှည့်ပြောင်းခြင်း သို့မဟုတ် ပြန်လည်ရုပ်သိမ်းရန် လိုအပ်သောအခါ
title: "devices"
x-i18n:
  source_path: cli/devices.md
  source_hash: ac7d130ecdc5d429
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:53:59Z
---

# `openclaw devices`

စက်ပစ္စည်း တွဲချိတ်ရန် တောင်းဆိုမှုများနှင့် စက်ပစ္စည်းအဆင့် သတ်မှတ်ထားသော တိုကင်များကို စီမံခန့်ခွဲပါ။

## Commands

### `openclaw devices list`

ဆိုင်းငံ့ထားသော တွဲချိတ်ရန် တောင်းဆိုမှုများနှင့် တွဲချိတ်ပြီးသား စက်ပစ္စည်းများကို စာရင်းပြုလုပ်ပါ။

```
openclaw devices list
openclaw devices list --json
```

### `openclaw devices approve <requestId>`

ဆိုင်းငံ့ထားသော စက်ပစ္စည်း တွဲချိတ်ရန် တောင်းဆိုမှုကို အတည်ပြုပါ။

```
openclaw devices approve <requestId>
```

### `openclaw devices reject <requestId>`

ဆိုင်းငံ့ထားသော စက်ပစ္စည်း တွဲချိတ်ရန် တောင်းဆိုမှုကို ငြင်းပယ်ပါ။

```
openclaw devices reject <requestId>
```

### `openclaw devices rotate --device <id> --role <role> [--scope <scope...>]`

သတ်မှတ်ထားသော အခန်းကဏ္ဍအတွက် စက်ပစ္စည်း တိုကင်ကို လှည့်ပြောင်းပါ (ရွေးချယ်စရာအနေဖြင့် scope များကို အပ်ဒိတ်လုပ်နိုင်သည်)။

```
openclaw devices rotate --device <deviceId> --role operator --scope operator.read --scope operator.write
```

### `openclaw devices revoke --device <id> --role <role>`

သတ်မှတ်ထားသော အခန်းကဏ္ဍအတွက် စက်ပစ္စည်း တိုကင်ကို ပြန်လည်ရုပ်သိမ်းပါ။

```
openclaw devices revoke --device <deviceId> --role node
```

## Common options

- `--url <url>`: Gateway WebSocket URL (ဖွဲ့စည်းပြင်ဆင်ထားပါက မူလအတိုင်း `gateway.remote.url` ကို အသုံးပြုသည်)။
- `--token <token>`: Gateway တိုကင် (လိုအပ်ပါက)။
- `--password <password>`: Gateway စကားဝှက် (စကားဝှက်ဖြင့် အတည်ပြုခြင်း)။
- `--timeout <ms>`: RPC အချိန်ကန့်သတ်။
- `--json`: JSON အထွက် (script အသုံးပြုရန် အကြံပြုသည်)။

မှတ်ချက်: `--url` ကို သတ်မှတ်လိုက်ပါက CLI သည် config သို့မဟုတ် ပတ်ဝန်းကျင် အထောက်အထားများကို ပြန်လည်အသုံးမပြုတော့ပါ။
`--token` သို့မဟုတ် `--password` ကို တိတိကျကျ ပေးပို့ရပါမည်။ အထောက်အထားများကို တိတိကျကျ မပေးပါက အမှားအယွင်းဖြစ်ပါသည်။

## Notes

- တိုကင် လှည့်ပြောင်းခြင်းသည် တိုကင်အသစ် (အရေးကြီးသော အချက်အလက်) ကို ပြန်လည်ပေးအပ်ပါသည်။ လျှို့ဝှက်ချက်တစ်ခုအဖြစ် ကိုင်တွယ်ပါ။
- ဤအမိန့်များကို အသုံးပြုရန် `operator.pairing` (သို့မဟုတ် `operator.admin`) scope လိုအပ်ပါသည်။
