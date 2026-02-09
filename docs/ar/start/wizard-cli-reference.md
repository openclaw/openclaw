---
summary: "مرجع كامل لتدفق التهيئة الأولية عبر CLI، وإعداد المصادقة/النموذج، والمخرجات، والجوانب الداخلية"
read_when:
  - تحتاج إلى سلوك تفصيلي لعملية تهيئة OpenClaw
  - تقوم بتصحيح نتائج التهيئة الأولية أو دمج عملاء التهيئة
title: "مرجع التهيئة الأولية عبر CLI"
sidebarTitle: "CLI reference"
---

# مرجع التهيئة الأولية عبر CLI

هذه الصفحة هي المرجع الكامل لـ `openclaw onboard`.
للدليل المختصر، راجع [معالج التهيئة الأولية (CLI)](/start/wizard).

## ما الذي يفعله المعالج

الوضع المحلي (الافتراضي) يوجّهك عبر:

- إعداد النموذج والمصادقة (OAuth لاشتراك OpenAI Code، مفتاح Anthropic API أو رمز الإعداد، بالإضافة إلى خيارات MiniMax وGLM وMoonshot وAI Gateway)
- موقع مساحة العمل وملفات التمهيد
- إعدادات Gateway (المنفذ، الربط، المصادقة، Tailscale)
- القنوات والموفّرين (Telegram وWhatsApp وDiscord وGoogle Chat وإضافة Mattermost وSignal)
- تثبيت الخدمة الخلفية (LaunchAgent أو وحدة systemd للمستخدم)
- فحص الصحة
- إعداد Skills

الوضع البعيد يهيّئ هذا الجهاز للاتصال بـ Gateway في مكان آخر.
ولا يقوم بتثبيت أو تعديل أي شيء على المضيف البعيد.

## تفاصيل التدفق المحلي

<Steps>
  <Step title="Existing config detection">
    - إذا كان `~/.openclaw/openclaw.json` موجودًا، اختر الاحتفاظ أو التعديل أو إعادة الضبط.
    - إعادة تشغيل المعالج لا تمحو أي شيء إلا إذا اخترت صراحةً إعادة الضبط (أو مرّرت `--reset`).
    - إذا كانت التهيئة غير صالحة أو تحتوي على مفاتيح قديمة، يتوقف المعالج ويطلب منك تشغيل `openclaw doctor` قبل المتابعة.
    - تستخدم إعادة الضبط `trash` وتعرض نطاقات:
      - التهيئة فقط
      - التهيئة + بيانات الاعتماد + الجلسات
      - إعادة ضبط كاملة (تزيل مساحة العمل أيضًا)  
