---
summary: "مرجع كامل لمعالج الإعداد عبر CLI: كل خطوة، وكل راية، وكل حقل تهيئة"
read_when:
  - البحث عن خطوة أو راية محددة في المعالج
  - أتمتة أونبواردينج مع الوضع غير التفاعلي
  - تصحيح سلوك المعالج
title: "مرجع معالج التهيئة الأولية"
sidebarTitle: "Wizard Reference"
---

# مرجع معالج التهيئة الأولية

هذا هو المرجع الكامل لمعالج CLI ‏`openclaw onboard`.
للحصول على نظرة عامة عالية المستوى، راجع [Onboarding Wizard](/start/wizard).

## تفاصيل التدفق (الوضع المحلي)

<Steps>
  <Step title="Existing config detection">
    - إذا كان `~/.openclaw/openclaw.json` موجودًا، فاختر **الاحتفاظ / التعديل / إعادة الضبط**.
    - إعادة تشغيل المعالج **لا** تمسح أي شيء ما لم تختر **إعادة الضبط** صراحةً
      (أو تمرّر `--reset`).
    - إذا كانت التهيئة غير صالحة أو تحتوي على مفاتيح قديمة، يتوقف المعالج ويطلب
      منك تشغيل `openclaw doctor` قبل المتابعة.
    - تستخدم إعادة الضبط `trash` (ولا تستخدم أبدًا `rm`) وتعرض نطاقات:
      - التهيئة فقط
      - التهيئة + بيانات الاعتماد + الجلسات
      - إعادة ضبط كاملة (تزيل أيضًا مساحة العمل)  
