---
summary: "တိုက်ရိုက် `openclaw agent` CLI ကို လုပ်ဆောင်ခြင်း (ပို့ဆောင်မှုကို ရွေးချယ်နိုင်သည်)"
read_when:
  - အေးဂျင့် CLI entrypoint ကို ထည့်သွင်းခြင်း သို့မဟုတ် ပြင်ဆင်ခြင်း ပြုလုပ်နေချိန်
title: "Agent Send"
---

# `openclaw agent` (တိုက်ရိုက် အေးဂျင့် လုပ်ဆောင်မှုများ)

`openclaw agent` သည် inbound chat message မလိုအပ်ဘဲ agent turn တစ်ကြိမ်ကို အလုပ်လုပ်စေပါသည်။
ပုံမှန်အားဖြင့် **Gateway မှတစ်ဆင့်** လုပ်ဆောင်သည်; လက်ရှိစက်ပေါ်ရှိ embedded runtime ကို အတင်းအသုံးပြုလိုပါက `--local` ကို ထည့်ပါ။

## Behavior

- လိုအပ်ချက်: `--message <text>`
- Session ရွေးချယ်မှု:
  - `--to <dest>` သည် session key ကို ဆင်းသက်တွက်ချက်ပေးသည် (group/channel ရည်မှန်းချက်များသည် isolation ကို ထိန်းသိမ်းထားပြီး; direct chats များသည် `main` သို့ ပေါင်းစည်းသွားသည်), **သို့မဟုတ်**
  - `--session-id <id>` သည် id ဖြင့် ရှိပြီးသား session ကို ပြန်လည်အသုံးပြုသည်, **သို့မဟုတ်**
  - `--agent <id>` သည် ပြင်ဆင်ထားသော အေးဂျင့် တစ်ခုကို တိုက်ရိုက် ရည်မှန်းသည် (အဲဒီ အေးဂျင့်၏ `main` session key ကို အသုံးပြုသည်)
- ပုံမှန် ဝင်ရောက်လာသော အဖြေများကဲ့သို့ တူညီသော embedded အေးဂျင့် runtime ကို လည်ပတ်သည်။
- Thinking/verbose flags များကို session store အတွင်း ဆက်လက် ထိန်းသိမ်းထားသည်။
- Output:
  - ပုံမှန်: အဖြေစာသားကို ပုံနှိပ်ပြသသည် (`MEDIA:<url>` လိုင်းများ ပါဝင်)
  - `--json`: ဖွဲ့စည်းထားသော payload + metadata ကို ပုံနှိပ်ပြသသည်
- `--deliver` + `--channel` ဖြင့် ချန်နယ်သို့ ပြန်လည်ပို့ဆောင်နိုင်သည် (target ဖော်မတ်များသည် `openclaw message --target` နှင့် ကိုက်ညီသည်)။
- Session ကို မပြောင်းလဲဘဲ ပို့ဆောင်မှုကို အစားထိုးသတ်မှတ်ရန် `--reply-channel`/`--reply-to`/`--reply-account` ကို အသုံးပြုပါ။

Gateway（ဂိတ်ဝေး） ကို မရောက်နိုင်ပါက CLI သည် embedded local run သို့ **ပြန်လည်လှည့်သွား** ပါသည်။

## Examples

```bash
openclaw agent --to +15555550123 --message "status update"
openclaw agent --agent ops --message "Summarize logs"
openclaw agent --session-id 1234 --message "Summarize inbox" --thinking medium
openclaw agent --to +15555550123 --message "Trace logs" --verbose on --json
openclaw agent --to +15555550123 --message "Summon reply" --deliver
openclaw agent --agent ops --message "Generate report" --deliver --reply-channel slack --reply-to "#reports"
```

## Flags

- `--local`: local အဖြစ် လည်ပတ်ပါ (သင့် shell အတွင်း model provider API keys လိုအပ်သည်)
- `--deliver`: ရွေးချယ်ထားသော ချန်နယ်သို့ အဖြေကို ပို့ပါ
- `--channel`: ပို့ဆောင်မည့် ချန်နယ် (`whatsapp|telegram|discord|googlechat|slack|signal|imessage`, မူလ: `whatsapp`)
- `--reply-to`: ပို့ဆောင်မည့် target ကို အစားထိုးသတ်မှတ်ရန်
- `--reply-channel`: ပို့ဆောင်မည့် ချန်နယ်ကို အစားထိုးသတ်မှတ်ရန်
- `--reply-account`: ပို့ဆောင်မည့် account id ကို အစားထိုးသတ်မှတ်ရန်
- `--thinking <off|minimal|low|medium|high|xhigh>`: thinking အဆင့်ကို ဆက်လက်သိမ်းဆည်းရန် (GPT-5.2 + Codex မော်ဒယ်များသာ)
- `--verbose <on|full|off>`: verbose အဆင့်ကို ဆက်လက်သိမ်းဆည်းရန်
- `--timeout <seconds>`: အေးဂျင့် timeout ကို အစားထိုးသတ်မှတ်ရန်
- `--json`: ဖွဲ့စည်းထားသော JSON ကို ထုတ်ပေးရန်
