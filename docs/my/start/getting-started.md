---
summary: "OpenClaw ကို ထည့်သွင်းပြီး မိနစ်အနည်းငယ်အတွင်း သင့်ပထမဆုံး ချတ်ကို လည်ပတ်စေပါ။"
read_when:
  - ပထမဆုံးအကြိမ် သုညမှ စတင်တပ်ဆင်နေချိန်
  - အလုပ်လုပ်နိုင်သော ချတ်တစ်ခုသို့ အမြန်ဆုံး ရောက်လိုချင်သောအခါ
title: "စတင်အသုံးပြုရန်"
x-i18n:
  source_path: start/getting-started.md
  source_hash: 6eeb4d38a70f2ad9
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:55:02Z
---

# စတင်အသုံးပြုရန်

ရည်မှန်းချက် — တပ်ဆင်မှု အနည်းဆုံးဖြင့် သုညမှ စတင်ကာ ပထမဆုံး အလုပ်လုပ်နိုင်သော ချတ်တစ်ခုအထိ ရောက်ရှိရန်။

<Info>
အမြန်ဆုံး ချတ် — Control UI ကို ဖွင့်ပါ (ချန်နယ် တပ်ဆင်ရန် မလိုအပ်ပါ)။ `openclaw dashboard` ကို လုပ်ဆောင်ပြီး
ဘရောက်ဇာထဲ에서 ချတ်လုပ်နိုင်သည်၊ သို့မဟုတ် `http://127.0.0.1:18789/` ကို
<Tooltip headline="Gateway host" tip="The machine running the OpenClaw gateway service.">Gateway ဟို့စ်</Tooltip> ပေါ်တွင် ဖွင့်ပါ။
စာရွက်စာတမ်းများ — [Dashboard](/web/dashboard) နှင့် [Control UI](/web/control-ui)။
</Info>

## ကြိုတင်လိုအပ်ချက်များ

- Node 22 သို့မဟုတ် ပိုမိုအသစ်

<Tip>
မသေချာပါက `node --version` ဖြင့် သင့် Node ဗားရှင်းကို စစ်ဆေးပါ။
</Tip>

## အမြန်တပ်ဆင်ခြင်း (CLI)

<Steps>
  <Step title="OpenClaw ကို ထည့်သွင်းပါ (အကြံပြု)">
    <Tabs>
      <Tab title="macOS/Linux">
        ```bash
        curl -fsSL https://openclaw.ai/install.sh | bash
        ```
      </Tab>
      <Tab title="Windows (PowerShell)">
        ```powershell
        iwr -useb https://openclaw.ai/install.ps1 | iex
        ```
      </Tab>
    </Tabs>

    <Note>
    အခြား ထည့်သွင်းနည်းများနှင့် လိုအပ်ချက်များ — [Install](/install)။
    </Note>

  </Step>
  <Step title="onboarding wizard ကို လည်ပတ်ပါ">
    ```bash
    openclaw onboard --install-daemon
    ```

    wizard သည် auth၊ Gateway ဆိုင်ရာ ဆက်တင်များနှင့် ရွေးချယ်နိုင်သော ချန်နယ်များကို ဖွဲ့စည်းပြင်ဆင်ပေးပါသည်။
    အသေးစိတ်အတွက် [Onboarding Wizard](/start/wizard) ကို ကြည့်ပါ။

  </Step>
  <Step title="Gateway ကို စစ်ဆေးပါ">
    ဝန်ဆောင်မှုကို ထည့်သွင်းထားပါက ယခုအချိန်တွင် လည်ပတ်နေပြီးသား ဖြစ်သင့်ပါသည် —

    ```bash
    openclaw gateway status
    ```

  </Step>
  <Step title="Control UI ကို ဖွင့်ပါ">
    ```bash
    openclaw dashboard
    ```
  </Step>
</Steps>

<Check>
Control UI ကို ဖွင့်လို့ရပါက သင့် Gateway（ဂိတ်ဝေး）သည် အသုံးပြုရန် အဆင်သင့် ဖြစ်ပါသည်။
</Check>

## ရွေးချယ်နိုင်သော စစ်ဆေးမှုများနှင့် အပိုများ

<AccordionGroup>
  <Accordion title="Gateway ကို foreground တွင် လည်ပတ်ပါ">
    အမြန်စမ်းသပ်မှုများ သို့မဟုတ် ပြဿနာရှာဖွေရန် အထောက်အကူဖြစ်သည်။

    ```bash
    openclaw gateway --port 18789
    ```

  </Accordion>
  <Accordion title="စမ်းသပ် မက်ဆေ့ချ် တစ်စောင် ပို့ပါ">
    ချန်နယ်တစ်ခုကို ဖွဲ့စည်းပြင်ဆင်ထားရန် လိုအပ်သည်။

    ```bash
    openclaw message send --target +15555550123 --message "Hello from OpenClaw"
    ```

  </Accordion>
</AccordionGroup>

## ပိုမိုလေ့လာရန်

<Columns>
  <Card title="Onboarding Wizard (အသေးစိတ်)" href="/start/wizard">
    CLI wizard အပြည့်အစုံ ရည်ညွှန်းချက်နှင့် အဆင့်မြင့် ရွေးချယ်မှုများ။
  </Card>
  <Card title="macOS အက်ပ် onboarding" href="/start/onboarding">
    macOS အက်ပ်အတွက် ပထမဆုံး လည်ပတ်မှု လုပ်ငန်းစဉ်။
  </Card>
</Columns>

## သင်ရရှိမည့်အရာများ

- လည်ပတ်နေသော Gateway（ဂိတ်ဝေး） တစ်ခု
- Auth ကို ဖွဲ့စည်းပြင်ဆင်ပြီးသား
- Control UI သို့ ဝင်ရောက်နိုင်မှု သို့မဟုတ် ချိတ်ဆက်ထားသော ချန်နယ်တစ်ခု

## နောက်တစ်ဆင့်များ

- DM လုံခြုံရေးနှင့် အတည်ပြုချက်များ — [Pairing](/channels/pairing)
- ချန်နယ်များ ထပ်မံ ချိတ်ဆက်ရန် — [Channels](/channels)
- အဆင့်မြင့် လုပ်ငန်းစဉ်များနှင့် source မှ တည်ဆောက်ခြင်း — [Setup](/start/setup)
