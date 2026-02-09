---
summary: "`openclaw nodes` အတွက် CLI ကိုးကားချက် (list/status/approve/invoke၊ camera/canvas/screen)"
read_when:
  - တွဲဖက်ထားသော နိုဒ်များ (ကင်မရာ၊ စခရင်၊ ကန်ဗတ်စ်) ကို စီမံခန့်ခွဲနေသောအခါ
  - တောင်းဆိုချက်များကို အတည်ပြုရန် သို့မဟုတ် နိုဒ် အမိန့်များကို invoke လုပ်ရန် လိုအပ်သောအခါ
title: "နိုဒ်များ"
---

# `openclaw nodes`

တွဲဖက်ထားသော နိုဒ်များ (ကိရိယာများ) ကို စီမံခန့်ခွဲပြီး နိုဒ် စွမ်းရည်များကို invoke လုပ်ပါ။

ဆက်စပ်အကြောင်းအရာများ—

- Nodes အကျဉ်းချုပ်: [Nodes](/nodes)
- ကင်မရာ: [Camera nodes](/nodes/camera)
- ပုံများ: [Image nodes](/nodes/images)

အများဆုံးအသုံးပြုသော ရွေးချယ်စရာများ—

- `--url`, `--token`, `--timeout`, `--json`

## အများဆုံးအသုံးပြုသော အမိန့်များ

```bash
openclaw nodes list
openclaw nodes list --connected
openclaw nodes list --last-connected 24h
openclaw nodes pending
openclaw nodes approve <requestId>
openclaw nodes status
openclaw nodes status --connected
openclaw nodes status --last-connected 24h
```

`nodes list` သည် pending/paired table များကို ပုံနှိပ်ပြသပါသည်။ Paired row များတွင် နောက်ဆုံး ချိတ်ဆက်ခဲ့သော အချိန်ကာလ (Last Connect) ပါဝင်ပါသည်။
လက်ရှိ ချိတ်ဆက်နေသော node များကိုသာ ပြရန် `--connected` ကို အသုံးပြုပါ။ `--last-connected <duration>` ကို အသုံးပြုပြီး သတ်မှတ်ထားသော ကာလအတွင်း ချိတ်ဆက်ခဲ့သော node များကိုသာ စစ်ထုတ်ပြပါ (ဥပမာ: `24h`, `7d`)။

## Invoke / run

```bash
openclaw nodes invoke --node <id|name|ip> --command <command> --params <json>
openclaw nodes run --node <id|name|ip> <command...>
openclaw nodes run --raw "git status"
openclaw nodes run --agent main --node <id|name|ip> --raw "git status"
```

Invoke အလံများ—

- `--params <json>`: JSON object စာကြောင်း (မူလတန်ဖိုး `{}`)။
- `--invoke-timeout <ms>`: နိုဒ် invoke အချိန်ကန့်သတ်ချက် (မူလတန်ဖိုး `15000`)။
- `--idempotency-key <key>`: မဖြစ်မနေ မလိုအပ်သော idempotency ကီး။

### Exec ပုံစံ မူလသတ်မှတ်ချက်များ

`nodes run` သည် မော်ဒယ်၏ exec အပြုအမူ (မူလတန်ဖိုးများ + အတည်ပြုချက်များ) ကို ပြန်လည်လိုက်နာပါသည်—

- `tools.exec.*` ကို ဖတ်ပါသည် (`agents.list[].tools.exec.*` အစားထိုးများ ပါဝင်သည်)။
- `system.run` ကို invoke မလုပ်မီ exec approvals (`exec.approval.request`) ကို အသုံးပြုပါသည်။
- `tools.exec.node` ကို သတ်မှတ်ထားသောအခါ `--node` ကို ချန်လှပ်နိုင်ပါသည်။
- `system.run` ကို ကြော်ငြာထားသော နိုဒ်တစ်ခု လိုအပ်ပါသည် (macOS companion app သို့မဟုတ် headless node host)။

အလံများ—

- `--cwd <path>`: အလုပ်လုပ်မည့် လမ်းကြောင်း။
- `--env <key=val>`: env အစားထိုး (ထပ်ခါတလဲလဲ သုံးနိုင်သည်)။
- `--command-timeout <ms>`: အမိန့် အချိန်ကန့်သတ်ချက်။
- `--invoke-timeout <ms>`: နိုဒ် invoke အချိန်ကန့်သတ်ချက် (မူလတန်ဖိုး `30000`)။
- `--needs-screen-recording`: စခရင် မှတ်တမ်းတင်ခွင့် လိုအပ်စေရန်။
- `--raw <command>`: shell စာကြောင်းတစ်ခုကို လုပ်ဆောင်ပါ (`/bin/sh -lc` သို့မဟုတ် `cmd.exe /c`)။
- `--agent <id>`: agent အလိုက် သတ်မှတ်ထားသော approvals/allowlists (စနစ်သတ်မှတ်ထားသော agent ကို မူလအဖြစ် အသုံးပြုသည်)။
- `--ask <off|on-miss|always>`, `--security <deny|allowlist|full>`: အစားထိုးသတ်မှတ်ချက်များ။