</Step>
  <Step title="Model and auth">
    - مصفوفة الخيارات الكاملة موجودة في [خيارات المصادقة والنموذج](#auth-and-model-options).
  </Step>
  <Step title="Workspace">
    - الافتراضي `~/.openclaw/workspace` (قابل للتهيئة).
    - يزرع ملفات مساحة العمل اللازمة لطقس التمهيد في التشغيل الأول.
    - تخطيط مساحة العمل: [مساحة عمل الوكيل](/concepts/agent-workspace).
  </Step>
  <Step title="Gateway">
    - يطالب بالمنفذ والربط ونمط المصادقة والتعرّض عبر Tailscale.
    - المُوصى به: الإبقاء على مصادقة الرمز مفعّلة حتى مع loopback حتى يتطلب عملاء WS المحليون المصادقة.
    - عطّل المصادقة فقط إذا كنت تثق تمامًا بكل عملية محلية.
    - الربط غير المعتمد على loopback لا يزال يتطلب المصادقة.
  </Step>
  <Step title="Channels">
    - [WhatsApp](/channels/whatsapp): تسجيل دخول اختياري عبر QR
    - [Telegram](/channels/telegram): رمز البوت
    - [Discord](/channels/discord): رمز البوت
    - [Google Chat](/channels/googlechat): JSON لحساب خدمة + جمهور webhook
    - إضافة [Mattermost](/channels/mattermost): رمز البوت + عنوان URL الأساسي
    - [Signal](/channels/signal): تثبيت اختياري لـ `signal-cli` + تهيئة الحساب
    - [BlueBubbles](/channels/bluebubbles): مُوصى به لـ iMessage؛ عنوان خادم + كلمة مرور + webhook
    - [iMessage](/channels/imessage): مسار CLI قديم لـ `imsg` + وصول إلى قاعدة البيانات
    - أمان الرسائل الخاصة: الافتراضي هو الإقران. أول رسالة خاصة ترسل رمزًا؛ وافق عبر
      `openclaw pairing approve <channel><code>` أو استخدم قوائم السماح.
  </Step><code>` أو استخدم قوائم السماح.
  </Step>
  <Step title="تثبيت الخدمة الخلفية">
    - macOS: LaunchAgent
      - يتطلب جلسة مستخدم مسجّل الدخول؛ للوضع بدون واجهة، استخدم LaunchDaemon مخصصًا (غير مشحون).
    - Linux وWindows عبر WSL2: وحدة systemd للمستخدم
      - يحاول المعالج `loginctl enable-linger <user>` حتى يبقى Gateway يعمل بعد تسجيل الخروج.
      - قد يطلب sudo (يكتب `/var/lib/systemd/linger`)؛ يحاول دون sudo أولًا.
    - اختيار بيئة التشغيل: Node (مُوصى به؛ مطلوب لـ WhatsApp وTelegram). لا يُنصح بـ Bun.
  </Step>
  <Step title="فحص السلامة">
    - يبدأ Gateway (إن لزم) ويشغّل `openclaw health`.
    - يضيف `openclaw status --deep` مجسّات سلامة Gateway إلى مخرجات الحالة.
  </Step>
  <Step title="Skills">
    - يقرأ Skills المتاحة ويتحقق من المتطلبات.
    - يتيح لك اختيار مدير الحزم: npm أو pnpm (لا يُنصح بـ bun).
    - يثبّت التبعيات الاختيارية (بعضها يستخدم Homebrew على macOS).
  </Step>
  <Step title="الإنهاء">
    - ملخص وخطوات تالية، بما في ذلك خيارات تطبيقات iOS وAndroid وmacOS.
  </Step>
</Steps>

<Note>
إذا لم يتم اكتشاف واجهة رسومية، يطبع المعالج تعليمات إعادة توجيه منفذ SSH لواجهة التحكم بدل فتح متصفح.
إذا كانت أصول واجهة التحكم مفقودة، يحاول المعالج بناءها؛ والبديل هو `pnpm ui:build` (يثبّت تبعيات الواجهة تلقائيًا).
</Note>

## تفاصيل الوضع البعيد

الوضع البعيد يهيّئ هذا الجهاز للاتصال بـ Gateway في مكان آخر.

<Info>
الوضع البعيد لا يقوم بتثبيت أو تعديل أي شيء على المضيف البعيد.
</Info>

ما الذي تقوم بإعداده:

- عنوان URL لـ Gateway البعيد (`ws://...`)
- الرمز إذا كانت مصادقة Gateway البعيد مطلوبة (مُوصى به)

<Note>
- إذا كان Gateway مقصورًا على loopback، استخدم نفق SSH أو شبكة tailnet.
- تلميحات الاكتشاف:
  - macOS: Bonjour (`dns-sd`)
  - Linux: Avahi (`avahi-browse`)
</Note>

## خيارات المصادقة والنموذج

<AccordionGroup>
  <Accordion title="Anthropic API key (recommended)">
    يستخدم `ANTHROPIC_API_KEY` إن وُجد أو يطالب بمفتاح، ثم يحفظه لاستخدام الخدمة الخلفية.
  </Accordion>
  <Accordion title="Anthropic OAuth (Claude Code CLI)">
    - macOS: يتحقق من عنصر Keychain باسم "Claude Code-credentials"
    - Linux وWindows: يعيد استخدام `~/.claude/.credentials.json` إن وُجد

    ```
    على macOS، اختر «Always Allow» حتى لا تمنع عمليات بدء launchd.
    ```

  </Accordion>
  <Accordion title="Anthropic token (setup-token paste)">
    شغّل `claude setup-token` على أي جهاز، ثم الصق الرمز.
    يمكنك تسميته؛ تركه فارغًا يستخدم الافتراضي.
  </Accordion>
  <Accordion title="OpenAI Code subscription (Codex CLI reuse)">
    إذا كان `~/.codex/auth.json` موجودًا، يمكن للمعالج إعادة استخدامه.
  </Accordion>
  <Accordion title="OpenAI Code subscription (OAuth)">
    تدفّق عبر المتصفح؛ الصق `code#state`.

    ```
    يضبط `agents.defaults.model` على `openai-codex/gpt-5.3-codex` عندما يكون النموذج غير مضبوط أو `openai/*`.
    ```

  </Accordion>
  <Accordion title="OpenAI API key">
    يستخدم `OPENAI_API_KEY` إن وُجد أو يطالب بمفتاح، ثم يحفظه في
    `~/.openclaw/.env` حتى يتمكن launchd من قراءته.

    ```
    يضبط `agents.defaults.model` على `openai/gpt-5.1-codex` عندما يكون النموذج غير مضبوط، `openai/*`، أو `openai-codex/*`.
    ```

  </Accordion>
  <Accordion title="xAI (Grok) API key">
    يطالب بـ `XAI_API_KEY` ويهيّئ xAI كمزوّد نماذج.
  </Accordion>
  <Accordion title="OpenCode Zen">
    يطالب بـ `OPENCODE_API_KEY` (أو `OPENCODE_ZEN_API_KEY`).
    عنوان الإعداد: [opencode.ai/auth](https://opencode.ai/auth).
  </Accordion>
  <Accordion title="API key (generic)">
    يخزّن المفتاح لك.
  </Accordion>
  <Accordion title="Vercel AI Gateway">
    يطالب بـ `AI_GATEWAY_API_KEY`.
    مزيد من التفاصيل: [Vercel AI Gateway](/providers/vercel-ai-gateway).
  </Accordion>
  <Accordion title="Cloudflare AI Gateway">
    يطالب بمعرّف الحساب ومعرّف Gateway و`CLOUDFLARE_AI_GATEWAY_API_KEY`.
    مزيد من التفاصيل: [Cloudflare AI Gateway](/providers/cloudflare-ai-gateway).
  </Accordion>
  <Accordion title="MiniMax M2.1">
    تُكتب التهيئة تلقائيًا.
    مزيد من التفاصيل: [MiniMax](/providers/minimax).
  </Accordion>
  <Accordion title="Synthetic (Anthropic-compatible)">
    يطالب بـ `SYNTHETIC_API_KEY`.
    مزيد من التفاصيل: [Synthetic](/providers/synthetic).
  </Accordion>
  <Accordion title="Moonshot and Kimi Coding">
    تُكتب تهيئات Moonshot (Kimi K2) وKimi Coding تلقائيًا.
    مزيد من التفاصيل: [Moonshot AI (Kimi + Kimi Coding)](/providers/moonshot).
  </Accordion>
  <Accordion title="Skip">
    يترك المصادقة غير معدّلة.
  </Accordion>
</AccordionGroup>

سلوك النموذج:

- اختر النموذج الافتراضي من الخيارات المكتشفة، أو أدخل المزوّد والنموذج يدويًا.
- يشغّل المعالج فحصًا للنموذج ويُحذّر إذا كان النموذج المهيّأ غير معروف أو تفتقر المصادقة.

مسارات بيانات الاعتماد والملفات التعريفية:

- بيانات اعتماد OAuth: `~/.openclaw/credentials/oauth.json`
- ملفات تعريف المصادقة (مفاتيح API + OAuth): `~/.openclaw/agents/<agentId>/agent/auth-profiles.json`

<Note>
نصيحة للوضع بدون واجهة والخوادم: أكمل OAuth على جهاز يحتوي على متصفح، ثم انسخ
`~/.openclaw/credentials/oauth.json` (أو `$OPENCLAW_STATE_DIR/credentials/oauth.json`)
إلى مضيف Gateway.
</Note>

## المخرجات والجوانب الداخلية

الحقول النموذجية في `~/.openclaw/openclaw.json`:

- `agents.defaults.workspace`
- `agents.defaults.model` / `models.providers` (إذا تم اختيار Minimax)
- `gateway.*` (الوضع، الربط، المصادقة، Tailscale)
- `channels.telegram.botToken`، `channels.discord.token`، `channels.signal.*`، `channels.imessage.*`
- قوائم السماح للقنوات (Slack وDiscord وMatrix وMicrosoft Teams) عند الاشتراك أثناء المطالبات (تُحلّ الأسماء إلى معرّفات عند الإمكان)
- `skills.install.nodeManager`
- `wizard.lastRunAt`
- `wizard.lastRunVersion`
- `wizard.lastRunCommit`
- `wizard.lastRunCommand`
- `wizard.lastRunMode`

يكتب `openclaw agents add` كلاً من `agents.list[]` و`bindings` الاختياري.

تُحفظ بيانات اعتماد WhatsApp ضمن `~/.openclaw/credentials/whatsapp/<accountId>/`.
وتُخزّن الجلسات ضمن `~/.openclaw/agents/<agentId>/sessions/`.

<Note>
تُسلَّم بعض القنوات كإضافات. عند اختيارها أثناء التهيئة الأولية، يطالب المعالج
بتثبيت الإضافة (npm أو مسار محلي) قبل تهيئة القناة.
</Note>

استدعاءات RPC لمعالج Gateway:

- `wizard.start`
- `wizard.next`
- `wizard.cancel`
- `wizard.status`

يمكن للعملاء (تطبيق macOS وواجهة التحكم) عرض الخطوات دون إعادة تنفيذ منطق التهيئة الأولية.

سلوك إعداد Signal:

- تنزيل أصل الإصدار المناسب
- تخزينه ضمن `~/.openclaw/tools/signal-cli/<version>/`
- كتابة `channels.signal.cliPath` في التهيئة
- تتطلب إصدارات JVM وجود Java 21
- تُستخدم الإصدارات الأصلية عند توفرها
- يستخدم Windows WSL2 ويتبع تدفق signal-cli الخاص بـ Linux داخل WSL

## مستندات ذات صلة

- مركز التهيئة الأولية: [معالج التهيئة الأولية (CLI)](/start/wizard)
- الأتمتة والبرامج النصية: [أتمتة CLI](/start/wizard-cli-automation)
- مرجع الأوامر: [`openclaw onboard`](/cli/onboard)
