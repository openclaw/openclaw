---
summary: "OpenClaw လော့ဂ်မှတ်တမ်းများ: လှည့်ပတ်သည့် ဒိုင်ယာဂနော့စတစ် ဖိုင်လော့ဂ် + unified log ကိုယ်ရေးလုံခြုံရေး အလံများ"
read_when:
  - macOS လော့ဂ်များကို ဖမ်းယူနေစဉ် သို့မဟုတ် ကိုယ်ရေးလုံခြုံရေး ဒေတာ လော့ဂ်တင်ခြင်းကို စုံစမ်းစစ်ဆေးနေစဉ်
  - အသံ wake/ဆက်ရှင် အသက်ဝင်မှု စက်ဝိုင်း ပြဿနာများကို ဒီဘတ်လုပ်နေစဉ်
title: "macOS လော့ဂ်မှတ်တမ်းများ"
---

# Logging (macOS)

## လှည့်ပတ်သည့် ဒိုင်ယာဂနော့စတစ် ဖိုင်လော့ဂ် (Debug pane)

OpenClaw သည် macOS အက်ပ် လော့ဂ်များကို swift-log မှတစ်ဆင့် (ပုံမှန်အားဖြင့် unified logging) လမ်းကြောင်းချပြီး၊ အမြဲတမ်း သိမ်းဆည်းနိုင်သော ဖမ်းယူမှု လိုအပ်သည့်အခါ ဒစ်စ်ပေါ်သို့ ဒေသတွင်း လှည့်ပတ်သည့် ဖိုင်လော့ဂ်ကို ရေးသားနိုင်သည်။

- အသေးစိတ်အဆင့်: **Debug pane → Logs → App logging → Verbosity**
- ဖွင့်ရန်: **Debug pane → Logs → App logging → “Write rolling diagnostics log (JSONL)”**
- Location: `~/Library/Logs/OpenClaw/diagnostics.jsonl` (rotates automatically; old files are suffixed with `.1`, `.2`, …)
- ရှင်းလင်းရန်: **Debug pane → Logs → App logging → “Clear”**

မှတ်ချက်များ:

- 19. ၎င်းသည် **default အနေဖြင့် ပိတ်ထားသည်**။ 20. Debugging ကို တက်ကြွစွာ လုပ်နေချိန်တွင်သာ Enable လုပ်ပါ။
- ဖိုင်ကို ကိုယ်ရေးလုံခြုံရေးဆိုင်ရာ အချက်အလက်များ ပါဝင်နိုင်သဖြင့် သတိထားပါ။ စိစစ်မလုပ်ဘဲ မမျှဝေပါနှင့်။

## macOS တွင် Unified logging ကိုယ်ရေးလုံခြုံရေး ဒေတာ

21. Unified logging သည် subsystem က `privacy -off` ကို opt-in မလုပ်လျှင် payload အများစုကို redact လုပ်ပါသည်။ 22. Peter ၏ macOS [logging privacy shenanigans](https://steipete.me/posts/2025/logging-privacy-shenanigans) (2025) ဆိုင်ရာရေးသားချက်အရ ၎င်းကို subsystem အမည်ဖြင့် key လုပ်ထားသော `/Library/Preferences/Logging/Subsystems/` ထဲရှိ plist တစ်ခုမှ ထိန်းချုပ်ပါသည်။ Only new log entries pick up the flag, so enable it before reproducing an issue.

## OpenClaw အတွက် ဖွင့်ရန် (`bot.molt`)

- plist ကို အရင်ဆုံး ယာယီဖိုင်အဖြစ် ရေးသားပြီးနောက် root အဖြစ် atomic နည်းလမ်းဖြင့် ထည့်သွင်းပါ—

```bash
cat <<'EOF' >/tmp/bot.molt.plist
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>DEFAULT-OPTIONS</key>
    <dict>
        <key>Enable-Private-Data</key>
        <true/>
    </dict>
</dict>
</plist>
EOF
sudo install -m 644 -o root -g wheel /tmp/bot.molt.plist /Library/Preferences/Logging/Subsystems/bot.molt.plist
```

- Reboot မလိုအပ်ပါ; logd သည် ဖိုင်ကို မြန်မြန် သတိပြုမိပါသည်၊ သို့သော် လော့ဂ်လိုင်း အသစ်များတွင်သာ ကိုယ်ရေးဒေတာ payload များ ပါဝင်လာမည်ဖြစ်သည်။
- ပိုမိုကြွယ်ဝသော အထွက်ကို ရှိပြီးသား helper ဖြင့် ကြည့်ရှုနိုင်သည်၊ ဥပမာ `./scripts/clawlog.sh --category WebChat --last 5m`။

## ဒီဘတ်ပြီးနောက် ပိတ်ရန်

- override ကို ဖယ်ရှားပါ: `sudo rm /Library/Preferences/Logging/Subsystems/bot.molt.plist`။
- လိုအပ်ပါက logd ကို ချက်ချင်း override ကို ဖယ်ရှားစေရန် `sudo log config --reload` ကို လည်ပတ်နိုင်သည်။
- ဤမျက်နှာပြင်တွင် ဖုန်းနံပါတ်များနှင့် မက်ဆေ့ချ် ကိုယ်ထည်များ ပါဝင်နိုင်သည်ကို သတိရပါ; ထပ်ဆောင်း အသေးစိတ်လိုအပ်သည့်အချိန်တွင်သာ plist ကို ထားရှိပါ။
