---
summary: "كيفية عمل سكربتات المُثبّت (install.sh وinstall-cli.sh وinstall.ps1)، والرايات، والأتمتة"
read_when:
  - تريد فهم `openclaw.ai/install.sh`
  - تريد أتمتة عمليات التثبيت (CI / بدون واجهة تفاعلية)
  - تريد التثبيت من نسخة مستنسخة من GitHub
title: "متدرب المثبت"
---

# المثبت الداخلي

توفّر OpenClaw ثلاثة سكربتات تثبيت، تُقدَّم من `openclaw.ai`.

| النص                               | المنصة                                  | ما الذي يفعله                                                                                                                       |
| ---------------------------------- | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| [`install.sh`](#installsh)         | macOS / Linux / WSL                     | يثبّت Node عند الحاجة، ويثبّت OpenClaw عبر npm (افتراضيًا) أو git، ويمكنه تشغيل التهيئة الأولية. |
| [`install-cli.sh`](#install-clish) | macOS / Linux / WSL                     | يثبّت Node وOpenClaw ضمن بادئة محلية (`~/.openclaw`). لا يتطلّب صلاحيات root.    |
| [`install.ps1`](#installps1)       | Windows (PowerShell) | يثبّت Node عند الحاجة، ويثبّت OpenClaw عبر npm (افتراضيًا) أو git، ويمكنه تشغيل التهيئة الأولية. |

## أوامر سريعة

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
إذا نجح التثبيت ولكن لم يتم العثور على `openclaw` في نافذة طرفية جديدة، فراجع [استكشاف أخطاء Node.js وإصلاحها](/install/node#troubleshooting).
</Note>

---

## install.sh

<Tip>
موصى به لمعظم عمليات التثبيت التفاعلية على macOS/Linux/WSL.
</Tip>

### التدفق (install.sh)

<Steps>
  <Step title="Detect OS">
    يدعم macOS وLinux (بما في ذلك WSL). عند اكتشاف macOS، يثبّت Homebrew إذا كان مفقودًا.
  </Step>
  <Step title="Ensure Node.js 22+">
    يتحقّق من إصدار Node ويثبّت Node 22 عند الحاجة (Homebrew على macOS، وسكربتات إعداد NodeSource على Linux عبر apt/dnf/yum).
  </Step>
  <Step title="Ensure Git">
    يثبّت Git إذا كان مفقودًا.
  </Step>
  <Step title="Install OpenClaw">
    - طريقة `npm` (الافتراضية): تثبيت npm عالمي
    - طريقة `git`: استنساخ/تحديث المستودع، تثبيت الاعتمادات عبر pnpm، البناء، ثم تثبيت الغلاف في `~/.local/bin/openclaw`
  </Step>
  <Step title="Post-install tasks">
    - تشغيل `openclaw doctor --non-interactive` عند الترقيات وتثبيتات git (بأفضل جهد)
    - محاولة التهيئة الأولية عند الاقتضاء (توفر TTY، وعدم تعطيل التهيئة الأولية، واجتياز فحوصات bootstrap/التهيئة)
    - الضبط الافتراضي `SHARP_IGNORE_GLOBAL_LIBVIPS=1`
  </Step>
</Steps>

### اكتشاف نسخة المصدر

إذا تم التشغيل داخل نسخة OpenClaw مستنسخة (`package.json` + `pnpm-workspace.yaml`)، يعرض السكربت:

- استخدام النسخة (`git`)، أو
- استخدام التثبيت العالمي (`npm`)

إذا لم يتوفر TTY ولم يتم تعيين طريقة تثبيت، يتم الافتراض إلى `npm` مع إصدار تحذير.

ينهي السكربت التنفيذ برمز الخروج `2` عند اختيار طريقة غير صالحة أو قيم `--install-method` غير صالحة.

### أمثلة (install.sh)

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

| العلم                             | الوصف                                                                                                                                     |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `--install-method npm\\|git`     | اختيار طريقة التثبيت (الافتراضي: `npm`). الاسم البديل: `--method`      |
| `--npm`                           | اختصار لطريقة npm                                                                                                                         |
| `--git`                           | اختصار لطريقة git. الاسم البديل: `--github`                                                               |
| `--version <version\\|dist-tag>` | إصدار npm أو dist-tag (الافتراضي: `latest`)                                                            |
| `--beta`                          | استخدام dist-tag التجريبي إذا كان متاحًا، وإلا فالرجوع إلى `latest`                                                                       |
| `--git-dir <path>`                | دليل النسخة المستنسخة (الافتراضي: `~/openclaw`). الاسم البديل: `--dir` |
| `--no-git-update`                 | تخطي `git pull` لنسخة موجودة                                                                                                              |
| `--no-prompt`                     | تعطيل المطالبات                                                                                                                           |
| `--no-onboard`                    | تخطي أونبواردينج                                                                                                                          |
| `--onboard`                       | تمكين أونبواردينج                                                                                                                         |
| `--dry-run`                       | طباعة الإجراءات دون تطبيق التغييرات                                                                                                       |
| `--verbose`                       | تمكين مخرجات التصحيح (`set -x`، سجلات npm بمستوى الإشعار)                                                              |
| `--help`                          | عرض الاستخدام (`-h`)                                                                                                   |

  </Accordion>

  <Accordion title="Environment variables reference">

| المتغير                                         | الوصف                                                                            |
| ----------------------------------------------- | -------------------------------------------------------------------------------- |
| `OPENCLAW_INSTALL_METHOD=git\\|npm`            | طريقة التثبيت                                                                    |
| `OPENCLAW_VERSION=latest\\|next\\|<semver>`   | إصدار npm أو dist-tag                                                            |
| `OPENCLAW_BETA=0\\|1`                          | استخدام النسخة التجريبية إذا كانت متاحة                                          |
| `OPENCLAW_GIT_DIR=<path>`                       | دليل الدفع                                                                       |
| `OPENCLAW_GIT_UPDATE=0\\|1`                    | تبديل تحديثات git                                                                |
| `OPENCLAW_NO_PROMPT=1`                          | تعطيل المطالبات                                                                  |
| `OPENCLAW_NO_ONBOARD=1`                         | تخطي أونبواردينج                                                                 |
| `OPENCLAW_DRY_RUN=1`                            | وضع التشغيل الجاف                                                                |
| `OPENCLAW_VERBOSE=1`                            | وضع التصحيح                                                                      |
| `OPENCLAW_NPM_LOGLEVEL=error\\|warn\\|notice` | مستوى سجلات npm                                                                  |
| `SHARP_IGNORE_GLOBAL_LIBVIPS=0\\|1`            | التحكم في سلوك sharp/libvips (الافتراضي: `1`) |

  </Accordion>
</AccordionGroup>

---

## install-cli.sh

<Info>
مُصمَّم للبيئات التي تريد فيها أن يكون كل شيء ضمن بادئة محلية (الافتراضي `~/.openclaw`) ومن دون اعتماد على Node على مستوى النظام.
</Info>

### التدفق (install-cli.sh)

<Steps>
  <Step title="Install local Node runtime">
    تنزيل حزمة Node (الافتراضي `22.22.0`) إلى `<prefix>/tools/node-v<version>` والتحقق من SHA-256.
  </Step>
  <Step title="Ensure Git">
    إذا كان Git مفقودًا، يحاول التثبيت عبر apt/dnf/yum على Linux أو Homebrew على macOS.
  </Step>
  <Step title="Install OpenClaw under prefix">
    يثبّت باستخدام npm مع `--prefix <prefix>`، ثم يكتب الغلاف إلى `<prefix>/bin/openclaw`.
  </Step>
</Steps>

### أمثلة (install-cli.sh)

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

| العلم                  | الوصف                                                                                   |
| ---------------------- | --------------------------------------------------------------------------------------- |
| `--prefix <path>`      | بادئة التثبيت (الافتراضي: `~/.openclaw`)             |
| `--version <ver>`      | إصدار OpenClaw أو dist-tag (الافتراضي: `latest`)     |
| `--node-version <ver>` | إصدار Node (الافتراضي: `22.22.0`)                    |
| `--json`               | إخراج أحداث NDJSON                                                                      |
| `--onboard`            | تشغيل `openclaw onboard` بعد التثبيت                                                    |
| `--no-onboard`         | تخطي التهيئة الأولية (افتراضي)                                       |
| `--set-npm-prefix`     | على Linux، فرض بادئة npm إلى `~/.npm-global` إذا كانت البادئة الحالية غير قابلة للكتابة |
| `--help`               | عرض الاستخدام (`-h`)                                                 |

  </Accordion>

  <Accordion title="Environment variables reference">

| المتغير                                         | الوصف                                                                                           |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `OPENCLAW_PREFIX=<path>`                        | بادئة التثبيت                                                                                   |
| `OPENCLAW_VERSION=<ver>`                        | إصدار OpenClaw أو dist-tag                                                                      |
| `OPENCLAW_NODE_VERSION=<ver>`                   | إصدار Node                                                                                      |
| `OPENCLAW_NO_ONBOARD=1`                         | تخطي أونبواردينج                                                                                |
| `OPENCLAW_NPM_LOGLEVEL=error\\|warn\\|notice` | مستوى سجلات npm                                                                                 |
| `OPENCLAW_GIT_DIR=<path>`                       | مسار بحث تنظيف قديم (يُستخدم عند إزالة نسخة قديمة من `Peekaboo` كنسخة فرعية) |
| `SHARP_IGNORE_GLOBAL_LIBVIPS=0\\|1`            | التحكم في سلوك sharp/libvips (الافتراضي: `1`)                |

  </Accordion>
</AccordionGroup>

---

## install.ps1

### التدفق (install.ps1)

<Steps>
  <Step title="Ensure PowerShell + Windows environment">
    يتطلّب PowerShell 5+.
  </Step>
  <Step title="Ensure Node.js 22+">
    إذا كان مفقودًا، يحاول التثبيت عبر winget، ثم Chocolatey، ثم Scoop.
  </Step>
  <Step title="Install OpenClaw">
    - طريقة `npm` (الافتراضية): تثبيت npm عالمي باستخدام `-Tag` المحدد
    - طريقة `git`: استنساخ/تحديث المستودع، التثبيت/البناء عبر pnpm، وتثبيت الغلاف في `%USERPROFILE%\.local\bin\openclaw.cmd`
  </Step>
  <Step title="Post-install tasks">
    يضيف دليل bin المطلوب إلى PATH للمستخدم عند الإمكان، ثم يشغّل `openclaw doctor --non-interactive` عند الترقيات وتثبيتات git (بأفضل جهد).
  </Step>
</Steps>

### أمثلة (install.ps1)

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

| العلم                       | الوصف                                                                                           |
| --------------------------- | ----------------------------------------------------------------------------------------------- |
| `-InstallMethod npm\\|git` | طريقة التثبيت (الافتراضي: `npm`)                             |
| `-Tag <tag>`                | dist-tag لـ npm (الافتراضي: `latest`)                        |
| `-GitDir <path>`            | دليل النسخة المستنسخة (الافتراضي: `%USERPROFILE%\openclaw`) |
| `-NoOnboard`                | تخطي أونبواردينج                                                                                |
| `-NoGitUpdate`              | تخطي `git pull`                                                                                 |
| `-DryRun`                   | طباعة الإجراءات فقط                                                                             |

  </Accordion>

  <Accordion title="Environment variables reference">

| المتغير                              | الوصف             |
| ------------------------------------ | ----------------- |
| `OPENCLAW_INSTALL_METHOD=git\\|npm` | طريقة التثبيت     |
| `OPENCLAW_GIT_DIR=<path>`            | دليل الدفع        |
| `OPENCLAW_NO_ONBOARD=1`              | تخطي أونبواردينج  |
| `OPENCLAW_GIT_UPDATE=0`              | تعطيل git pull    |
| `OPENCLAW_DRY_RUN=1`                 | وضع التشغيل الجاف |

  </Accordion>
</AccordionGroup>

<Note>
إذا تم استخدام `-InstallMethod git` وكان Git مفقودًا، ينهي السكربت التنفيذ ويطبع رابط Git for Windows.
</Note>

---

## CI والأتمتة

استخدم الرايات/متغيرات البيئة غير التفاعلية للحصول على تشغيلات متوقعة.

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

## استكشاف الأخطاء وإصلاحها

<AccordionGroup>
  <Accordion title="Why is Git required?">
    Git مطلوب لطريقة التثبيت `git`. بالنسبة لتثبيتات `npm`، لا يزال يتم التحقق من Git/تثبيته لتجنّب إخفاقات `spawn git ENOENT` عندما تستخدم الاعتمادات عناوين URL عبر git.
  </Accordion>

  <Accordion title="Why does npm hit EACCES on Linux?">
    تشير بعض إعدادات Linux إلى أن بادئة npm العالمية موجّهة إلى مسارات مملوكة لـ root. يمكن لـ `install.sh` تبديل البادئة إلى `~/.npm-global` وإلحاق صادرات PATH بملفات rc الخاصة بالصدفة (عندما تكون تلك الملفات موجودة).
  </Accordion>

  <Accordion title="sharp/libvips issues">
    تضبط السكربتات افتراضيًا `SHARP_IGNORE_GLOBAL_LIBVIPS=1` لتجنّب قيام sharp بالبناء مقابل libvips النظام. للتجاوز:

    ````
    ```bash
    SHARP_IGNORE_GLOBAL_LIBVIPS=0 curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash
    ```
    ````

  </Accordion>

  <Accordion title='Windows: "npm error spawn git / ENOENT"'>
    ثبّت Git for Windows، أعد فتح PowerShell، ثم أعد تشغيل المُثبّت.
  </Accordion>

  <Accordion title='Windows: "openclaw is not recognized"'>
    شغّل `npm config get prefix`، وألحق `\bin`، وأضِف ذلك الدليل إلى PATH للمستخدم، ثم أعد فتح PowerShell.
  </Accordion>

  <Accordion title="openclaw not found after install">
    غالبًا ما تكون مشكلة PATH. راجع [استكشاف أخطاء Node.js وإصلاحها](/install/node#troubleshooting).
  </Accordion>
</AccordionGroup>
