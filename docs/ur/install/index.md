---
summary: "OpenClaw انسٹال کریں — انسٹالر اسکرپٹ، npm/pnpm، سورس سے، Docker، اور مزید"
read_when:
  - آپ کو Getting Started کے فوری آغاز کے علاوہ کسی اور انسٹال طریقے کی ضرورت ہو
  - آپ کلاؤڈ پلیٹ فارم پر تعیناتی کرنا چاہتے ہوں
  - آپ کو اپڈیٹ، مائیگریٹ، یا ان انسٹال کرنا ہو
title: "انسٹال"
x-i18n:
  source_path: install/index.md
  source_hash: 67c029634ba38196
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:47:29Z
---

# انسٹال

کیا آپ پہلے ہی [Getting Started](/start/getting-started) پر عمل کر چکے ہیں؟ تو آپ تیار ہیں — یہ صفحہ متبادل انسٹال طریقوں، پلیٹ فارم کے مطابق ہدایات، اور مینٹیننس کے لیے ہے۔

## سسٹم ضروریات

- **[Node 22+](/install/node)** (اگر موجود نہ ہو تو [انسٹالر اسکرپٹ](#install-methods) اسے انسٹال کر دے گا)
- macOS، Linux، یا Windows
- `pnpm` صرف اس صورت میں جب آپ سورس سے بلڈ کریں

<Note>
Windows پر ہم سختی سے تجویز کرتے ہیں کہ OpenClaw کو [WSL2](https://learn.microsoft.com/en-us/windows/wsl/install) کے تحت چلائیں۔
</Note>

## انسٹال کے طریقے

<Tip>
**انسٹالر اسکرپٹ** OpenClaw انسٹال کرنے کا تجویز کردہ طریقہ ہے۔ یہ ایک ہی مرحلے میں Node کی شناخت، انسٹالیشن، اور آن بورڈنگ کو سنبھالتا ہے۔
</Tip>

<AccordionGroup>
  <Accordion title="انسٹالر اسکرپٹ" icon="rocket" defaultOpen>
    CLI ڈاؤن لوڈ کرتا ہے، npm کے ذریعے اسے عالمی طور پر انسٹال کرتا ہے، اور آن بورڈنگ وزارڈ شروع کرتا ہے۔

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

    بس اتنا ہی — اسکرپٹ Node کی شناخت، انسٹالیشن، اور آن بورڈنگ سب سنبھالتا ہے۔

    آن بورڈنگ چھوڑ کر صرف بائنری انسٹال کرنے کے لیے:

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

    تمام فلیگز، env vars، اور CI/automation اختیارات کے لیے [Installer internals](/install/installer) دیکھیں۔

  </Accordion>

  <Accordion title="npm / pnpm" icon="package">
    اگر آپ کے پاس پہلے ہی Node 22+ ہے اور آپ انسٹالیشن خود منظم کرنا چاہتے ہیں:

    <Tabs>
      <Tab title="npm">
        ```bash
        npm install -g openclaw@latest
        openclaw onboard --install-daemon
        ```

        <Accordion title="sharp بلڈ کی غلطیاں؟">
          اگر آپ کے سسٹم پر libvips عالمی طور پر انسٹال ہے (macOS پر Homebrew کے ذریعے یہ عام ہے) اور `sharp` ناکام ہو جاتا ہے، تو پہلے سے تیار شدہ بائنریز کو مجبور کریں:

          ```bash
          SHARP_IGNORE_GLOBAL_LIBVIPS=1 npm install -g openclaw@latest
          ```

          اگر آپ کو `sharp: Please add node-gyp to your dependencies` نظر آئے، تو یا تو بلڈ ٹولنگ انسٹال کریں (macOS: Xcode CLT + `npm install -g node-gyp`) یا اوپر دیا گیا env var استعمال کریں۔
        </Accordion>
      </Tab>
      <Tab title="pnpm">
        ```bash
        pnpm add -g openclaw@latest
        pnpm approve-builds -g        # approve openclaw, node-llama-cpp, sharp, etc.
        openclaw onboard --install-daemon
        ```

        <Note>
        pnpm اُن پیکیجز کے لیے جن میں build scripts ہوں، واضح منظوری کا تقاضا کرتا ہے۔ پہلی انسٹال کے بعد جب "Ignored build scripts" کی وارننگ دکھائی دے، تو `pnpm approve-builds -g` چلائیں اور فہرست میں موجود پیکیجز منتخب کریں۔
        </Note>
      </Tab>
    </Tabs>

  </Accordion>

  <Accordion title="سورس سے" icon="github">
    شراکت داروں یا اُن کے لیے جو مقامی چیک آؤٹ سے چلانا چاہتے ہوں۔

    <Steps>
      <Step title="کلون اور بلڈ کریں">
        [OpenClaw repo](https://github.com/openclaw/openclaw) کو کلون کریں اور بلڈ کریں:

        ```bash
        git clone https://github.com/openclaw/openclaw.git
        cd openclaw
        pnpm install
        pnpm ui:build
        pnpm build
        ```
      </Step>
      <Step title="CLI کو لنک کریں">
        `openclaw` کمانڈ کو عالمی طور پر دستیاب بنائیں:

        ```bash
        pnpm link --global
        ```

        متبادل طور پر، لنک چھوڑ دیں اور ریپو کے اندر سے `pnpm openclaw ...` کے ذریعے کمانڈز چلائیں۔
      </Step>
      <Step title="آن بورڈنگ چلائیں">
        ```bash
        openclaw onboard --install-daemon
        ```
      </Step>
    </Steps>

    مزید گہرے ڈیولپمنٹ ورک فلو کے لیے [Setup](/start/setup) دیکھیں۔

  </Accordion>
</AccordionGroup>

## دیگر انسٹال طریقے

<CardGroup cols={2}>
  <Card title="Docker" href="/install/docker" icon="container">
    کنٹینرائزڈ یا ہیڈ لیس تعیناتیاں۔
  </Card>
  <Card title="Nix" href="/install/nix" icon="snowflake">
    Nix کے ذریعے ڈیکلیریٹو انسٹال۔
  </Card>
  <Card title="Ansible" href="/install/ansible" icon="server">
    خودکار فلیٹ پروویژننگ۔
  </Card>
  <Card title="Bun" href="/install/bun" icon="zap">
    Bun رن ٹائم کے ذریعے صرف CLI استعمال۔
  </Card>
</CardGroup>

## انسٹال کے بعد

تصدیق کریں کہ سب کچھ درست طور پر کام کر رہا ہے:

```bash
openclaw doctor         # check for config issues
openclaw status         # gateway status
openclaw dashboard      # open the browser UI
```

## خرابیوں کا ازالہ: `openclaw` نہیں ملا

<Accordion title="PATH کی تشخیص اور حل">
  فوری تشخیص:

```bash
node -v
npm -v
npm prefix -g
echo "$PATH"
```

اگر `$(npm prefix -g)/bin` (macOS/Linux) یا `$(npm prefix -g)` (Windows) آپ کے `$PATH` میں **موجود نہیں** ہے، تو آپ کی شیل عالمی npm بائنریز (بشمول `openclaw`) تلاش نہیں کر پا رہی۔

حل — اسے اپنی شیل اسٹارٹ اپ فائل (`~/.zshrc` یا `~/.bashrc`) میں شامل کریں:

```bash
export PATH="$(npm prefix -g)/bin:$PATH"
```

Windows پر، `npm prefix -g` کے آؤٹ پٹ کو اپنے PATH میں شامل کریں۔

پھر نیا ٹرمینل کھولیں (یا zsh میں `rehash` / bash میں `hash -r`)۔
</Accordion>

## اپڈیٹ / ان انسٹال

<CardGroup cols={3}>
  <Card title="اپڈیٹنگ" href="/install/updating" icon="refresh-cw">
    OpenClaw کو تازہ ترین رکھیں۔
  </Card>
  <Card title="مائیگریٹنگ" href="/install/migrating" icon="arrow-right">
    نئی مشین پر منتقل کریں۔
  </Card>
  <Card title="ان انسٹال" href="/install/uninstall" icon="trash-2">
    OpenClaw کو مکمل طور پر ہٹا دیں۔
  </Card>
</CardGroup>
