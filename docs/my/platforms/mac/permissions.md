---
summary: "macOS ခွင့်ပြုချက်များ (TCC) ကို ဆက်လက်တည်တံ့စေခြင်းနှင့် လက်မှတ်ရေးထိုးခြင်း လိုအပ်ချက်များ"
read_when:
  - macOS ခွင့်ပြုချက် ပေါ်ပေါက်မလာခြင်း သို့မဟုတ် ကပ်နေရခြင်းကို Debug လုပ်နေစဉ်
  - macOS အက်ပ်ကို ပက်ကေ့ချ်လုပ်ခြင်း သို့မဟုတ် လက်မှတ်ရေးထိုးခြင်း ပြုလုပ်နေစဉ်
  - bundle ID များ သို့မဟုတ် အက်ပ် ထည့်သွင်းထားသော လမ်းကြောင်းများကို ပြောင်းလဲနေစဉ်
title: "macOS ခွင့်ပြုချက်များ"
---

# macOS ခွင့်ပြုချက်များ (TCC)

38. macOS permission grants များသည် မတည်ငြိမ်ပါ။ 39. TCC သည် permission grant ကို အက်ပ်၏ code signature၊ bundle identifier နှင့် disk ပေါ်ရှိ path တို့နှင့် ဆက်စပ်ထားပါသည်။ 40. ၎င်းတို့ထဲမှ တစ်ခုခု ပြောင်းလဲသွားပါက macOS သည် အက်ပ်ကို အသစ်အဖြစ် သတ်မှတ်ပြီး prompt များကို drop လုပ်ခြင်း သို့မဟုတ် ဖျောက်ထားခြင်း ဖြစ်နိုင်ပါသည်။

## ခွင့်ပြုချက်များ တည်ငြိမ်စေရန် လိုအပ်ချက်များ

- လမ်းကြောင်းတူညီမှု: အက်ပ်ကို တည်ငြိမ်သော တစ်နေရာတည်းမှ လည်ပတ်ပါ (OpenClaw အတွက် `dist/OpenClaw.app`)။
- bundle identifier တူညီမှု: bundle ID ပြောင်းလဲခြင်းသည် ခွင့်ပြုချက် အမှတ်အသား အသစ်တစ်ခု ဖန်တီးပါသည်။
- လက်မှတ်ရေးထိုးထားသော အက်ပ်: လက်မှတ်မထိုးထားသော သို့မဟုတ် ad-hoc လက်မှတ်ထိုးထားသော build များသည် ခွင့်ပြုချက်များကို မထိန်းသိမ်းနိုင်ပါ။
- လက်မှတ် တည်ငြိမ်မှု: Apple Development သို့မဟုတ် Developer ID လက်မှတ် အမှန်တစ်ခုကို အသုံးပြုပါ
  build များကို ပြန်လည်တည်ဆောက်သည့်အခါတိုင်း လက်မှတ် တူညီနေစေရန်။

41. Ad-hoc signature များသည် build တစ်ခုစီတိုင်း identity အသစ်ကို ထုတ်လုပ်ပါသည်။ 42. macOS သည် ယခင် grant များကို မေ့သွားပြီး stale entry များကို ရှင်းလင်းမချင်း prompt များ လုံးဝ ပျောက်သွားနိုင်ပါသည်။

## prompt များ ပျောက်သွားသောအခါ ပြန်လည်ရယူရန် စစ်ဆေးရန်စာရင်း

1. အက်ပ်ကို ပိတ်ပါ။
2. System Settings -> Privacy & Security ထဲမှ အက်ပ် entry ကို ဖယ်ရှားပါ။
3. အက်ပ်ကို တူညီသော လမ်းကြောင်းမှ ပြန်လည်ဖွင့်ပြီး ခွင့်ပြုချက်များကို ပြန်လည် ချထားပေးပါ။
4. prompt မပေါ်သေးပါက `tccutil` ဖြင့် TCC entry များကို reset လုပ်ပြီး ထပ်မံ ကြိုးစားပါ။
5. ခွင့်ပြုချက် အချို့သည် macOS ကို အပြည့်အဝ restart ပြုလုပ်ပြီးနောက်မှသာ ပြန်ပေါ်လာပါသည်။

Reset ဥပမာများ (လိုအပ်သလို bundle ID ကို အစားထိုးပါ):

```bash
sudo tccutil reset Accessibility bot.molt.mac
sudo tccutil reset ScreenCapture bot.molt.mac
sudo tccutil reset AppleEvents
```

## ဖိုင်များနှင့် ဖိုလ်ဒါ ခွင့်ပြုချက်များ (Desktop/Documents/Downloads)

43. macOS သည် terminal/background process များအတွက် Desktop၊ Documents နှင့် Downloads ကိုလည်း gate လုပ်နိုင်ပါသည်။ 44. File read သို့မဟုတ် directory listing များ hang ဖြစ်ပါက file operation များကို လုပ်ဆောင်သော process context တူညီသို့ access ပေးပါ (ဥပမာ Terminal/iTerm၊ LaunchAgent မှ စတင်ထားသော app၊ သို့မဟုတ် SSH process)။

အစားထိုးနည်း: ဖိုလ်ဒါတစ်ခုချင်းစီအလိုက် ခွင့်ပြုချက် မပေးချင်ပါက ဖိုင်များကို OpenClaw workspace (`~/.openclaw/workspace`) ထဲသို့ ရွှေ့ပါ။

45. Permission များကို စမ်းသပ်နေပါက အမြဲတမ်း certificate အစစ်ဖြင့် sign လုပ်ပါ။ 46. Ad-hoc builds များကို permission မအရေးကြီးသော quick local run များအတွက်သာ လက်ခံနိုင်ပါသည်။
