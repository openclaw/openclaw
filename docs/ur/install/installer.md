---
summary: "انسٹالر اسکرپٹس کیسے کام کرتے ہیں (install.sh، install-cli.sh، install.ps1)، فلیگز، اور آٹومیشن"
read_when:
  - آپ `openclaw.ai/install.sh` کو سمجھنا چاہتے ہوں
  - آپ انسٹالیشن کو خودکار بنانا چاہتے ہوں (CI / ہیڈلیس)
  - آپ GitHub چیک آؤٹ سے انسٹال کرنا چاہتے ہوں
title: "انسٹالر کے اندرونی پہلو"
---

# انسٹالر کے اندرونی پہلو

OpenClaw تین انسٹالر اسکرپٹس فراہم کرتا ہے، جو `openclaw.ai` سے مہیا کیے جاتے ہیں۔

| اسکرپٹ                             | پلیٹ فارم                               | یہ کیا کرتا ہے                                                                                                                                 |
| ---------------------------------- | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| [`install.sh`](#installsh)         | macOS / Linux / WSL                     | اگر ضرورت ہو تو Node انسٹال کرتا ہے، npm (بطورِ طے شدہ) یا git کے ذریعے OpenClaw انسٹال کرتا ہے، اور آن بورڈنگ چلا سکتا ہے۔ |
| [`install-cli.sh`](#install-clish) | macOS / Linux / WSL                     | Installs Node + OpenClaw into a local prefix (`~/.openclaw`). No root required.             |
| [`install.ps1`](#installps1)       | Windows (PowerShell) | اگر ضرورت ہو تو Node انسٹال کرتا ہے، npm (بطورِ طے شدہ) یا git کے ذریعے OpenClaw انسٹال کرتا ہے، اور آن بورڈنگ چلا سکتا ہے۔ |

## فوری کمانڈز

<Tabs>
  <Tab title="install.sh">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash
    ```

    ````
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash -s -- --help
    ```
    ````

  </Tab>
  <Tab title="install-cli.sh">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install-cli.sh | bash
    ```

    ````
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install-cli.sh | bash -s -- --help
    ```
    ````

  </Tab>
  <Tab title="install.ps1">
    ```powershell
    iwr -useb https://openclaw.ai/install.ps1 | iex
    ```

    ````
    ```powershell
    & ([scriptblock]::Create((iwr -useb https://openclaw.ai/install.ps1))) -Tag beta -NoOnboard -DryRun
    ```
    ````

  </Tab>
</Tabs>

<Note>
اگر انسٹال کامیاب ہو جائے لیکن نئی ٹرمینل میں `openclaw` دستیاب نہ ہو تو [Node.js troubleshooting](/install/node#troubleshooting) دیکھیں۔
</Note>

---

## install.sh

<Tip>
macOS/Linux/WSL پر زیادہ تر انٹرایکٹو انسٹالیشنز کے لیے سفارش کردہ۔
</Tip>

### فلو (install.sh)

<Steps>
  <Step title="Detect OS">
    Supports macOS and Linux (including WSL). If macOS is detected, installs Homebrew if missing.
  </Step>
  <Step title="Ensure Node.js 22+">
    Node ورژن چیک کرتا ہے اور ضرورت پڑنے پر Node 22 انسٹال کرتا ہے (macOS پر Homebrew، Linux apt/dnf/yum پر NodeSource سیٹ اپ اسکرپٹس)۔
  </Step>
  <Step title="Ensure Git">
    اگر Git موجود نہ ہو تو اسے انسٹال کرتا ہے۔
  </Step>
  <Step title="Install OpenClaw">
    - `npm` طریقہ (بطورِ طے شدہ): عالمی npm انسٹال
    - `git` طریقہ: ریپو کلون/اپ ڈیٹ کریں، pnpm کے ذریعے ڈیپس انسٹال کریں، بلڈ کریں، پھر `~/.local/bin/openclaw` پر ریپر انسٹال کریں
  </Step>
  <Step title="Post-install tasks">
    - اپ گریڈز اور git انسٹالز پر `openclaw doctor --non-interactive` چلاتا ہے (بہترین کوشش)
    - موزوں حالات میں آن بورڈنگ کی کوشش کرتا ہے (TTY دستیاب ہو، آن بورڈنگ غیر فعال نہ ہو، اور bootstrap/config چیکس کامیاب ہوں)
    - بطورِ طے شدہ `SHARP_IGNORE_GLOBAL_LIBVIPS=1`
  </Step>
</Steps>

### سورس چیک آؤٹ کی شناخت

اگر OpenClaw کے چیک آؤٹ کے اندر چلایا جائے (`package.json` + `pnpm-workspace.yaml`) تو اسکرپٹ درج ذیل اختیارات پیش کرتا ہے:

- چیک آؤٹ استعمال کریں (`git`)، یا
- عالمی انسٹال استعمال کریں (`npm`)

اگر TTY دستیاب نہ ہو اور کوئی انسٹال طریقہ مقرر نہ ہو تو یہ بطورِ طے شدہ `npm` منتخب کرتا ہے اور انتباہ دیتا ہے۔

غلط طریقہ انتخاب یا غلط `--install-method` اقدار کی صورت میں اسکرپٹ کوڈ `2` کے ساتھ خارج ہوتا ہے۔

### مثالیں (install.sh)

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

| فلیگ                              | وضاحت                                                                                                                         |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `--install-method npm\\|git`     | Choose install method (default: `npm`). Alias: `--method`  |
| `--npm`                           | npm طریقے کے لیے شارٹ کٹ                                                                                                      |
| `--git`                           | Shortcut for git method. Alias: `--github`                                                    |
| `--version <version\\|dist-tag>` | npm ورژن یا dist-tag (بطورِ طے شدہ: `latest`)                                              |
| `--beta`                          | اگر دستیاب ہو تو beta dist-tag استعمال کریں، ورنہ `latest` پر واپس جائیں                                                      |
| `--git-dir <path>`                | Checkout directory (default: `~/openclaw`). Alias: `--dir` |
| `--no-git-update`                 | موجودہ چیک آؤٹ کے لیے `git pull` چھوڑ دیں                                                                                     |
| `--no-prompt`                     | پرامپٹس غیر فعال کریں                                                                                                         |
| `--no-onboard`                    | آن بورڈنگ چھوڑ دیں                                                                                                            |
| `--onboard`                       | آن بورڈنگ فعال کریں                                                                                                           |
| `--dry-run`                       | تبدیلیاں لاگو کیے بغیر کارروائیاں پرنٹ کریں                                                                                   |
| `--verbose`                       | ڈیبگ آؤٹ پٹ فعال کریں (`set -x`، npm notice-level لاگز)                                                    |
| `--help`                          | استعمال دکھائیں (`-h`)                                                                                     |

  </Accordion>

  <Accordion title="Environment variables reference">

| متغیر                                           | وضاحت                                                                                       |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `OPENCLAW_INSTALL_METHOD=git\\|npm`            | انسٹال طریقہ                                                                                |
| `OPENCLAW_VERSION=latest\\|next\\|<semver>`   | npm ورژن یا dist-tag                                                                        |
| `OPENCLAW_BETA=0\\|1`                          | اگر دستیاب ہو تو beta استعمال کریں                                                          |
| `OPENCLAW_GIT_DIR=<path>`                       | چیک آؤٹ ڈائریکٹری                                                                           |
| `OPENCLAW_GIT_UPDATE=0\\|1`                    | git اپ ڈیٹس کو ٹوگل کریں                                                                    |
| `OPENCLAW_NO_PROMPT=1`                          | پرامپٹس غیر فعال کریں                                                                       |
| `OPENCLAW_NO_ONBOARD=1`                         | آن بورڈنگ چھوڑ دیں                                                                          |
| `OPENCLAW_DRY_RUN=1`                            | Dry run موڈ                                                                                 |
| `OPENCLAW_VERBOSE=1`                            | ڈیبگ موڈ                                                                                    |
| `OPENCLAW_NPM_LOGLEVEL=error\\|warn\\|notice` | npm لاگ لیول                                                                                |
| `SHARP_IGNORE_GLOBAL_LIBVIPS=0\\|1`            | sharp/libvips کے رویے کو کنٹرول کریں (بطورِ طے شدہ: `1`) |

  </Accordion>
</AccordionGroup>

---

## install-cli.sh

<Info>
ان ماحول کے لیے ڈیزائن کیا گیا ہے جہاں آپ چاہتے ہیں کہ سب کچھ ایک مقامی پری فکس (بطورِ طے شدہ `~/.openclaw`) کے تحت ہو اور سسٹم Node پر انحصار نہ ہو۔
</Info>

### فلو (install-cli.sh)

<Steps>
  <Step title="Install local Node runtime">
    Node ٹاربال (بطورِ طے شدہ `22.22.0`) کو `<prefix>/tools/node-v<version>` پر ڈاؤن لوڈ کرتا ہے اور SHA-256 کی تصدیق کرتا ہے۔
  </Step>
  <Step title="Ensure Git">
    اگر Git موجود نہ ہو تو Linux پر apt/dnf/yum یا macOS پر Homebrew کے ذریعے انسٹال کرنے کی کوشش کرتا ہے۔
  </Step>
  <Step title="Install OpenClaw under prefix">
    npm کے ذریعے `--prefix <prefix>` استعمال کرتے ہوئے انسٹال کرتا ہے، پھر `<prefix>/bin/openclaw` پر ریپر لکھتا ہے۔
  </Step>
</Steps>

### مثالیں (install-cli.sh)

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

| فلیگ                   | وضاحت                                                                                          |
| ---------------------- | ---------------------------------------------------------------------------------------------- |
| `--prefix <path>`      | انسٹال پری فکس (بطورِ طے شدہ: `~/.openclaw`)                |
| `--version <ver>`      | OpenClaw ورژن یا dist-tag (بطورِ طے شدہ: `latest`)          |
| `--node-version <ver>` | Node ورژن (بطورِ طے شدہ: `22.22.0`)                         |
| `--json`               | NDJSON ایونٹس خارج کریں                                                                        |
| `--onboard`            | انسٹال کے بعد `openclaw onboard` چلائیں                                                        |
| `--no-onboard`         | آن بورڈنگ چھوڑ دیں (بطورِ طے شدہ)                                           |
| `--set-npm-prefix`     | Linux پر، اگر موجودہ پری فکس قابلِ تحریر نہ ہو تو npm پری فکس کو `~/.npm-global` پر مجبور کریں |
| `--help`               | استعمال دکھائیں (`-h`)                                                      |

  </Accordion>

  <Accordion title="Environment variables reference">

| متغیر                                           | وضاحت                                                                                                           |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `OPENCLAW_PREFIX=<path>`                        | انسٹال پری فکس                                                                                                  |
| `OPENCLAW_VERSION=<ver>`                        | OpenClaw ورژن یا dist-tag                                                                                       |
| `OPENCLAW_NODE_VERSION=<ver>`                   | Node ورژن                                                                                                       |
| `OPENCLAW_NO_ONBOARD=1`                         | آن بورڈنگ چھوڑ دیں                                                                                              |
| `OPENCLAW_NPM_LOGLEVEL=error\\|warn\\|notice` | npm لاگ لیول                                                                                                    |
| `OPENCLAW_GIT_DIR=<path>`                       | لیگیسی کلین اپ لوک اپ پاتھ (پرانے `Peekaboo` سب ماڈیول چیک آؤٹ کو ہٹاتے وقت استعمال ہوتا ہے) |
| `SHARP_IGNORE_GLOBAL_LIBVIPS=0\\|1`            | sharp/libvips کے رویے کو کنٹرول کریں (بطورِ طے شدہ: `1`)                     |

  </Accordion>
</AccordionGroup>

---

## install.ps1

### فلو (install.ps1)

<Steps>
  <Step title="Ensure PowerShell + Windows environment">
    PowerShell 5+ درکار ہے۔
  </Step>
  <Step title="Ensure Node.js 22+">
    اگر موجود نہ ہو تو پہلے winget، پھر Chocolatey، پھر Scoop کے ذریعے انسٹال کرنے کی کوشش کرتا ہے۔
  </Step>
  <Step title="Install OpenClaw">
    - `npm` طریقہ (بطورِ طے شدہ): منتخب `-Tag` استعمال کرتے ہوئے عالمی npm انسٹال
    - `git` طریقہ: ریپو کلون/اپ ڈیٹ کریں، pnpm کے ذریعے انسٹال/بلڈ کریں، اور `%USERPROFILE%\.local\bin\openclaw.cmd` پر ریپر انسٹال کریں
  </Step>
  <Step title="Post-install tasks">
    ممکن ہونے پر مطلوبہ bin ڈائریکٹری کو صارف کے PATH میں شامل کرتا ہے، پھر اپ گریڈز اور git انسٹالز پر `openclaw doctor --non-interactive` چلاتا ہے (بہترین کوشش)۔
  </Step>
</Steps>

### مثالیں (install.ps1)

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

| فلیگ                        | وضاحت                                                                                          |
| --------------------------- | ---------------------------------------------------------------------------------------------- |
| `-InstallMethod npm\\|git` | انسٹال طریقہ (بطورِ طے شدہ: `npm`)                          |
| `-Tag <tag>`                | npm dist-tag (بطورِ طے شدہ: `latest`)                       |
| `-GitDir <path>`            | چیک آؤٹ ڈائریکٹری (بطورِ طے شدہ: `%USERPROFILE%\openclaw`) |
| `-NoOnboard`                | آن بورڈنگ چھوڑ دیں                                                                             |
| `-NoGitUpdate`              | `git pull` چھوڑ دیں                                                                            |
| `-DryRun`                   | صرف کارروائیاں پرنٹ کریں                                                                       |

  </Accordion>

  <Accordion title="Environment variables reference">

| متغیر                                | وضاحت                  |
| ------------------------------------ | ---------------------- |
| `OPENCLAW_INSTALL_METHOD=git\\|npm` | انسٹال طریقہ           |
| `OPENCLAW_GIT_DIR=<path>`            | چیک آؤٹ ڈائریکٹری      |
| `OPENCLAW_NO_ONBOARD=1`              | آن بورڈنگ چھوڑ دیں     |
| `OPENCLAW_GIT_UPDATE=0`              | git pull غیر فعال کریں |
| `OPENCLAW_DRY_RUN=1`                 | Dry run موڈ            |

  </Accordion>
</AccordionGroup>

<Note>
اگر `-InstallMethod git` استعمال کیا جائے اور Git موجود نہ ہو تو اسکرپٹ خارج ہو جاتا ہے اور Git for Windows کا لنک پرنٹ کرتا ہے۔
</Note>

---

## CI اور آٹومیشن

قابلِ پیش گوئی رنز کے لیے غیر انٹرایکٹو فلیگز/ماحولیاتی متغیرات استعمال کریں۔

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

## خرابیوں کا ازالہ

<AccordionGroup>
  <Accordion title="Why is Git required?">
    Git is required for `git` install method. For `npm` installs, Git is still checked/installed to avoid `spawn git ENOENT` failures when dependencies use git URLs.
  </Accordion>

  <Accordion title="Why does npm hit EACCES on Linux?">
    Some Linux setups point npm global prefix to root-owned paths. `install.sh` can switch prefix to `~/.npm-global` and append PATH exports to shell rc files (when those files exist).
  </Accordion>

  <Accordion title="sharp/libvips issues">
    The scripts default `SHARP_IGNORE_GLOBAL_LIBVIPS=1` to avoid sharp building against system libvips. To override:

    ````
    ```bash
    SHARP_IGNORE_GLOBAL_LIBVIPS=0 curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash
    ```
    ````

  </Accordion>

  <Accordion title='Windows: "npm error spawn git / ENOENT"'>
    Git for Windows انسٹال کریں، PowerShell دوبارہ کھولیں، اور انسٹالر دوبارہ چلائیں۔
  </Accordion>

  <Accordion title='Windows: "openclaw is not recognized"'>
    `npm config get prefix` چلائیں، `\bin` شامل کریں، اس ڈائریکٹری کو صارف کے PATH میں شامل کریں، پھر PowerShell دوبارہ کھولیں۔
  </Accordion>

  <Accordion title="openclaw not found after install">
    Usually a PATH issue. See [Node.js troubleshooting](/install/node#troubleshooting).
  </Accordion>
</AccordionGroup>
