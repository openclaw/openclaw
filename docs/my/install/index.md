---
summary: "OpenClaw ကို ထည့်သွင်းတပ်ဆင်ရန် — installer script၊ npm/pnpm၊ source မှ၊ Docker နှင့် အခြားနည်းလမ်းများ"
read_when:
  - Getting Started အမြန်စတင်ခြင်းမှလွဲပြီး အခြား ထည့်သွင်းနည်းလမ်းတစ်ခုလိုအပ်ပါက
  - cloud platform တစ်ခုပေါ်သို့ deploy လုပ်လိုပါက
  - အပ်ဒိတ်လုပ်ရန်၊ မိုင်ဂရိတ်လုပ်ရန် သို့မဟုတ် ဖယ်ရှားရန် လိုအပ်ပါက
title: "ထည့်သွင်းတပ်ဆင်ခြင်း"
---

# ထည့်သွင်းတပ်ဆင်ခြင်း

[Getting Started](/start/getting-started) ကို အရင်က လိုက်နာပြီးပါပြီလား။ အားလုံး အဆင်သင့်ပါပြီ — ဤစာမျက်နှာသည် alternative install methods, platform-specific လမ်းညွှန်ချက်များနှင့် maintenance အတွက် ဖြစ်ပါသည်။

## စနစ်လိုအပ်ချက်များ

