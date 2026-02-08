---
summary: "تثبيت OpenClaw — برنامج التثبيت النصي، npm/pnpm، من المصدر، Docker، والمزيد"
read_when:
  - تحتاج إلى طريقة تثبيت غير البدء السريع ضمن «بدء الاستخدام»
  - ترغب في النشر على منصة سحابية
  - تحتاج إلى التحديث أو الترحيل أو إلغاء التثبيت
title: "التثبيت"
x-i18n:
  source_path: install/index.md
  source_hash: 67c029634ba38196
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:48:30Z
---

# التثبيت

هل اتبعت بالفعل [بدء الاستخدام](/start/getting-started)؟ أنت جاهز — هذه الصفحة مخصّصة لطرق التثبيت البديلة، والتعليمات الخاصة بالمنصّات، وأعمال الصيانة.

## متطلبات النظام

- **[Node 22+](/install/node)** (سيقوم [برنامج التثبيت النصي](#install-methods) بتثبيته إذا كان مفقودًا)
- macOS أو Linux أو Windows
- `pnpm` فقط إذا قمت بالبناء من المصدر

<Note>
على Windows، نوصي بشدّة بتشغيل OpenClaw ضمن [WSL2](https://learn.microsoft.com/en-us/windows/wsl/install).
</Note>

## طرق التثبيت

<Tip>
يُعد **برنامج التثبيت النصي** الطريقة الموصى بها لتثبيت OpenClaw. فهو يتولّى اكتشاف Node وتثبيته والتهيئة الأولية في خطوة واحدة.
</Tip>

<AccordionGroup>
  <Accordion title="برنامج التثبيت النصي" icon="rocket" defaultOpen>
    يقوم بتنزيل CLI وتثبيته بشكل عام عبر npm، ثم تشغيل معالج التهيئة الأولية.

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

    هذا كل شيء — يتكفّل البرنامج باكتشاف Node وتثبيته والتهيئة الأولية.

    لتجاوز التهيئة الأولية والاكتفاء بتثبيت الملف التنفيذي:

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

    للاطلاع على جميع الأعلام ومتغيرات البيئة وخيارات CI/الأتمتة، راجع [Installer internals](/install/installer).

  </Accordion>

  <Accordion title="npm / pnpm" icon="package">
    إذا كان لديك بالفعل Node 22+ وتفضّل إدارة التثبيت بنفسك:

    <Tabs>
      <Tab title="npm">
        ```bash
        npm install -g openclaw@latest
        openclaw onboard --install-daemon
        ```

        <Accordion title="أخطاء بناء sharp؟">
          إذا كان لديك libvips مثبتًا بشكل عام (شائع على macOS عبر Homebrew) وفشل `sharp`، فقم بفرض استخدام الثنائيات المُسبقة البناء:

          ```bash
          SHARP_IGNORE_GLOBAL_LIBVIPS=1 npm install -g openclaw@latest
          ```

          إذا رأيت `sharp: Please add node-gyp to your dependencies`، فإمّا أن تثبّت أدوات البناء (macOS: Xcode CLT + `npm install -g node-gyp`) أو استخدم متغير البيئة أعلاه.
        </Accordion>
      </Tab>
      <Tab title="pnpm">
        ```bash
        pnpm add -g openclaw@latest
        pnpm approve-builds -g        # approve openclaw, node-llama-cpp, sharp, etc.
        openclaw onboard --install-daemon
        ```

        <Note>
        يتطلّب pnpm موافقة صريحة للحِزم التي تحتوي على نصوص بناء. بعد أن يُظهر التثبيت الأول تحذير «Ignored build scripts»، شغّل `pnpm approve-builds -g` واختر الحِزم المدرجة.
        </Note>
      </Tab>
    </Tabs>

  </Accordion>

  <Accordion title="من المصدر" icon="github">
    للمساهمين أو لأي شخص يرغب في التشغيل من نسخة محلية.

    <Steps>
      <Step title="الاستنساخ والبناء">
        استنسخ [مستودع OpenClaw](https://github.com/openclaw/openclaw) ثم ابنِ المشروع:

        ```bash
        git clone https://github.com/openclaw/openclaw.git
        cd openclaw
        pnpm install
        pnpm ui:build
        pnpm build
        ```
      </Step>
      <Step title="ربط CLI">
        اجعل الأمر `openclaw` متاحًا بشكل عام:

        ```bash
        pnpm link --global
        ```

        بديلًا عن ذلك، يمكنك تجاوز الربط وتشغيل الأوامر عبر `pnpm openclaw ...` من داخل المستودع.
      </Step>
      <Step title="تشغيل التهيئة الأولية">
        ```bash
        openclaw onboard --install-daemon
        ```
      </Step>
    </Steps>

    لمزيد من مسارات العمل التطويرية المتقدمة، راجع [الإعداد](/start/setup).

  </Accordion>
</AccordionGroup>

## طرق تثبيت أخرى

<CardGroup cols={2}>
  <Card title="Docker" href="/install/docker" icon="container">
    عمليات نشر مُحاوَاة بالحاويات أو دون واجهة.
  </Card>
  <Card title="Nix" href="/install/nix" icon="snowflake">
    تثبيت تصريحي عبر Nix.
  </Card>
  <Card title="Ansible" href="/install/ansible" icon="server">
    تزويد أساطيل الأنظمة آليًا.
  </Card>
  <Card title="Bun" href="/install/bun" icon="zap">
    استخدام CLI فقط عبر بيئة Bun.
  </Card>
</CardGroup>

## بعد التثبيت

تحقّق من أن كل شيء يعمل كما ينبغي:

```bash
openclaw doctor         # check for config issues
openclaw status         # gateway status
openclaw dashboard      # open the browser UI
```

## استكشاف الأخطاء وإصلاحها: `openclaw` غير موجود

<Accordion title="تشخيص PATH وإصلاحه">
  تشخيص سريع:

```bash
node -v
npm -v
npm prefix -g
echo "$PATH"
```

إذا لم يكن `$(npm prefix -g)/bin` (macOS/Linux) أو `$(npm prefix -g)` (Windows) موجودًا ضمن `$PATH`، فلن يتمكّن الصدَف لديك من العثور على ثنائيات npm العامة (بما في ذلك `openclaw`).

الإصلاح — أضِفه إلى ملف بدء تشغيل الصدَف لديك (`~/.zshrc` أو `~/.bashrc`):

```bash
export PATH="$(npm prefix -g)/bin:$PATH"
```

على Windows، أضِف ناتج `npm prefix -g` إلى PATH.

ثم افتح طرفية جديدة (أو `rehash` في zsh / `hash -r` في bash).
</Accordion>

## التحديث / إلغاء التثبيت

<CardGroup cols={3}>
  <Card title="التحديث" href="/install/updating" icon="refresh-cw">
    حافظ على تحديث OpenClaw.
  </Card>
  <Card title="الترحيل" href="/install/migrating" icon="arrow-right">
    الانتقال إلى جهاز جديد.
  </Card>
  <Card title="إلغاء التثبيت" href="/install/uninstall" icon="trash-2">
    إزالة OpenClaw بالكامل.
  </Card>
</CardGroup>
