---
summary: "မော်ဒယ် ပံ့ပိုးသူများအတွက် OAuth သက်တမ်းကုန်ဆုံးမှုကို စောင့်ကြည့်ရန်"
read_when:
  - Auth သက်တမ်းကုန်ဆုံးမှု စောင့်ကြည့်ခြင်း သို့မဟုတ် သတိပေးချက်များကို တပ်ဆင်နေစဉ်
  - Claude Code / Codex OAuth ပြန်လည်သက်တမ်းတိုး စစ်ဆေးမှုများကို အလိုအလျောက်လုပ်ဆောင်နေစဉ်
title: "Auth စောင့်ကြည့်ခြင်း"
x-i18n:
  source_path: automation/auth-monitoring.md
  source_hash: eef179af9545ed7a
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:53:52Z
---

# Auth စောင့်ကြည့်ခြင်း

OpenClaw သည် OAuth သက်တမ်းကုန်ဆုံးမှု အခြေအနေကို `openclaw models status` မှတဆင့် ထုတ်ပြန်ပေးပါသည်။ အလိုအလျောက်လုပ်ဆောင်ခြင်းနှင့် သတိပေးချက်များအတွက် ထိုအချက်အလက်ကို အသုံးပြုနိုင်ပါသည်။ ဖုန်းအခြေပြု workflow များအတွက် script များသည် ရွေးချယ်စရာ အပိုများသာ ဖြစ်ပါသည်။

## ဦးစားပေးထားသော နည်းလမ်း: CLI စစ်ဆေးမှု (portable)

```bash
openclaw models status --check
```

Exit code များ:

- `0`: OK
- `1`: သက်တမ်းကုန်ဆုံးပြီး သို့မဟုတ် အထောက်အထားမရှိပါ
- `2`: မကြာမီ သက်တမ်းကုန်ဆုံးမည် (24 နာရီအတွင်း)

ဤနည်းလမ်းသည် cron/systemd တွင် အလုပ်လုပ်နိုင်ပြီး အပို script မလိုအပ်ပါ။

## ရွေးချယ်စရာ script များ (ops / ဖုန်း workflow များ)

ဤ script များသည် `scripts/` အောက်တွင် ရှိပြီး **ရွေးချယ်စရာသာ** ဖြစ်ပါသည်။ ၎င်းတို့သည် Gateway ဟို့စ် သို့ SSH ဝင်ရောက်ခွင့်ရှိသည်ဟု ယူဆပြီး systemd + Termux အတွက် ချိန်ညှိထားပါသည်။

- `scripts/claude-auth-status.sh` သည် ယခုအခါ `openclaw models status --json` ကို အမှန်တကယ် ယုံကြည်ရသော အရင်းအမြစ်အဖြစ် အသုံးပြုပါသည် (CLI မရရှိနိုင်ပါက တိုက်ရိုက် ဖိုင်ဖတ်ခြင်းကို ပြန်လည်အသုံးပြုပါသည်)။ ထို့ကြောင့် timer များအတွက် `PATH` ပေါ်တွင် `openclaw` ကို ထိန်းသိမ်းထားပါ။
- `scripts/auth-monitor.sh`: cron/systemd timer အတွက် ဦးတည်ချက်; သတိပေးချက်များ (ntfy သို့မဟုတ် ဖုန်း) ပို့ပါသည်။
- `scripts/systemd/openclaw-auth-monitor.{service,timer}`: systemd user timer။
- `scripts/claude-auth-status.sh`: Claude Code + OpenClaw auth စစ်ဆေးကိရိယာ (full/json/simple)။
- `scripts/mobile-reauth.sh`: SSH မှတဆင့် လမ်းညွှန်ထားသော ပြန်လည် auth လုပ်ငန်းစဉ်။
- `scripts/termux-quick-auth.sh`: widget အခြေအနေကို တစ်ချက်နှိပ်ကြည့်ရှုခြင်း + auth URL ဖွင့်ခြင်း။
- `scripts/termux-auth-widget.sh`: လမ်းညွှန်ပြည့်စုံသော widget workflow။
- `scripts/termux-sync-widget.sh`: Claude Code အထောက်အထားများကို OpenClaw သို့ sync လုပ်ခြင်း။

ဖုန်း အလိုအလျောက်လုပ်ဆောင်မှု သို့မဟုတ် systemd timer များ မလိုအပ်ပါက ဤ script များကို ကျော်သွားနိုင်ပါသည်။
