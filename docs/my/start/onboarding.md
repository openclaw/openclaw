---
summary: "OpenClaw (macOS အက်ပ်) အတွက် ပထမအကြိမ် စတင်အသုံးပြုရာတွင် လမ်းညွှန်သည့် onboarding လုပ်ငန်းစဉ်"
read_when:
  - macOS onboarding assistant ကို ဒီဇိုင်းဆွဲနေချိန်
  - auth သို့မဟုတ် identity setup ကို အကောင်အထည်ဖော်နေချိန်
title: "Onboarding (macOS အက်ပ်)"
sidebarTitle: "Onboarding: macOS App"
x-i18n:
  source_path: start/onboarding.md
  source_hash: 45f912067527158f
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:55:03Z
---

# Onboarding (macOS အက်ပ်)

ဤစာရွက်စာတမ်းသည် လက်ရှိ အသုံးပြုနေသော ပထမအကြိမ် စတင်အသုံးပြုရာတွင် onboarding လုပ်ငန်းစဉ်ကို ဖော်ပြထားသည်။ ရည်ရွယ်ချက်မှာ ချောမွေ့သော “day 0” အတွေ့အကြုံတစ်ခုကို ပေးရန်ဖြစ်ပြီး Gateway ကို မည်သည့်နေရာတွင် chạy မည်ကို ရွေးချယ်ခြင်း၊ auth ကို ချိတ်ဆက်ခြင်း၊ wizard ကို chạy ခြင်းနှင့် agent ကို ကိုယ်တိုင် bootstrap လုပ်စေခြင်းတို့ ပါဝင်သည်။

<Steps>
<Step title="macOS သတိပေးချက်ကို အတည်ပြုပါ">
<Frame>
<img src="/assets/macos-onboarding/01-macos-warning.jpeg" alt="" />
</Frame>
</Step>
<Step title="local networks ကို ရှာဖွေရန် ခွင့်ပြုပါ">
<Frame>
<img src="/assets/macos-onboarding/02-local-networks.jpeg" alt="" />
</Frame>
</Step>
<Step title="ကြိုဆိုစာနှင့် လုံခြုံရေး သတိပေးချက်">
<Frame caption="ပြသထားသော လုံခြုံရေး သတိပေးချက်ကို ဖတ်ရှုပြီး သင့်အနေဖြင့် ဆုံးဖြတ်ပါ">
<img src="/assets/macos-onboarding/03-security-notice.png" alt="" />
</Frame>
</Step>
<Step title="Local နှင့် Remote">
<Frame>
<img src="/assets/macos-onboarding/04-choose-gateway.png" alt="" />
</Frame>

**Gateway** ကို မည်သည့်နေရာတွင် chạy မည်နည်း။

- **This Mac (Local only):** onboarding သည် OAuth လုပ်ငန်းစဉ်များကို chạy နိုင်ပြီး credentials များကို local တွင် ရေးသားနိုင်သည်။
- **Remote (over SSH/Tailnet):** onboarding သည် OAuth ကို local တွင် **မ** chạy ပါ။ credentials များသည် Gateway ဟို့စ် ပေါ်တွင် ရှိပြီးသား ဖြစ်ရမည်။
- **Configure later:** setup ကို ကျော်သွားပြီး အက်ပ်ကို မဖွဲ့စည်းထားဘဲ ထားပါ။

<Tip>
**Gateway auth အကြံပြုချက်:**
- ယခု wizard သည် loopback အတွက်တောင် **token** တစ်ခုကို ထုတ်ပေးသဖြင့် local WS clients များသည် authenticate လုပ်ရပါမည်။
- auth ကို ပိတ်ထားပါက local process မည်သည့်အရာမဆို ချိတ်ဆက်နိုင်မည်ဖြစ်သည်။ ယုံကြည်စိတ်ချရသော စက်များတွင်သာ အသုံးပြုပါ။
- စက်အများအပြားမှ ဝင်ရောက်အသုံးပြုရန် သို့မဟုတ် non‑loopback binds အတွက် **token** ကို အသုံးပြုပါ။
</Tip>
</Step>
<Step title="ခွင့်ပြုချက်များ">
<Frame caption="OpenClaw ကို မည်သည့် ခွင့်ပြုချက်များ ပေးမည်ကို ရွေးချယ်ပါ">
<img src="/assets/macos-onboarding/05-permissions.png" alt="" />
</Frame>

Onboarding သည် အောက်ပါအရာများအတွက် လိုအပ်သော TCC ခွင့်ပြုချက်များကို တောင်းခံပါသည်—

- Automation (AppleScript)
- Notifications
- Accessibility
- Screen Recording
- Microphone
- Speech Recognition
- Camera
- Location

</Step>
<Step title="CLI">
  <Info>ဤအဆင့်သည် မဖြစ်မနေ မလိုအပ်ပါ</Info>
  အက်ပ်သည် global `openclaw` CLI ကို npm/pnpm မှတစ်ဆင့် ထည့်သွင်းနိုင်ပြီး terminal
  workflow များနှင့် launchd tasks များကို အစမှစ၍ အသုံးပြုနိုင်စေပါသည်။
</Step>
<Step title="Onboarding Chat (သီးသန့် ဆက်ရှင်)">
  Setup ပြီးဆုံးပြီးနောက် အက်ပ်သည် သီးသန့် onboarding chat ဆက်ရှင်တစ်ခုကို ဖွင့်ပေးပြီး agent က
  မိမိကိုယ်ကို မိတ်ဆက်ကာ နောက်တစ်ဆင့်များကို လမ်းညွှန်ပေးပါသည်။ ၎င်းသည် ပထမအကြိမ် အသုံးပြုရာတွင်
  လမ်းညွှန်ချက်များကို သင့်ရဲ့ ပုံမှန် စကားပြောဆိုမှုများမှ ခွဲထားနိုင်စေပါသည်။ ပထမဆုံး agent chạy ချိန်တွင်
  Gateway ဟို့စ် ပေါ်တွင် ဖြစ်ပေါ်သည့် အရာများအတွက် [Bootstrapping](/start/bootstrapping) ကို ကြည့်ပါ။
</Step>
</Steps>
