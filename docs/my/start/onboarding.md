---
summary: "OpenClaw (macOS အက်ပ်) အတွက် ပထမအကြိမ် စတင်အသုံးပြုရာတွင် လမ်းညွှန်သည့် onboarding လုပ်ငန်းစဉ်"
read_when:
  - macOS onboarding assistant ကို ဒီဇိုင်းဆွဲနေချိန်
  - auth သို့မဟုတ် identity setup ကို အကောင်အထည်ဖော်နေချိန်
title: "Onboarding (macOS အက်ပ်)"
sidebarTitle: "Onboarding: macOS App"
---

# Onboarding (macOS အက်ပ်)

ဒီစာရွက်စာတမ်းက **လက်ရှိ** ပထမအကြိမ် run လုပ်တဲ့ onboarding flow ကို ဖော်ပြထားသည်။ ရည်ရွယ်ချက်က ချောမွေ့တဲ့ “day 0” အတွေ့အကြုံတစ်ခု ဖြစ်စေရန်ပါ — Gateway ကို ဘယ်မှာ chạy မလဲ ရွေးချယ်၊ auth ချိတ်ဆက်၊ wizard ကို chạy၊ ပြီးရင် agent ကို ကိုယ်တိုင် bootstrap လုပ်ခိုင်းပါ။

<Steps>
<Step title="Approve macOS warning">
<Frame>
<img src="/assets/macos-onboarding/01-macos-warning.jpeg" alt="" />
</Frame>
</Step>
<Step title="Approve find local networks">
<Frame>
<img src="/assets/macos-onboarding/02-local-networks.jpeg" alt="" />
</Frame>
</Step>
<Step title="Welcome and security notice">
<Frame caption="ပြသထားသော လုံခြုံရေး သတိပေးချက်ကို ဖတ်ရှုပြီး သင့်အနေဖြင့် ဆုံးဖြတ်ပါ">
<img src="/assets/macos-onboarding/03-security-notice.png" alt="" />
</Frame>
</Step>
<Step title="Local vs Remote">
<Frame>
<img src="/assets/macos-onboarding/04-choose-gateway.png" alt="" />
</Frame>

**Gateway** ကို မည်သည့်နေရာတွင် chạy မည်နည်း။

- **This Mac (Local only):** onboarding သည် OAuth လုပ်ငန်းစဉ်များကို chạy နိုင်ပြီး credentials များကို local တွင် ရေးသားနိုင်သည်။
- **Remote (over SSH/Tailnet):** onboarding သည် OAuth ကို local တွင် **မ** chạy ပါ။ credentials များသည် Gateway ဟို့စ် ပေါ်တွင် ရှိပြီးသား ဖြစ်ရမည်။
- **Configure later:** setup ကို ကျော်သွားပြီး အက်ပ်ကို မဖွဲ့စည်းထားဘဲ ထားပါ။

<Tip>
**Gateway auth အကြံပြုချက်:**
- wizard က loopback အတွက်တောင် **token** ကို ယခု generate လုပ်ပေးထားတဲ့အတွက် local WS client များအနေနဲ့ authenticate လုပ်ရပါမယ်။
- auth ကို ပိတ်ထားရင် local process မည်သည့်အရာမဆို ချိတ်ဆက်နိုင်ပါလိမ့်မယ်; ယုံကြည်စိတ်ချရသော စက်များပေါ်မှာသာ သုံးပါ။
</Tip>
</Step>
<Step title="Permissions">
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
<Step title="Onboarding Chat (dedicated session)">
  - စက်များစွာအသုံးပြုခြင်း သို့မဟုတ် loopback မဟုတ်တဲ့ bind များအတွက် **token** ကို သုံးပါ။ setup ပြီးနောက် app က agent ကို ကိုယ်တိုင် မိတ်ဆက်ပြီး နောက်ထပ် အဆင့်များကို လမ်းညွှန်နိုင်အောင် သီးသန့် onboarding chat session တစ်ခု ဖွင့်ပေးပါသည်။ ဒါကြောင့် ပထမအကြိမ် လမ်းညွှန်မှုကို သင်ရဲ့ ပုံမှန် စကားဝိုင်းနဲ့ ခွဲထားနိုင်ပါသည်။
</Step>
</Steps>
