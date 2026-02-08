---
summary: "چند منٹوں میں OpenClaw انسٹال کریں اور اپنی پہلی چیٹ چلائیں۔"
read_when:
  - پہلی بار صفر سے سیٹ اپ
  - آپ ایک کام کرنے والی چیٹ تک تیز ترین راستہ چاہتے ہیں
title: "ابتدائی رہنمائی"
x-i18n:
  source_path: start/getting-started.md
  source_hash: 6eeb4d38a70f2ad9
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:47:41Z
---

# ابتدائی رہنمائی

مقصد: کم سے کم سیٹ اپ کے ساتھ صفر سے ایک پہلی کام کرنے والی چیٹ تک پہنچنا۔

<Info>
تیز ترین چیٹ: Control UI کھولیں (کسی چینل سیٹ اپ کی ضرورت نہیں)۔ `openclaw dashboard` چلائیں
اور براؤزر میں چیٹ کریں، یا
<Tooltip headline="Gateway host" tip="وہ مشین جس پر OpenClaw گیٹ وے سروس چل رہی ہو۔">گیٹ وے ہوسٹ</Tooltip>
پر `http://127.0.0.1:18789/` کھولیں۔
دستاویزات: [Dashboard](/web/dashboard) اور [Control UI](/web/control-ui)۔
</Info>

## پیشگی تقاضے

- Node 22 یا اس سے نیا

<Tip>
اگر یقین نہ ہو تو `node --version` کے ذریعے اپنی Node ورژن چیک کریں۔
</Tip>

## فوری سیٹ اپ (CLI)

<Steps>
  <Step title="OpenClaw انسٹال کریں (سفارش کردہ)">
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
    دیگر انسٹال طریقے اور تقاضے: [Install](/install)۔
    </Note>

  </Step>
  <Step title="آن بورڈنگ وِزارڈ چلائیں">
    ```bash
    openclaw onboard --install-daemon
    ```

    وِزارڈ تصدیق، گیٹ وے کی ترتیبات، اور اختیاری چینلز کنفیگر کرتا ہے۔
    تفصیلات کے لیے [Onboarding Wizard](/start/wizard) دیکھیں۔

  </Step>
  <Step title="Gateway چیک کریں">
    اگر آپ نے سروس انسٹال کی ہے تو یہ پہلے ہی چل رہی ہونی چاہیے:

    ```bash
    openclaw gateway status
    ```

  </Step>
  <Step title="Control UI کھولیں">
    ```bash
    openclaw dashboard
    ```
  </Step>
</Steps>

<Check>
اگر Control UI لوڈ ہو جائے تو آپ کا Gateway استعمال کے لیے تیار ہے۔
</Check>

## اختیاری جانچ اور اضافی چیزیں

<AccordionGroup>
  <Accordion title="Gateway کو foreground میں چلائیں">
    فوری ٹیسٹس یا خرابیوں کے ازالہ کے لیے مفید۔

    ```bash
    openclaw gateway --port 18789
    ```

  </Accordion>
  <Accordion title="ایک ٹیسٹ پیغام بھیجیں">
    کنفیگر شدہ چینل درکار ہے۔

    ```bash
    openclaw message send --target +15555550123 --message "Hello from OpenClaw"
    ```

  </Accordion>
</AccordionGroup>

## مزید گہرائی میں جائیں

<Columns>
  <Card title="Onboarding Wizard (تفصیلات)" href="/start/wizard">
    مکمل CLI وِزارڈ حوالہ اور جدید اختیارات۔
  </Card>
  <Card title="macOS ایپ آن بورڈنگ" href="/start/onboarding">
    macOS ایپ کے لیے پہلی بار چلانے کا عمل۔
  </Card>
</Columns>

## آپ کے پاس کیا ہوگا

- ایک چلتا ہوا Gateway
- تصدیق کنفیگر شدہ
- Control UI تک رسائی یا ایک منسلک چینل

## اگلے اقدامات

- DMs کی حفاظت اور منظوریات: [Pairing](/channels/pairing)
- مزید چینلز منسلک کریں: [Channels](/channels)
- جدید ورک فلو اور سورس سے چلانا: [Setup](/start/setup)
