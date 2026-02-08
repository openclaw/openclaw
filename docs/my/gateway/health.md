---
summary: "ချန်နယ် ချိတ်ဆက်နိုင်မှုအတွက် Health check လုပ်ဆောင်ရမည့် အဆင့်များ"
read_when:
  - WhatsApp ချန်နယ် Health ကို ချို့ယွင်းချက်ရှာဖွေနေစဉ်
title: "Health Checks"
x-i18n:
  source_path: gateway/health.md
  source_hash: 74f242e98244c135
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:54:21Z
---

# Health Checks (CLI)

ခန့်မှန်းခြင်းမလုပ်ဘဲ ချန်နယ် ချိတ်ဆက်နိုင်မှုကို စစ်ဆေးရန် အတိုချုံး လမ်းညွှန်။

## Quick checks

- `openclaw status` — local အကျဉ်းချုပ်: Gateway（ဂိတ်ဝေး） ချိတ်ဆက်နိုင်မှု/မုဒ်၊ အပ်ဒိတ် အကြံပြုချက်၊ ချိတ်ဆက်ထားသော ချန်နယ်၏ အတည်ပြုချက် အသက်ကာလ၊ ဆက်ရှင်များ + လတ်တလော လှုပ်ရှားမှု။
- `openclaw status --all` — local အပြည့်အစုံ ချို့ယွင်းချက် စစ်ဆေးမှု (read-only, အရောင်ပါ, debugging အတွက် paste လုပ်လို့ အဆင်ပြေ)။
- `openclaw status --deep` — လည်ပတ်နေသော Gateway（ဂိတ်ဝေး）ကိုပါ စမ်းသပ်စစ်ဆေးသည် (ထောက်ပံ့ထားပါက ချန်နယ်တစ်ခုချင်းစီအလိုက် probes)။
- `openclaw health --json` — လည်ပတ်နေသော Gateway（ဂိတ်ဝေး）ထံမှ Health snapshot အပြည့်အစုံ တောင်းခံသည် (WS-only; Baileys socket ကို တိုက်ရိုက် မသုံးပါ)။
- Agent ကို မခေါ်ဘဲ အခြေအနေ အဖြေပြန်ရရန် WhatsApp/WebChat တွင် `/status` ကို သီးသန့် မက်ဆေ့ချ်အဖြစ် ပို့ပါ။
- Logs: `/tmp/openclaw/openclaw-*.log` ကို tail လုပ်ပြီး `web-heartbeat`, `web-reconnect`, `web-auto-reply`, `web-inbound` များဖြင့် filter လုပ်ပါ။

## Deep diagnostics

- Disk ပေါ်ရှိ Creds: `ls -l ~/.openclaw/credentials/whatsapp/<accountId>/creds.json` (mtime သည် လတ်တလော ဖြစ်သင့်သည်)။
- Session store: `ls -l ~/.openclaw/agents/<agentId>/sessions/sessions.json` (path ကို config တွင် override လုပ်နိုင်သည်)။ အရေအတွက်နှင့် လတ်တလော လက်ခံသူများကို `status` မှတစ်ဆင့် ပြသထားသည်။
- Relink flow: logs တွင် status codes 409–515 သို့မဟုတ် `loggedOut` ပေါ်လာပါက `openclaw channels logout && openclaw channels login --verbose` ကို အသုံးပြုပါ။ (မှတ်ချက်: pairing ပြီးနောက် status 515 ဖြစ်ပါက QR login flow သည် အလိုအလျောက် တစ်ကြိမ် ပြန်လည်စတင်ပါသည်)။

## When something fails

- `logged out` သို့မဟုတ် status 409–515 → `openclaw channels logout` ဖြင့် relink လုပ်ပြီး ထို့နောက် `openclaw channels login` ကို လုပ်ဆောင်ပါ။
- Gateway（ဂိတ်ဝေး） မရောက်နိုင်ပါက → စတင်ပါ: `openclaw gateway --port 18789` (port အလုပ်ရှုပ်နေပါက `--force` ကို အသုံးပြုပါ)။
- အဝင် မက်ဆေ့ချ်များ မရှိပါက → ချိတ်ဆက်ထားသော ဖုန်း အွန်လိုင်း ဖြစ်နေကြောင်းနှင့် ပို့သူသည် ခွင့်ပြုထားသူ ဖြစ်ကြောင်း အတည်ပြုပါ (`channels.whatsapp.allowFrom`)။ အုပ်စုချတ်များအတွက် allowlist + mention စည်းမျဉ်းများ ကိုက်ညီနေကြောင်း စစ်ဆေးပါ (`channels.whatsapp.groups`, `agents.list[].groupChat.mentionPatterns`)။

## Dedicated "health" command

`openclaw health --json` သည် လည်ပတ်နေသော Gateway（ဂိတ်ဝေး）ထံမှ ၎င်း၏ Health snapshot ကို တောင်းခံသည် (CLI မှ ချန်နယ် socket များကို တိုက်ရိုက် မချိတ်ဆက်ပါ)။ ရရှိနိုင်ပါက ချိတ်ဆက်ထားသော creds/အတည်ပြုချက် အသက်ကာလ၊ ချန်နယ်တစ်ခုချင်းစီအလိုက် probe အကျဉ်းချုပ်များ၊ session-store အကျဉ်းချုပ်နှင့် probe ကြာချိန်ကို တင်ပြပါသည်။ Gateway မရောက်နိုင်ပါက သို့မဟုတ် probe မအောင်မြင်/timeout ဖြစ်ပါက non-zero ဖြင့် exit လုပ်ပါသည်။ 10s default ကို override လုပ်ရန် `--timeout <ms>` ကို အသုံးပြုပါ။