- **[Node 22+](/install/node)** (မရှိပါက [installer script](#install-methods) က ထည့်သွင်းပေးပါမယ်)
- macOS၊ Linux၊ သို့မဟုတ် Windows
- source မှ build လုပ်ပါကသာ `pnpm` လိုအပ်သည်

<Note>
Windows တွင် OpenClaw ကို [WSL2](https://learn.microsoft.com/en-us/windows/wsl/install) အောက်တွင် လည်ပတ်စေရန် အထူးအကြံပြုပါသည်။
</Note>

## ထည့်သွင်းနည်းလမ်းများ

<Tip>
**installer script** က OpenClaw ကို ထည့်သွင်းရန် အကြံပြုထားတဲ့ နည်းလမ်း ဖြစ်ပါတယ်။ Node ကို ရှာဖွေခြင်း၊ install လုပ်ခြင်းနှင့် onboarding ကို အဆင့်တစ်ဆင့်တည်းဖြင့် ကိုင်တွယ်ပါသည်။
</Tip>

<AccordionGroup>
  <Accordion title="Installer script" icon="rocket" defaultOpen>
    CLI ကို ဒေါင်းလုဒ်လုပ်ပြီး npm ဖြင့် global အဖြစ် ထည့်သွင်းကာ onboarding wizard ကို စတင်ပါသည်။

    ```
    <Tabs>
      <Tab title="macOS / Linux / WSL2">
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

    ဒါပါပဲ — script က Node ကို ရှာဖွေခြင်း၊ ထည့်သွင်းခြင်းနှင့် onboarding ကို ကိုင်တွယ်ပေးပါသည်။

    onboarding ကို ကျော်ပြီး binary ကိုသာ ထည့်သွင်းလိုပါက —

    <Tabs>
      <Tab title="macOS / Linux / WSL2">
        ```bash
        curl -fsSL https://openclaw.ai/install.sh | bash -s -- --no-onboard
        ```
      </Tab>
      <Tab title="Windows (PowerShell)">
        ```powershell
        & ([scriptblock]::Create((iwr -useb https://openclaw.ai/install.ps1))) -NoOnboard
        ```
      </Tab>
    </Tabs>

    flag များ၊ env vars များနှင့် CI/automation ရွေးချယ်စရာများအားလုံးအတွက် [Installer internals](/install/installer) ကို ကြည့်ပါ။
    ```

  </Accordion>

  <Accordion title="npm / pnpm" icon="package">
    Node 22+ ရှိပြီးသားဖြစ်ကာ ထည့်သွင်းခြင်းကို ကိုယ်တိုင် စီမံချင်ပါက —

    ```
    <Tabs>
      <Tab title="npm">
        ```bash
        npm install -g openclaw@latest
        openclaw onboard --install-daemon
        ```

        <Accordion title="sharp build errors?">
          libvips ကို global အဖြစ် ထည့်သွင်းထားပါက (macOS တွင် Homebrew မှတစ်ဆင့် သာမန်အားဖြင့် ဖြစ်တတ်သည်) နှင့် `sharp` မအောင်မြင်ပါက prebuilt binaries ကို အတင်းအသုံးပြုပါ —

          ```bash
          SHARP_IGNORE_GLOBAL_LIBVIPS=1 npm install -g openclaw@latest
          ```

          `sharp: Please add node-gyp to your dependencies` ကို တွေ့ရပါက build tooling ကို ထည့်သွင်းပါ (macOS: Xcode CLT + `npm install -g node-gyp`) သို့မဟုတ် အထက်ပါ env var ကို အသုံးပြုပါ။
        </Accordion>
      </Tab>
      <Tab title="pnpm">
        ```bash
        pnpm add -g openclaw@latest
        pnpm approve-builds -g        # approve openclaw, node-llama-cpp, sharp, etc.
        openclaw onboard --install-daemon
        ```

        <Note>
        pnpm သည် build scripts ပါသော packages များအတွက် အတည်ပြုချက်ကို ထင်ရှားစွာ လိုအပ်ပါသည်။ ပထမဆုံး install အပြီး “Ignored build scripts” သတိပေးချက် ပြပါက `pnpm approve-builds -g` ကို လည်ပတ်ပြီး ဖော်ပြထားသော packages များကို ရွေးချယ်ပါ။
        </Note>
      </Tab>
    </Tabs>
    ```

  </Accordion>

  <Accordion title="From source" icon="github">
    ပါဝင်ကူညီသူများ သို့မဟုတ် local checkout မှ လည်ပတ်လိုသူများအတွက် ဖြစ်ပါသည်။

    ```
    <Steps>
      <Step title="Clone and build">
        [OpenClaw repo](https://github.com/openclaw/openclaw) ကို clone လုပ်ပြီး build လုပ်ပါ —

        ```bash
        git clone https://github.com/openclaw/openclaw.git
        cd openclaw
        pnpm install
        pnpm ui:build
        pnpm build
        ```
      </Step>
      <Step title="Link the CLI">
        `openclaw` အမိန့်ကို global အဖြစ် အသုံးပြုနိုင်စေရန် —

        ```bash
        pnpm link --global
        ```

        သို့မဟုတ် link မလုပ်ဘဲ repo အတွင်းမှ `pnpm openclaw ...` ဖြင့် အမိန့်များကို လည်ပတ်နိုင်ပါသည်။
      </Step>
      <Step title="Run onboarding">
        ```bash
        openclaw onboard --install-daemon
        ```
      </Step>
    </Steps>

    ပိုမိုနက်ရှိုင်းသော development workflow များအတွက် [Setup](/start/setup) ကို ကြည့်ပါ။
    ```

  </Accordion>
</AccordionGroup>

## အခြား ထည့်သွင်းနည်းလမ်းများ

<CardGroup cols={2}>
  <Card title="Docker" href="/install/docker" icon="container">
    Containerized သို့မဟုတ် headless deployments များ။
  </Card>
  <Card title="Nix" href="/install/nix" icon="snowflake">
    Nix ဖြင့် declarative ထည့်သွင်းခြင်း။
  </Card>
  <Card title="Ansible" href="/install/ansible" icon="server">
    Fleet ကို အလိုအလျောက် provision လုပ်ခြင်း။
  </Card>
  <Card title="Bun" href="/install/bun" icon="zap">
    Bun runtime ဖြင့် CLI-only အသုံးပြုခြင်း။
  </Card>
</CardGroup>

## ထည့်သွင်းပြီးနောက်

အားလုံး အလုပ်လုပ်နေကြောင်း စစ်ဆေးပါ —

```bash
openclaw doctor         # check for config issues
openclaw status         # gateway status
openclaw dashboard      # open the browser UI
```

14. custom runtime path များ လိုအပ်ပါက အောက်ပါအတိုင်း အသုံးပြုပါ:

- 15. home-directory အခြေပြု အတွင်းပိုင်း path များအတွက် `OPENCLAW_HOME`
- 16. mutable state တည်နေရာအတွက် `OPENCLAW_STATE_DIR`
- 17. config ဖိုင်တည်နေရာအတွက် `OPENCLAW_CONFIG_PATH`

18. precedence နှင့် အသေးစိတ် အချက်အလက်များအတွက် [Environment vars](/help/environment) ကို ကြည့်ပါ။

## ပြဿနာဖြေရှင်းခြင်း: `openclaw` မတွေ့ပါ

<Accordion title="PATH diagnosis and fix">
  အမြန်စစ်ဆေးခြင်း —

```bash
node -v
npm -v
npm prefix -g
echo "$PATH"
```

`$(npm prefix -g)/bin` (macOS/Linux) သို့မဟုတ် `$(npm prefix -g)` (Windows) သည် သင့် `$PATH` ထဲတွင် **မရှိပါက** သင့် shell က global npm binaries ( `openclaw` အပါအဝင်) ကို မရှာတွေ့နိုင်ပါ။

ဖြေရှင်းရန် — သင့် shell startup file (`~/.zshrc` သို့မဟုတ် `~/.bashrc`) ထဲသို့ ထည့်ပါ —

```bash
export PATH="$(npm prefix -g)/bin:$PATH"
```

Windows တွင် `npm prefix -g` ၏ output ကို PATH ထဲသို့ ထည့်ပါ။

ထို့နောက် terminal အသစ်တစ်ခုကို ဖွင့်ပါ (သို့မဟုတ် zsh တွင် `rehash` / bash တွင် `hash -r`)။ </Accordion>

## အပ်ဒိတ် / ဖယ်ရှားခြင်း

<CardGroup cols={3}>
  <Card title="Updating" href="/install/updating" icon="refresh-cw">
    OpenClaw ကို နောက်ဆုံးအခြေအနေအထိ ထိန်းသိမ်းပါ။
  </Card>
  <Card title="Migrating" href="/install/migrating" icon="arrow-right">
    စက်အသစ်သို့ ပြောင်းရွှေ့ပါ။
  </Card>
  <Card title="Uninstall" href="/install/uninstall" icon="trash-2">
    OpenClaw ကို လုံးဝ ဖယ်ရှားပါ။
  </Card>
</CardGroup>
