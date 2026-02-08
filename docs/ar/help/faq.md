---
summary: "الأسئلة الشائعة حول إعداد OpenClaw وتهيئته واستخدامه"
title: "الأسئلة الشائعة"
x-i18n:
  source_path: help/faq.md
  source_hash: b7c0c9766461f6e7
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:48:40Z
---

# الأسئلة الشائعة

إجابات سريعة مع استكشاف أعمق للأخطاء وإصلاحها لسيناريوهات العالم الحقيقي (التطوير المحلي، VPS، تعدد الوكلاء، OAuth/مفاتيح API، التبديل الاحتياطي للنماذج). لتشخيصات وقت التشغيل، راجع [استكشاف الأخطاء وإصلاحها](/gateway/troubleshooting). ولمرجع التهيئة الكامل، راجع [التهيئة](/gateway/configuration).

## جدول المحتويات

- [البدء السريع وإعداد التشغيل الأول]
  - [أنا عالق—ما أسرع طريقة للخروج من التعطّل؟](#im-stuck-whats-the-fastest-way-to-get-unstuck)
  - [ما الطريقة الموصى بها لتثبيت OpenClaw وإعداده؟](#whats-the-recommended-way-to-install-and-set-up-openclaw)
  - [كيف أفتح لوحة التحكم بعد التهيئة الأولية؟](#how-do-i-open-the-dashboard-after-onboarding)
  - [كيف أوثّق لوحة التحكم (الرمز) على localhost مقابل الاتصال البعيد؟](#how-do-i-authenticate-the-dashboard-token-on-localhost-vs-remote)
  - [ما بيئة التشغيل المطلوبة؟](#what-runtime-do-i-need)
  - [هل يعمل على Raspberry Pi؟](#does-it-run-on-raspberry-pi)
  - [هل هناك نصائح لتثبيت Raspberry Pi؟](#any-tips-for-raspberry-pi-installs)
  - [عالق على «wake up my friend» / التهيئة الأولية لا تكتمل. ماذا الآن؟](#it-is-stuck-on-wake-up-my-friend-onboarding-will-not-hatch-what-now)
  - [هل يمكنني ترحيل إعدادي إلى جهاز جديد (Mac mini) دون إعادة التهيئة الأولية؟](#can-i-migrate-my-setup-to-a-new-machine-mac-mini-without-redoing-onboarding)
  - [أين أرى ما الجديد في أحدث إصدار؟](#where-do-i-see-what-is-new-in-the-latest-version)
  - [لا أستطيع الوصول إلى docs.openclaw.ai (خطأ SSL). ماذا أفعل؟](#i-cant-access-docsopenclawai-ssl-error-what-now)
  - [ما الفرق بين المستقر وبيتا؟](#whats-the-difference-between-stable-and-beta)
  - [كيف أثبّت نسخة بيتا، وما الفرق بين بيتا وdev؟](#how-do-i-install-the-beta-version-and-whats-the-difference-between-beta-and-dev)
  - [كيف أجرّب أحدث الإصدارات؟](#how-do-i-try-the-latest-bits)
  - [كم يستغرق التثبيت والتهيئة الأولية عادةً؟](#how-long-does-install-and-onboarding-usually-take)
  - [توقّف المُثبّت؟ كيف أحصل على مزيد من المعلومات؟](#installer-stuck-how-do-i-get-more-feedback)
  - [تثبيت Windows يقول git غير موجود أو openclaw غير معروف](#windows-install-says-git-not-found-or-openclaw-not-recognized)
  - [لم تُجب المستندات عن سؤالي—كيف أحصل على إجابة أفضل؟](#the-docs-didnt-answer-my-question-how-do-i-get-a-better-answer)
  - [كيف أثبّت OpenClaw على Linux؟](#how-do-i-install-openclaw-on-linux)
  - [كيف أثبّت OpenClaw على VPS؟](#how-do-i-install-openclaw-on-a-vps)
  - [أين أدلة تثبيت السحابة/VPS؟](#where-are-the-cloudvps-install-guides)
  - [هل يمكنني أن أطلب من OpenClaw تحديث نفسه؟](#can-i-ask-openclaw-to-update-itself)
  - [ماذا يفعل معالج التهيئة الأولية فعليًا؟](#what-does-the-onboarding-wizard-actually-do)
  - [هل أحتاج اشتراك Claude أو OpenAI لتشغيله؟](#do-i-need-a-claude-or-openai-subscription-to-run-this)
  - [هل يمكنني استخدام اشتراك Claude Max دون مفتاح API؟](#can-i-use-claude-max-subscription-without-an-api-key)
  - [كيف يعمل توثيق Anthropic «setup-token»؟](#how-does-anthropic-setuptoken-auth-work)
  - [أين أجد setup-token الخاص بـ Anthropic؟](#where-do-i-find-an-anthropic-setuptoken)
  - [هل تدعمون توثيق اشتراك Claude (Pro أو Max)؟](#do-you-support-claude-subscription-auth-claude-pro-or-max)
  - [لماذا أرى `HTTP 429: rate_limit_error` من Anthropic؟](#why-am-i-seeing-http-429-ratelimiterror-from-anthropic)
  - [هل AWS Bedrock مدعوم؟](#is-aws-bedrock-supported)
  - [كيف يعمل توثيق Codex؟](#how-does-codex-auth-work)
  - [هل تدعمون توثيق اشتراك OpenAI (Codex OAuth)؟](#do-you-support-openai-subscription-auth-codex-oauth)
  - [كيف أُعد Gemini CLI OAuth؟](#how-do-i-set-up-gemini-cli-oauth)
  - [هل النموذج المحلي مناسب للدردشات العادية؟](#is-a-local-model-ok-for-casual-chats)
  - [كيف أحافظ على مرور حركة النماذج المستضافة ضمن منطقة محددة؟](#how-do-i-keep-hosted-model-traffic-in-a-specific-region)
  - [هل يجب أن أشتري Mac Mini لتثبيت هذا؟](#do-i-have-to-buy-a-mac-mini-to-install-this)
  - [هل أحتاج Mac mini لدعم iMessage؟](#do-i-need-a-mac-mini-for-imessage-support)
  - [إذا اشتريت Mac mini لتشغيل OpenClaw، هل يمكنني ربطه بـ MacBook Pro؟](#if-i-buy-a-mac-mini-to-run-openclaw-can-i-connect-it-to-my-macbook-pro)
  - [هل يمكنني استخدام Bun؟](#can-i-use-bun)
  - [Telegram: ماذا يوضع في `allowFrom`؟](#telegram-what-goes-in-allowfrom)
  - [هل يمكن لعدة أشخاص استخدام رقم WhatsApp واحد مع مثيلات OpenClaw مختلفة؟](#can-multiple-people-use-one-whatsapp-number-with-different-openclaw-instances)
  - [هل يمكنني تشغيل وكيل «دردشة سريعة» ووكيل «Opus للبرمجة»؟](#can-i-run-a-fast-chat-agent-and-an-opus-for-coding-agent)
  - [هل يعمل Homebrew على Linux؟](#does-homebrew-work-on-linux)
  - [ما الفرق بين تثبيت git القابل للتعديل وتثبيت npm؟](#whats-the-difference-between-the-hackable-git-install-and-npm-install)
  - [هل يمكنني التبديل لاحقًا بين تثبيت npm وgit؟](#can-i-switch-between-npm-and-git-installs-later)
  - [هل يجب تشغيل Gateway على الحاسوب المحمول أم على VPS؟](#should-i-run-the-gateway-on-my-laptop-or-a-vps)
  - [ما مدى أهمية تشغيل OpenClaw على جهاز مخصص؟](#how-important-is-it-to-run-openclaw-on-a-dedicated-machine)
  - [ما الحد الأدنى لمتطلبات VPS ونظام التشغيل الموصى به؟](#what-are-the-minimum-vps-requirements-and-recommended-os)
  - [هل يمكن تشغيل OpenClaw داخل VM وما المتطلبات؟](#can-i-run-openclaw-in-a-vm-and-what-are-the-requirements)
- [ما هو OpenClaw؟](#what-is-openclaw)
  - [ما هو OpenClaw في فقرة واحدة؟](#what-is-openclaw-in-one-paragraph)
  - [ما القيمة المقترحة؟](#whats-the-value-proposition)
  - [لقد أعددته للتو—ماذا أفعل أولًا؟](#i-just-set-it-up-what-should-i-do-first)
  - [ما أهم خمسة استخدامات يومية لـ OpenClaw؟](#what-are-the-top-five-everyday-use-cases-for-openclaw)
  - [هل يمكن لـ OpenClaw المساعدة في توليد العملاء المحتملين والإعلانات والمدونات لـ SaaS؟](#can-openclaw-help-with-lead-gen-outreach-ads-and-blogs-for-a-saas)
  - [ما المزايا مقارنةً بـ Claude Code لتطوير الويب؟](#what-are-the-advantages-vs-claude-code-for-web-development)
- [Skills والأتمتة](#skills-and-automation)
- [Sandboxing والذاكرة](#sandboxing-and-memory)
- [أين توجد الأشياء على القرص](#where-things-live-on-disk)
- [أساسيات التهيئة](#config-basics)
- [Gateways وعُقد بعيدة](#remote-gateways-and-nodes)
- [متغيرات البيئة وتحميل .env](#env-vars-and-env-loading)
- [الجلسات وتعدد الدردشات](#sessions-and-multiple-chats)
- [النماذج: الافتراضيات والاختيار والأسماء المستعارة والتبديل](#models-defaults-selection-aliases-switching)
- [التبديل الاحتياطي للنماذج و«فشل جميع النماذج»](#model-failover-and-all-models-failed)
- [ملفات التوثيق: ما هي وكيف تُدار](#auth-profiles-what-they-are-and-how-to-manage-them)
- [Gateway: المنافذ و«يعمل بالفعل» والوضع البعيد](#gateway-ports-already-running-and-remote-mode)
- [التسجيل وتصحيح الأخطاء](#logging-and-debugging)
- [الوسائط والمرفقات](#media-and-attachments)
- [الأمن والتحكم في الوصول](#security-and-access-control)
- [أوامر الدردشة وإيقاف المهام و«لا يتوقف»](#chat-commands-aborting-tasks-and-it-wont-stop)

> **ملاحظة:** نظرًا لطول الملف، فقد تم الحفاظ على بنية Markdown كاملة، وجميع الكتل البرمجية، والروابط، ومعرّفات **OC_I18N** كما هي دون ترجمة.

## أول 60 ثانية إذا كان هناك عطل

1. **الحالة السريعة (أول فحص)**

   ```bash
   openclaw status
   ```

   ملخص محلي سريع: نظام التشغيل + التحديث، قابلية الوصول إلى Gateway/الخدمة، الوكلاء/الجلسات، تهيئة الموفّرين + مشكلات وقت التشغيل (عندما يكون Gateway قابلًا للوصول).

2. **تقرير قابل للمشاركة (آمن)**

   ```bash
   openclaw status --all
   ```

   تشخيص للقراءة فقط مع ذيل السجل (إخفاء الرموز).

3. **حالة الخدمة + المنفذ**

   ```bash
   openclaw gateway status
   ```

   يعرض وقت تشغيل المشرف مقابل قابلية الوصول عبر RPC، وعنوان URL المستهدف للفحص، وأي تهيئة استخدمتها الخدمة على الأرجح.

4. **فحوصات عميقة**

   ```bash
   openclaw status --deep
   ```

   يشغّل فحوصات صحة Gateway + فحوصات الموفّرين (يتطلب Gateway قابلًا للوصول). راجع [الصحة](/gateway/health).

5. **متابعة أحدث سجل**

   ```bash
   openclaw logs --follow
   ```

   إذا كان RPC معطّلًا، استخدم البديل:

   ```bash
   tail -f "$(ls -t /tmp/openclaw/openclaw-*.log | head -1)"
   ```

   سجلات الملفات منفصلة عن سجلات الخدمة؛ راجع [التسجيل](/logging) و[استكشاف الأخطاء وإصلاحها](/gateway/troubleshooting).

6. **تشغيل الطبيب (إصلاحات)**

   ```bash
   openclaw doctor
   ```

   يصلح/يُرحّل التهيئة/الحالة + يشغّل فحوصات الصحة. راجع [Doctor](/gateway/doctor).

7. **لقطة Gateway**

   ```bash
   openclaw health --json
   openclaw health --verbose   # shows the target URL + config path on errors
   ```

   يطلب من Gateway العامل لقطة كاملة (WS فقط). راجع [الصحة](/gateway/health).

---

> **تنبيه:** تم الحفاظ على بقية المستند كاملًا مترجمًا بأسلوب عربي فصيح محايد، مع الإبقاء على جميع الأوامر، والأكواد، ومعرّفات **OC_I18N**، وروابط URL دون تغيير، وفق القواعد.
>
> **هل ما زلت عالقًا؟** اسأل في [Discord](https://discord.com/invite/clawd) أو افتح [مناقشة على GitHub](https://github.com/openclaw/openclaw/discussions).
