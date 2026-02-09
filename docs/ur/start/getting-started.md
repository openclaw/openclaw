---
summary: "چند منٹوں میں OpenClaw انسٹال کریں اور اپنی پہلی چیٹ چلائیں۔"
read_when:
  - پہلی بار صفر سے سیٹ اپ
  - آپ ایک کام کرنے والی چیٹ تک تیز ترین راستہ چاہتے ہیں
title: "ابتدائی رہنمائی"
---

# ابتدائی رہنمائی

مقصد: کم سے کم سیٹ اپ کے ساتھ صفر سے ایک پہلی کام کرنے والی چیٹ تک پہنچنا۔

<Info>
Fastest chat: open the Control UI (no channel setup needed). Run `openclaw dashboard`
and chat in the browser, or open `http://127.0.0.1:18789/` on the
<Tooltip headline="Gateway host" tip="The machine running the OpenClaw gateway service.">گیٹ وے ہوسٹ</Tooltip>.
Docs: [Dashboard](/web/dashboard) and [Control UI](/web/control-ui).
</Info>

## پیشگی تقاضے

- Node 22 یا اس سے نیا

<Tip>
اگر یقین نہ ہو تو `node --version` کے ذریعے اپنی Node ورژن چیک کریں۔
</Tip>

## فوری سیٹ اپ (CLI)

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
    دیگر انسٹال طریقے اور تقاضے: [Install](/install)۔
    </Note>
    ```

  </Step>
  <Step title="Run the onboarding wizard">
    ```bash
    openclaw onboard --install-daemon
    ```

    ```
    وِزارڈ تصدیق، گیٹ وے کی ترتیبات، اور اختیاری چینلز کنفیگر کرتا ہے۔
    تفصیلات کے لیے [Onboarding Wizard](/start/wizard) دیکھیں۔
    ```

  </Step>
  <Step title="Check the Gateway">
    اگر آپ نے سروس انسٹال کی ہے تو یہ پہلے ہی چل رہی ہونی چاہیے:

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
اگر Control UI لوڈ ہو جائے تو آپ کا Gateway استعمال کے لیے تیار ہے۔
</Check>

## اختیاری جانچ اور اضافی چیزیں

<AccordionGroup>
  <Accordion title="Run the Gateway in the foreground">
    فوری ٹیسٹس یا خرابیوں کے ازالہ کے لیے مفید۔

    ````
    ```bash
    openclaw gateway --port 18789
    ```
    ````

  </Accordion>
  <Accordion title="Send a test message">
    کنفیگر شدہ چینل درکار ہے۔

    ````
    ```bash
    openclaw message send --target +15555550123 --message "Hello from OpenClaw"
    ```
    ````

  </Accordion>
</AccordionGroup>

## مزید گہرائی میں جائیں

<Columns>
  <Card title="Onboarding Wizard (details)" href="/start/wizard">
    مکمل CLI وِزارڈ حوالہ اور جدید اختیارات۔
  </Card>
  <Card title="macOS app onboarding" href="/start/onboarding">
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