</Step>
  <Step title="Model/Auth">
    - **مفتاح Anthropic API (موصى به)**: يستخدم `ANTHROPIC_API_KEY` إن وُجد أو يطلب مفتاحًا، ثم يحفظه لاستخدامه من قِبل الـ daemon.
    - **Anthropic OAuth (Claude Code CLI)**: على macOS يتحقق المعالج من عنصر Keychain «Claude Code-credentials» (اختر «Always Allow» كي لا تمنع عمليات بدء launchd)؛ على Linux/Windows يعيد استخدام `~/.claude/.credentials.json` إن وُجد.
    - **رمز Anthropic (لصق setup-token)**: شغّل `claude setup-token` على أي جهاز، ثم الصق الرمز (يمكنك تسميته؛ الفراغ = الافتراضي).
    - **اشتراك OpenAI Code (Codex) (Codex CLI)**: إذا كان `~/.codex/auth.json` موجودًا، يمكن للمعالج إعادة استخدامه.
    - **اشتراك OpenAI Code (Codex) (OAuth)**: تدفّق عبر المتصفح؛ الصق `code#state`.
      - يعيّن `agents.defaults.model` إلى `openai-codex/gpt-5.2` عندما يكون النموذج غير معيّن أو `openai/*`.
    - **مفتاح OpenAI API**: يستخدم `OPENAI_API_KEY` إن وُجد أو يطلب مفتاحًا، ثم يحفظه في `~/.openclaw/.env` ليتمكّن launchd من قراءته.
    - **مفتاح xAI (Grok) API**: يطلب `XAI_API_KEY` ويُهيّئ xAI كموفّر نماذج.
    - **OpenCode Zen (وكيل متعدد النماذج)**: يطلب `OPENCODE_API_KEY` (أو `OPENCODE_ZEN_API_KEY`، احصل عليه من https://opencode.ai/auth).
    - **مفتاح API**: يخزّن المفتاح لك.
    - **Vercel AI Gateway (وكيل متعدد النماذج)**: يطلب `AI_GATEWAY_API_KEY`.
    - مزيد من التفاصيل: [Vercel AI Gateway](/providers/vercel-ai-gateway)
    - **Cloudflare AI Gateway**: يطلب معرّف الحساب، ومعرّف Gateway، و`CLOUDFLARE_AI_GATEWAY_API_KEY`.
    - مزيد من التفاصيل: [Cloudflare AI Gateway](/providers/cloudflare-ai-gateway)
    - **MiniMax M2.1**: تُكتب التهيئة تلقائيًا.
    - مزيد من التفاصيل: [MiniMax](/providers/minimax)
    - **Synthetic (متوافق مع Anthropic)**: يطلب `SYNTHETIC_API_KEY`.
    - مزيد من التفاصيل: [Synthetic](/providers/synthetic)
    - **Moonshot (Kimi K2)**: تُكتب التهيئة تلقائيًا.
    - **Kimi Coding**: تُكتب التهيئة تلقائيًا.
    - مزيد من التفاصيل: [Moonshot AI (Kimi + Kimi Coding)](/providers/moonshot)
    - **تخطي**: لا تتم تهيئة المصادقة بعد.
    - اختر نموذجًا افتراضيًا من الخيارات المكتشفة (أو أدخل الموفّر/النموذج يدويًا).
    - يُجري المعالج فحصًا للنموذج ويُحذّر إذا كان النموذج المُهيّأ غير معروف أو تنقصه المصادقة.
    - تعيش بيانات اعتماد OAuth في `~/.openclaw/credentials/oauth.json`؛ وتعيش ملفات تعريف المصادقة في `~/.openclaw/agents/<agentId>/agent/auth-profiles.json` (مفاتيح API + OAuth).
    - مزيد من التفاصيل: [/concepts/oauth](/concepts/oauth)    
<Note>
    نصيحة للرؤوس/الخوادم: أكمل OAuth على جهاز يحتوي على متصفح، ثم انسخ
    `~/.openclaw/credentials/oauth.json` (أو `$OPENCLAW_STATE_DIR/credentials/oauth.json`) إلى
    مضيف Gateway.
    </Note>
  </Step>
  <Step title="Workspace">
    - الافتراضي `~/.openclaw/workspace` (قابل للتهيئة).
    - يزرع ملفات مساحة العمل اللازمة لطقس تمهيد الوكيل.
    - مخطط مساحة العمل الكامل + دليل النسخ الاحتياطي: [Agent workspace](/concepts/agent-workspace)  
</Step>
  <Step title="Gateway">
    - المنفذ، والربط، ووضع المصادقة، والتعرّض عبر Tailscale.
    - توصية المصادقة: الإبقاء على **Token** حتى مع loopback كي تضطر عملاء WS المحليين إلى المصادقة.
    - عطّل المصادقة فقط إذا كنت تثق تمامًا بكل عملية محلية.
    - الربط غير loopback يتطلب المصادقة أيضًا.
  </Step>
  <Step title="Channels">
    - [WhatsApp](/channels/whatsapp): تسجيل دخول QR اختياري.
    - [Telegram](/channels/telegram): رمز البوت.
    - [Discord](/channels/discord): رمز البوت.
    - [Google Chat](/channels/googlechat): JSON لحساب الخدمة + جمهور webhook.
    - [Mattermost](/channels/mattermost) (ملحق): رمز البوت + عنوان URL الأساسي.
    - [Signal](/channels/signal): تثبيت `signal-cli` اختياري + تهيئة الحساب.
    - [BlueBubbles](/channels/bluebubbles): **موصى به لـ iMessage**؛ عنوان خادم + كلمة مرور + webhook.
    - [iMessage](/channels/imessage): مسار CLI قديم `imsg` + وصول إلى قاعدة البيانات.
    - أمان الرسائل الخاصة (DM): الافتراضي هو الإقران. ترسل أول رسالة خاصة رمزًا؛ وافق عبر `openclaw pairing approve <channel><code>` أو استخدم قوائم السماح.
  </Step><code>` أو استخدم قوائم السماح.
  </Step>
  <Step title="تثبيت الـ daemon">
    - macOS: LaunchAgent
      - يتطلب جلسة مستخدم مسجّل الدخول؛ وللبيئات عديمة الواجهة، استخدم LaunchDaemon مخصصًا (غير مُضمّن).
    - Linux (وWindows عبر WSL2): وحدة systemd للمستخدم
      - يحاول المعالج تمكين الاستمرار عبر `loginctl enable-linger <user>` ليظل Gateway يعمل بعد تسجيل الخروج.
      - قد يطلب sudo (يكتب `/var/lib/systemd/linger`)؛ يحاول بدون sudo أولًا.
    - **اختيار وقت التشغيل:** Node (موصى به؛ مطلوب لـ WhatsApp/Telegram). Bun **غير موصى به**.
  </Step>
  <Step title="فحص الصحة">
    - يبدأ Gateway (إن لزم) ويشغّل `openclaw health`.
    - نصيحة: يضيف `openclaw status --deep` مجسّات صحة Gateway إلى مخرجات الحالة (يتطلب Gateway قابلًا للوصول).
  </Step>
  <Step title="Skills (موصى بها)">
    - يقرأ Skills المتاحة ويتحقق من المتطلبات.
    - يتيح لك اختيار مدير عُقد: **npm / pnpm** (bun غير موصى به).
    - يثبّت تبعيات اختيارية (بعضها يستخدم Homebrew على macOS).
  </Step>
  <Step title="الإنهاء">
    - ملخص + الخطوات التالية، بما في ذلك تطبيقات iOS/Android/macOS لميزات إضافية.
  </Step>
</Steps>

<Note>
إذا لم تُكتشف واجهة رسومية، يطبع المعالج تعليمات إعادة توجيه منفذ SSH لواجهة التحكم بدل فتح متصفح.
إذا كانت أصول واجهة التحكم مفقودة، يحاول المعالج بناءها؛ والبديل هو `pnpm ui:build` (يثبّت تبعيات الواجهة تلقائيًا).
</Note>

## الوضع غير التفاعلي

استخدم `--non-interactive` لأتمتة أو كتابة سكربتات للتهيئة الأولية:

```bash
openclaw onboard --non-interactive \
  --mode local \
  --auth-choice apiKey \
  --anthropic-api-key "$ANTHROPIC_API_KEY" \
  --gateway-port 18789 \
  --gateway-bind loopback \
  --install-daemon \
  --daemon-runtime node \
  --skip-skills
```

أضف `--json` للحصول على ملخص قابل للقراءة آليًا.

<Note>
`--json` **لا** يعني الوضع غير التفاعلي. استخدم `--non-interactive` (و`--workspace`) للسكربتات.
</Note>

<AccordionGroup>
  <Accordion title="Gemini example">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice gemini-api-key \
      --gemini-api-key "$GEMINI_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="Z.AI example">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice zai-api-key \
      --zai-api-key "$ZAI_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="Vercel AI Gateway example">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice ai-gateway-api-key \
      --ai-gateway-api-key "$AI_GATEWAY_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="Cloudflare AI Gateway example">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice cloudflare-ai-gateway-api-key \
      --cloudflare-ai-gateway-account-id "your-account-id" \
      --cloudflare-ai-gateway-gateway-id "your-gateway-id" \
      --cloudflare-ai-gateway-api-key "$CLOUDFLARE_AI_GATEWAY_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="Moonshot example">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice moonshot-api-key \
      --moonshot-api-key "$MOONSHOT_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="Synthetic example">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice synthetic-api-key \
      --synthetic-api-key "$SYNTHETIC_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="OpenCode Zen example">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice opencode-zen \
      --opencode-zen-api-key "$OPENCODE_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
</AccordionGroup>

### إضافة وكيل (غير تفاعلي)

```bash
openclaw agents add work \
  --workspace ~/.openclaw/workspace-work \
  --model openai/gpt-5.2 \
  --bind whatsapp:biz \
  --non-interactive \
  --json
```

## Gateway wizard RPC

يعرِض Gateway تدفّق المعالج عبر RPC (`wizard.start`، `wizard.next`، `wizard.cancel`، `wizard.status`).
يمكن للعملاء (تطبيق macOS، واجهة التحكم) عرض الخطوات دون إعادة تنفيذ منطق التهيئة الأولية.

## إعداد Signal (signal-cli)

يمكن للمعالج تثبيت `signal-cli` من إصدارات GitHub:

- تنزيل أصل الإصدار المناسب.
- تخزينه تحت `~/.openclaw/tools/signal-cli/<version>/`.
- كتابة `channels.signal.cliPath` في التهيئة لديك.

ملاحظات:

- تتطلب إصدارات JVM **Java 21**.
- تُستخدم الإصدارات الأصلية عند توفرها.
- يستخدم Windows ‏WSL2؛ ويتبع تثبيت signal-cli مسار Linux داخل WSL.

## ما الذي يكتبه المعالج

الحقول النموذجية في `~/.openclaw/openclaw.json`:

- `agents.defaults.workspace`
- `agents.defaults.model` / `models.providers` (إذا تم اختيار Minimax)
- `gateway.*` (الوضع، الربط، المصادقة، Tailscale)
- `channels.telegram.botToken`، `channels.discord.token`، `channels.signal.*`، `channels.imessage.*`
- قوائم السماح للقنوات (Slack/Discord/Matrix/Microsoft Teams) عند اختيارك الاشتراك أثناء المطالبات (تتحول الأسماء إلى معرّفات عند الإمكان).
- `skills.install.nodeManager`
- `wizard.lastRunAt`
- `wizard.lastRunVersion`
- `wizard.lastRunCommit`
- `wizard.lastRunCommand`
- `wizard.lastRunMode`

يكتب `openclaw agents add` ‏`agents.list[]` و`bindings` اختياريًا.

تذهب بيانات اعتماد WhatsApp تحت `~/.openclaw/credentials/whatsapp/<accountId>/`.
تُخزَّن الجلسات تحت `~/.openclaw/agents/<agentId>/sessions/`.

تُسلَّم بعض القنوات كملحقات. عند اختيار واحد أثناء التهيئة الأولية، سيطلب المعالج
تثبيته (npm أو مسار محلي) قبل أن يمكن تهيئته.

## مستندات ذات صلة

- نظرة عامة على المعالج: [Onboarding Wizard](/start/wizard)
- تهيئة تطبيق macOS: [Onboarding](/start/onboarding)
- مرجع التهيئة: [Gateway configuration](/gateway/configuration)
- الموفّرون: [WhatsApp](/channels/whatsapp)، [Telegram](/channels/telegram)، [Discord](/channels/discord)، [Google Chat](/channels/googlechat)، [Signal](/channels/signal)، [BlueBubbles](/channels/bluebubbles) (iMessage)، [iMessage](/channels/imessage) (قديم)
- Skills: [Skills](/tools/skills)، [Skills config](/tools/skills-config)
