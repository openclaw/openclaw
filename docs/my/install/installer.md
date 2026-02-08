---
summary: "installer စခရစ်များ (install.sh, install-cli.sh, install.ps1) အလုပ်လုပ်ပုံ၊ flags နှင့် automation ကို ရှင်းလင်းဖော်ပြထားသည်"
read_when:
  - `openclaw.ai/install.sh` ကို နားလည်လိုသောအခါ
  - installs များကို အလိုအလျောက်လုပ်ဆောင်လိုသောအခါ (CI / headless)
  - GitHub checkout မှ ထည့်သွင်းတပ်ဆင်လိုသောအခါ
title: "Installer အတွင်းပိုင်းလုပ်ဆောင်ပုံ"
x-i18n:
  source_path: install/installer.md
  source_hash: 8517f9cf8e237b62
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:54:59Z
---

# Installer အတွင်းပိုင်းလုပ်ဆောင်ပုံ

OpenClaw တွင် installer စခရစ် သုံးခု ပါဝင်ပြီး `openclaw.ai` မှ ပံ့ပိုးပေးထားပါသည်။

| Script                             | Platform             | လုပ်ဆောင်ပုံ                                                                                                              |
| ---------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| [`install.sh`](#installsh)         | macOS / Linux / WSL  | လိုအပ်ပါက Node ကို ထည့်သွင်းပြီး npm (မူလ) သို့မဟုတ် git ဖြင့် OpenClaw ကို ထည့်သွင်းကာ onboarding ကို လုပ်ဆောင်နိုင်သည်။ |
| [`install-cli.sh`](#install-clish) | macOS / Linux / WSL  | Node + OpenClaw ကို local prefix (`~/.openclaw`) အောက်တွင် ထည့်သွင်းသည်။ root မလိုအပ်ပါ။                                  |
| [`install.ps1`](#installps1)       | Windows (PowerShell) | လိုအပ်ပါက Node ကို ထည့်သွင်းပြီး npm (မူလ) သို့မဟုတ် git ဖြင့် OpenClaw ကို ထည့်သွင်းကာ onboarding ကို လုပ်ဆောင်နိုင်သည်။ |

## Quick commands

<Tabs>
  <Tab title="install.sh">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash
    ```

    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash -s -- --help
    ```

  </Tab>
  <Tab title="install-cli.sh">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install-cli.sh | bash
    ```

    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install-cli.sh | bash -s -- --help
    ```

  </Tab>
  <Tab title="install.ps1">
    ```powershell
    iwr -useb https://openclaw.ai/install.ps1 | iex
    ```

    ```powershell
    & ([scriptblock]::Create((iwr -useb https://openclaw.ai/install.ps1))) -Tag beta -NoOnboard -DryRun
    ```

  </Tab>
</Tabs>

<Note>
install အောင်မြင်ပြီးသော်လည်း terminal အသစ်တွင် `openclaw` မတွေ့ပါက [Node.js troubleshooting](/install/node#troubleshooting) ကို ကြည့်ပါ။
</Note>

---

## install.sh

<Tip>
macOS/Linux/WSL တွင် အပြန်အလှန်အသုံးပြုသော install များအတွက် အများအားဖြင့် အကြံပြုပါသည်။
</Tip>

### Flow (install.sh)

<Steps>
  <Step title="OS ကို စစ်ဆေးခြင်း">
    macOS နှင့် Linux (WSL အပါအဝင်) ကို ပံ့ပိုးသည်။ macOS ဖြစ်ပါက မရှိသေးလျှင် Homebrew ကို ထည့်သွင်းသည်။
  </Step>
  <Step title="Node.js 22+ ကို သေချာစေရန်">
    Node ဗားရှင်းကို စစ်ဆေးပြီး လိုအပ်ပါက Node 22 ကို ထည့်သွင်းသည် (macOS တွင် Homebrew၊ Linux apt/dnf/yum တွင် NodeSource setup scripts)။
  </Step>
  <Step title="Git ကို သေချာစေရန်">
    Git မရှိပါက ထည့်သွင်းသည်။
  </Step>
  <Step title="OpenClaw ကို ထည့်သွင်းခြင်း">
    - `npm` နည်းလမ်း (မူလ): global npm install
    - `git` နည်းလမ်း: repo ကို clone/update လုပ်ပြီး pnpm ဖြင့် deps ကို ထည့်သွင်း၊ build လုပ်ကာ `~/.local/bin/openclaw` တွင် wrapper ကို ထည့်သွင်းသည်
  </Step>
  <Step title="Post-install လုပ်ဆောင်ချက်များ">
    - upgrade နှင့် git install များတွင် `openclaw doctor --non-interactive` ကို run လုပ်သည် (အတတ်နိုင်ဆုံး)
    - သင့်လျော်သည့်အခါ onboarding ကို ကြိုးပမ်းလုပ်ဆောင်သည် (TTY ရှိ၊ onboarding မပိတ်ထား၊ bootstrap/config စစ်ဆေးချက်များ အောင်မြင်)
    - မူလအဖြစ် `SHARP_IGNORE_GLOBAL_LIBVIPS=1`
  </Step>
</Steps>

### Source checkout ကို သိရှိခြင်း

OpenClaw checkout (`package.json` + `pnpm-workspace.yaml`) အတွင်းတွင် run လုပ်ပါက စခရစ်သည် အောက်ပါရွေးချယ်မှုများကို ပေးသည်—

- checkout ကို အသုံးပြုခြင်း (`git`), သို့မဟုတ်
- global install ကို အသုံးပြုခြင်း (`npm`)

TTY မရှိဘဲ install နည်းလမ်းကို မသတ်မှတ်ထားပါက `npm` ကို မူလအဖြစ် သတ်မှတ်ပြီး သတိပေးချက် ထုတ်ပေးသည်။

နည်းလမ်းရွေးချယ်မှု မမှန်ကန်ခြင်း သို့မဟုတ် `--install-method` တန်ဖိုးများ မမှန်ကန်ပါက စခရစ်သည် exit code `2` ဖြင့် အဆုံးသတ်သည်။

### Examples (install.sh)

<Tabs>
  <Tab title="Default">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash
    ```
  </Tab>
  <Tab title="Skip onboarding">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash -s -- --no-onboard
    ```
  </Tab>
  <Tab title="Git install">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash -s -- --install-method git
    ```
  </Tab>
  <Tab title="Dry run">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash -s -- --dry-run
    ```
  </Tab>
</Tabs>

<AccordionGroup>
  <Accordion title="Flags reference">

| Flag                            | ဖော်ပြချက်                                                                         |
| ------------------------------- | ---------------------------------------------------------------------------------- |
| `--install-method npm\|git`     | install နည်းလမ်းကို ရွေးချယ်ခြင်း (မူလ: `npm`)။ Alias: `--method`                  |
| `--npm`                         | npm နည်းလမ်းအတွက် shortcut                                                         |
| `--git`                         | git နည်းလမ်းအတွက် shortcut။ Alias: `--github`                                      |
| `--version <version\|dist-tag>` | npm ဗားရှင်း သို့မဟုတ် dist-tag (မူလ: `latest`)                                    |
| `--beta`                        | ရရှိနိုင်ပါက beta dist-tag ကို အသုံးပြုပြီး မရှိပါက `latest` သို့ ပြန်လည် fallback |
| `--git-dir <path>`              | Checkout directory (မူလ: `~/openclaw`)။ Alias: `--dir`                             |
| `--no-git-update`               | ရှိပြီးသား checkout အတွက် `git pull` ကို ကျော်လွှားရန်                             |
| `--no-prompt`                   | prompts များကို ပိတ်ရန်                                                            |
| `--no-onboard`                  | onboarding ကို ကျော်လွှားရန်                                                       |
| `--onboard`                     | onboarding ကို ဖွင့်ရန်                                                            |
| `--dry-run`                     | ပြောင်းလဲမှု မပြုလုပ်ဘဲ လုပ်ဆောင်ချက်များကိုသာ ပြရန်                               |
| `--verbose`                     | debug output ကို ဖွင့်ရန် (`set -x`, npm notice-level logs)                        |
| `--help`                        | အသုံးပြုပုံကို ပြရန် (`-h`)                                                        |

  </Accordion>

  <Accordion title="Environment variables reference">

| Variable                                    | ဖော်ပြချက်                                             |
| ------------------------------------------- | ------------------------------------------------------ |
| `OPENCLAW_INSTALL_METHOD=git\|npm`          | install နည်းလမ်း                                       |
| `OPENCLAW_VERSION=latest\|next\|<semver>`   | npm ဗားရှင်း သို့မဟုတ် dist-tag                        |
| `OPENCLAW_BETA=0\|1`                        | ရရှိနိုင်ပါက beta ကို အသုံးပြုရန်                      |
| `OPENCLAW_GIT_DIR=<path>`                   | Checkout directory                                     |
| `OPENCLAW_GIT_UPDATE=0\|1`                  | git updates ကို ဖွင့်/ပိတ်                             |
| `OPENCLAW_NO_PROMPT=1`                      | prompts များကို ပိတ်ရန်                                |
| `OPENCLAW_NO_ONBOARD=1`                     | onboarding ကို ကျော်လွှားရန်                           |
| `OPENCLAW_DRY_RUN=1`                        | Dry run mode                                           |
| `OPENCLAW_VERBOSE=1`                        | Debug mode                                             |
| `OPENCLAW_NPM_LOGLEVEL=error\|warn\|notice` | npm log level                                          |
| `SHARP_IGNORE_GLOBAL_LIBVIPS=0\|1`          | sharp/libvips လုပ်ဆောင်ပုံကို ထိန်းချုပ်ရန် (မူလ: `1`) |

  </Accordion>
</AccordionGroup>

---

## install-cli.sh

<Info>
အရာအားလုံးကို local prefix (မူလ `~/.openclaw`) အောက်တွင်ထားပြီး system Node အပေါ် မမူတည်လိုသည့် ပတ်ဝန်းကျင်များအတွက် ဒီဇိုင်းပြုလုပ်ထားပါသည်။
</Info>

### Flow (install-cli.sh)

<Steps>
  <Step title="local Node runtime ကို ထည့်သွင်းခြင်း">
    Node tarball (မူလ `22.22.0`) ကို `<prefix>/tools/node-v<version>` သို့ download လုပ်ပြီး SHA-256 ကို အတည်ပြုစစ်ဆေးသည်။
  </Step>
  <Step title="Git ကို သေချာစေရန်">
    Git မရှိပါက Linux တွင် apt/dnf/yum သို့မဟုတ် macOS တွင် Homebrew ဖြင့် ထည့်သွင်းရန် ကြိုးပမ်းသည်။
  </Step>
  <Step title="prefix အောက်တွင် OpenClaw ကို ထည့်သွင်းခြင်း">
    `--prefix <prefix>` ကို အသုံးပြုပြီး npm ဖြင့် ထည့်သွင်းကာ `<prefix>/bin/openclaw` သို့ wrapper ကို ရေးထည့်သည်။
  </Step>
</Steps>

### Examples (install-cli.sh)

<Tabs>
  <Tab title="Default">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install-cli.sh | bash
    ```
  </Tab>
  <Tab title="Custom prefix + version">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install-cli.sh | bash -s -- --prefix /opt/openclaw --version latest
    ```
  </Tab>
  <Tab title="Automation JSON output">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install-cli.sh | bash -s -- --json --prefix /opt/openclaw
    ```
  </Tab>
  <Tab title="Run onboarding">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install-cli.sh | bash -s -- --onboard
    ```
  </Tab>
</Tabs>

<AccordionGroup>
  <Accordion title="Flags reference">

| Flag                   | ဖော်ပြချက်                                                                                          |
| ---------------------- | --------------------------------------------------------------------------------------------------- |
| `--prefix <path>`      | Install prefix (မူလ: `~/.openclaw`)                                                                 |
| `--version <ver>`      | OpenClaw ဗားရှင်း သို့မဟုတ် dist-tag (မူလ: `latest`)                                                |
| `--node-version <ver>` | Node ဗားရှင်း (မူလ: `22.22.0`)                                                                      |
| `--json`               | NDJSON events ကို ထုတ်ပေးရန်                                                                        |
| `--onboard`            | install ပြီးနောက် `openclaw onboard` ကို run လုပ်ရန်                                                |
| `--no-onboard`         | onboarding ကို ကျော်လွှားရန် (မူလ)                                                                  |
| `--set-npm-prefix`     | Linux တွင် လက်ရှိ prefix ကို မရေးနိုင်ပါက npm prefix ကို `~/.npm-global` သို့ အတင်းအကျပ် ပြောင်းရန် |
| `--help`               | အသုံးပြုပုံကို ပြရန် (`-h`)                                                                         |

  </Accordion>

  <Accordion title="Environment variables reference">

| Variable                                    | ဖော်ပြချက်                                                                                      |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `OPENCLAW_PREFIX=<path>`                    | Install prefix                                                                                  |
| `OPENCLAW_VERSION=<ver>`                    | OpenClaw ဗားရှင်း သို့မဟုတ် dist-tag                                                            |
| `OPENCLAW_NODE_VERSION=<ver>`               | Node ဗားရှင်း                                                                                   |
| `OPENCLAW_NO_ONBOARD=1`                     | onboarding ကို ကျော်လွှားရန်                                                                    |
| `OPENCLAW_NPM_LOGLEVEL=error\|warn\|notice` | npm log level                                                                                   |
| `OPENCLAW_GIT_DIR=<path>`                   | Legacy cleanup lookup path (ဟောင်း `Peekaboo` submodule checkout ကို ဖယ်ရှားရာတွင် အသုံးပြုသည်) |
| `SHARP_IGNORE_GLOBAL_LIBVIPS=0\|1`          | sharp/libvips လုပ်ဆောင်ပုံကို ထိန်းချုပ်ရန် (မူလ: `1`)                                          |

  </Accordion>
</AccordionGroup>

---

## install.ps1

### Flow (install.ps1)

<Steps>
  <Step title="PowerShell + Windows ပတ်ဝန်းကျင်ကို သေချာစေရန်">
    PowerShell 5+ လိုအပ်သည်။
  </Step>
  <Step title="Node.js 22+ ကို သေချာစေရန်">
    မရှိပါက winget၊ ထို့နောက် Chocolatey၊ ထို့နောက် Scoop ဖြင့် ထည့်သွင်းရန် ကြိုးပမ်းသည်။
  </Step>
  <Step title="OpenClaw ကို ထည့်သွင်းခြင်း">
    - `npm` နည်းလမ်း (မူလ): ရွေးချယ်ထားသော `-Tag` ကို အသုံးပြုပြီး global npm install
    - `git` နည်းလမ်း: repo ကို clone/update လုပ်ပြီး pnpm ဖြင့် install/build လုပ်ကာ `%USERPROFILE%\.local\bin\openclaw.cmd` တွင် wrapper ကို ထည့်သွင်းသည်
  </Step>
  <Step title="Post-install လုပ်ဆောင်ချက်များ">
    ဖြစ်နိုင်ပါက လိုအပ်သော bin directory ကို user PATH ထဲသို့ ထည့်သွင်းပြီး upgrade နှင့် git install များတွင် `openclaw doctor --non-interactive` ကို run လုပ်သည် (အတတ်နိုင်ဆုံး)။
  </Step>
</Steps>

### Examples (install.ps1)

<Tabs>
  <Tab title="Default">
    ```powershell
    iwr -useb https://openclaw.ai/install.ps1 | iex
    ```
  </Tab>
  <Tab title="Git install">
    ```powershell
    & ([scriptblock]::Create((iwr -useb https://openclaw.ai/install.ps1))) -InstallMethod git
    ```
  </Tab>
  <Tab title="Custom git directory">
    ```powershell
    & ([scriptblock]::Create((iwr -useb https://openclaw.ai/install.ps1))) -InstallMethod git -GitDir "C:\openclaw"
    ```
  </Tab>
  <Tab title="Dry run">
    ```powershell
    & ([scriptblock]::Create((iwr -useb https://openclaw.ai/install.ps1))) -DryRun
    ```
  </Tab>
</Tabs>

<AccordionGroup>
  <Accordion title="Flags reference">

| Flag                      | ဖော်ပြချက်                                         |
| ------------------------- | -------------------------------------------------- |
| `-InstallMethod npm\|git` | install နည်းလမ်း (မူလ: `npm`)                      |
| `-Tag <tag>`              | npm dist-tag (မူလ: `latest`)                       |
| `-GitDir <path>`          | Checkout directory (မူလ: `%USERPROFILE%\openclaw`) |
| `-NoOnboard`              | onboarding ကို ကျော်လွှားရန်                       |
| `-NoGitUpdate`            | `git pull` ကို ကျော်လွှားရန်                       |
| `-DryRun`                 | လုပ်ဆောင်ချက်များကိုသာ ပြရန်                       |

  </Accordion>

  <Accordion title="Environment variables reference">

| Variable                           | ဖော်ပြချက်                   |
| ---------------------------------- | ---------------------------- |
| `OPENCLAW_INSTALL_METHOD=git\|npm` | install နည်းလမ်း             |
| `OPENCLAW_GIT_DIR=<path>`          | Checkout directory           |
| `OPENCLAW_NO_ONBOARD=1`            | onboarding ကို ကျော်လွှားရန် |
| `OPENCLAW_GIT_UPDATE=0`            | git pull ကို ပိတ်ရန်         |
| `OPENCLAW_DRY_RUN=1`               | Dry run mode                 |

  </Accordion>
</AccordionGroup>

<Note>
`-InstallMethod git` ကို အသုံးပြုထားပြီး Git မရှိပါက စခရစ်သည် အဆုံးသတ်ပြီး Git for Windows လင့်ခ်ကို ထုတ်ပြပါသည်။
</Note>

---

## CI နှင့် automation

ခန့်မှန်းနိုင်သော run များအတွက် non-interactive flags/env vars ကို အသုံးပြုပါ။

<Tabs>
  <Tab title="install.sh (non-interactive npm)">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash -s -- --no-prompt --no-onboard
    ```
  </Tab>
  <Tab title="install.sh (non-interactive git)">
    ```bash
    OPENCLAW_INSTALL_METHOD=git OPENCLAW_NO_PROMPT=1 \
      curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash
    ```
  </Tab>
  <Tab title="install-cli.sh (JSON)">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install-cli.sh | bash -s -- --json --prefix /opt/openclaw
    ```
  </Tab>
  <Tab title="install.ps1 (skip onboarding)">
    ```powershell
    & ([scriptblock]::Create((iwr -useb https://openclaw.ai/install.ps1))) -NoOnboard
    ```
  </Tab>
</Tabs>

---

## Troubleshooting

<AccordionGroup>
  <Accordion title="Git ကို ဘာကြောင့် လိုအပ်တာလဲ?">
    `git` install နည်းလမ်းအတွက် Git လိုအပ်ပါသည်။ `npm` install များအတွက်လည်း dependency များတွင် git URLs အသုံးပြုသည့်အခါ `spawn git ENOENT` မအောင်မြင်မှုများကို ရှောင်ရှားရန် Git ကို စစ်ဆေး/ထည့်သွင်းထားပါသည်။
  </Accordion>

  <Accordion title="Linux တွင် npm သည် EACCES ကို ဘာကြောင့် ထိတွေ့တာလဲ?">
    Linux setup အချို့တွင် npm global prefix ကို root ပိုင်ဆိုင်သော path များသို့ ညွှန်ပြထားတတ်သည်။ `install.sh` သည် prefix ကို `~/.npm-global` သို့ ပြောင်းလဲနိုင်ပြီး shell rc ဖိုင်များ ရှိပါက PATH exports ကို ထည့်သွင်းပေးနိုင်ပါသည်။
  </Accordion>

  <Accordion title="sharp/libvips ပြဿနာများ">
    scripts များသည် sharp ကို system libvips နှင့် မတည်ဆောက်ရန် `SHARP_IGNORE_GLOBAL_LIBVIPS=1` ကို မူလအဖြစ် သတ်မှတ်ထားပါသည်။ ပြောင်းလဲလိုပါက—

    ```bash
    SHARP_IGNORE_GLOBAL_LIBVIPS=0 curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash
    ```

  </Accordion>

  <Accordion title='Windows: "npm error spawn git / ENOENT"'>
    Git for Windows ကို ထည့်သွင်းပြီး PowerShell ကို ပြန်ဖွင့်ကာ installer ကို ထပ်မံ run လုပ်ပါ။
  </Accordion>

  <Accordion title='Windows: "openclaw is not recognized"'>
    `npm config get prefix` ကို run လုပ်ပြီး `\bin` ကို ပေါင်းထည့်ကာ ထို directory ကို user PATH ထဲသို့ ထည့်ပြီး PowerShell ကို ပြန်ဖွင့်ပါ။
  </Accordion>

  <Accordion title="install ပြီးနောက် openclaw မတွေ့ပါ">
    ပုံမှန်အားဖြင့် PATH ပြဿနာဖြစ်ပါသည်။ [Node.js troubleshooting](/install/node#troubleshooting) ကို ကြည့်ပါ။
  </Accordion>
</AccordionGroup>
