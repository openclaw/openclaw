---
summary: "ثبّت OpenClaw وشغّل أول دردشة لك خلال دقائق."
read_when:
  - الإعداد لأول مرة من الصفر
  - تريد أسرع مسار للوصول إلى دردشة تعمل
title: "بدء الاستخدام"
x-i18n:
  source_path: start/getting-started.md
  source_hash: 6eeb4d38a70f2ad9
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:48:43Z
---

# بدء الاستخدام

الهدف: الانتقال من الصفر إلى أول دردشة تعمل مع أقل قدر ممكن من الإعداد.

<Info>
أسرع طريقة للدردشة: افتح واجهة التحكم (لا يلزم إعداد قناة). شغّل `openclaw dashboard`
وتحدّث عبر المتصفح، أو افتح `http://127.0.0.1:18789/` على
<Tooltip headline="Gateway host" tip="The machine running the OpenClaw gateway service.">مضيف Gateway</Tooltip>.
الوثائق: [Dashboard](/web/dashboard) و[Control UI](/web/control-ui).
</Info>

## المتطلبات المسبقة

- Node 22 أو أحدث

<Tip>
تحقق من إصدار Node لديك باستخدام `node --version` إذا لم تكن متأكدًا.
</Tip>

## إعداد سريع (CLI)

<Steps>
  <Step title="تثبيت OpenClaw (موصى به)">
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
    طرق التثبيت الأخرى والمتطلبات: [Install](/install).
    </Note>

  </Step>
  <Step title="تشغيل معالج الإعداد الأولي">
    ```bash
    openclaw onboard --install-daemon
    ```

    يقوم المعالج بتهيئة المصادقة، وإعدادات Gateway، والقنوات الاختيارية.
    راجع [Onboarding Wizard](/start/wizard) للتفاصيل.

  </Step>
  <Step title="التحقق من Gateway">
    إذا قمت بتثبيت الخدمة، فيجب أن تكون قيد التشغيل بالفعل:

    ```bash
    openclaw gateway status
    ```

  </Step>
  <Step title="فتح واجهة التحكم">
    ```bash
    openclaw dashboard
    ```
  </Step>
</Steps>

<Check>
إذا تم تحميل واجهة التحكم، فإن Gateway جاهز للاستخدام.
</Check>

## فحوصات إضافية وخيارات اختيارية

<AccordionGroup>
  <Accordion title="تشغيل Gateway في الواجهة الأمامية">
    مفيد للاختبارات السريعة أو استكشاف الأخطاء وإصلاحها.

    ```bash
    openclaw gateway --port 18789
    ```

  </Accordion>
  <Accordion title="إرسال رسالة اختبار">
    يتطلب قناة مُهيّأة.

    ```bash
    openclaw message send --target +15555550123 --message "Hello from OpenClaw"
    ```

  </Accordion>
</AccordionGroup>

## تعمّق أكثر

<Columns>
  <Card title="معالج الإعداد الأولي (تفاصيل)" href="/start/wizard">
    مرجع كامل لمعالج CLI وخيارات متقدمة.
  </Card>
  <Card title="تهيئة تطبيق macOS عند التشغيل الأول" href="/start/onboarding">
    مسار التشغيل الأول لتطبيق macOS.
  </Card>
</Columns>

## ما الذي ستحصل عليه

- Gateway يعمل
- تهيئة المصادقة
- وصول إلى واجهة التحكم أو قناة متصلة

## الخطوات التالية

- أمان الرسائل المباشرة والموافقات: [Pairing](/channels/pairing)
- توصيل المزيد من القنوات: [Channels](/channels)
- سير عمل متقدم والعمل من المصدر: [Setup](/start/setup)
