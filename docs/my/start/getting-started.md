---
summary: "OpenClaw ကို ထည့်သွင်းပြီး မိနစ်အနည်းငယ်အတွင်း သင့်ပထမဆုံး ချတ်ကို လည်ပတ်စေပါ။"
read_when:
  - ပထမဆုံးအကြိမ် သုညမှ စတင်တပ်ဆင်နေချိန်
  - အလုပ်လုပ်နိုင်သော ချတ်တစ်ခုသို့ အမြန်ဆုံး ရောက်လိုချင်သောအခါ
title: "စတင်အသုံးပြုရန်"
---

# စတင်အသုံးပြုရန်

ရည်မှန်းချက် — တပ်ဆင်မှု အနည်းဆုံးဖြင့် သုညမှ စတင်ကာ ပထမဆုံး အလုပ်လုပ်နိုင်သော ချတ်တစ်ခုအထိ ရောက်ရှိရန်။

<Info>
Fastest chat: open the Control UI (no channel setup needed). Run `openclaw dashboard`
and chat in the browser, or open `http://127.0.0.1:18789/` on the
<Tooltip headline="Gateway host" tip="The machine running the OpenClaw gateway service.">Gateway ဟို့စ်</Tooltip>.
Docs: [Dashboard](/web/dashboard) and [Control UI](/web/control-ui).
</Info>

## ကြိုတင်လိုအပ်ချက်များ

- Node 22 သို့မဟုတ် ပိုမိုအသစ်

<Tip>
မသေချာပါက `node --version` ဖြင့် သင့် Node ဗားရှင်းကို စစ်ဆေးပါ။
</Tip>

## အမြန်တပ်ဆင်ခြင်း (CLI)

<Steps>
  <Step title="Install OpenClaw (recommended)">
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

    ```
    <Note>
    အခြား ထည့်သွင်းနည်းများနှင့် လိုအပ်ချက်များ — [Install](/install)။
    </Note>
    ```

  </Step>
  <Step title="Run the onboarding wizard">
    ```bash
    openclaw onboard --install-daemon
    ```

    ```
    wizard သည် auth၊ Gateway ဆိုင်ရာ ဆက်တင်များနှင့် ရွေးချယ်နိုင်သော ချန်နယ်များကို ဖွဲ့စည်းပြင်ဆင်ပေးပါသည်။
    အသေးစိတ်အတွက် [Onboarding Wizard](/start/wizard) ကို ကြည့်ပါ။
    ```

  </Step>
  <Step title="Check the Gateway">
    ဝန်ဆောင်မှုကို ထည့်သွင်းထားပါက ယခုအချိန်တွင် လည်ပတ်နေပြီးသား ဖြစ်သင့်ပါသည် —

    ````
    ```bash
    openclaw gateway status
    ```
    ````

  </Step>
  <Step title="Open the Control UI">
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
  <Accordion title="Run the Gateway in the foreground">
    အမြန်စမ်းသပ်မှုများ သို့မဟုတ် ပြဿနာရှာဖွေရန် အထောက်အကူဖြစ်သည်။

    ````
    ```bash
    openclaw gateway --port 18789
    ```
    ````

  </Accordion>
  <Accordion title="Send a test message">
    ချန်နယ်တစ်ခုကို ဖွဲ့စည်းပြင်ဆင်ထားရန် လိုအပ်သည်။

    ````
    ```bash
    openclaw message send --target +15555550123 --message "Hello from OpenClaw"
    ```
    ````

  </Accordion>
</AccordionGroup>

## 33. အသုံးဝင်သော environment variable များ

34. OpenClaw ကို service account အဖြစ် အသုံးပြုနေပါက သို့မဟုတ် စိတ်ကြိုက် config/state တည်နေရာများ လိုအပ်ပါက:

- 35. `OPENCLAW_HOME` သည် အတွင်းပိုင်း လမ်းကြောင်း ဖြေရှင်းမှုအတွက် အသုံးပြုသော home directory ကို သတ်မှတ်ပေးသည်။
- 36. `OPENCLAW_STATE_DIR` သည် state directory ကို အစားထိုး သတ်မှတ်ပေးသည်။
- 37. `OPENCLAW_CONFIG_PATH` သည် config ဖိုင် လမ်းကြောင်းကို အစားထိုး သတ်မှတ်ပေးသည်။

38. Environment variable အပြည့်အစုံကို ကိုးကားရန်: [Environment vars](/help/environment).

## ပိုမိုလေ့လာရန်

<Columns>
  <Card title="Onboarding Wizard (details)" href="/start/wizard">
    CLI wizard အပြည့်အစုံ ရည်ညွှန်းချက်နှင့် အဆင့်မြင့် ရွေးချယ်မှုများ။
  </Card>
  <Card title="macOS app onboarding" href="/start/onboarding">
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
