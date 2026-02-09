---
summary: "عدة الاختبار: مجموعات unit/e2e/live، مشغّلات Docker، وما الذي يغطيه كل اختبار"
read_when:
  - تشغيل الاختبارات محليًا أو في CI
  - إضافة اختبارات انحدار لأخطاء النماذج/الموفّرين
  - تصحيح سلوك Gateway + الوكيل
title: "الاختبار"
---

# الاختبار

يحتوي OpenClaw على ثلاث مجموعات Vitest (unit/integration، وe2e، وlive) إضافةً إلى مجموعة صغيرة من مشغّلات Docker.

هذا المستند هو دليل «كيف نختبر»:

- ما الذي تغطيه كل مجموعة (وما الذي لا تغطيه عمدًا)
- ما هو الأوامر لتشغيل سير العمل المشترك (محلي مسبق، تصحيح)
- كيف تكتشف اختبارات live بيانات الاعتماد وتختار النماذج/الموفّرين
- كيفية إضافة اختبارات انحدار لمشكلات حقيقية في النماذج/الموفّرين

## البدء السريع

في معظم الأيام:

- البوابة الكاملة (متوقعة قبل الدفع): `pnpm build && pnpm check && pnpm test`

عند لمس الاختبارات أو الرغبة في ثقة إضافية:

- بوابة التغطية: `pnpm test:coverage`
- مجموعة E2E: `pnpm test:e2e`

عند تصحيح موفّرين/نماذج حقيقية (يتطلب بيانات اعتماد حقيقية):

- مجموعة Live (النماذج + فحوص أدوات/صور Gateway): `pnpm test:live`

نصيحة: عندما تحتاج حالة فشل واحدة فقط، فضّل تضييق اختبارات live عبر متغيرات البيئة allowlist الموضّحة أدناه.

## مجموعات الاختبار (ما الذي يعمل وأين)

فكّر في المجموعات على أنها «واقعية متزايدة» (ومعها تزايد عدم الاستقرار/التكلفة):

### Unit / integration (الافتراضي)

- الأمر: `pnpm test`
- التهيئة: `vitest.config.ts`
- الملفات: `src/**/*.test.ts`
- النطاق:
  - اختبارات unit خالصة
  - اختبارات تكامل داخل العملية (مصادقة Gateway، التوجيه، الأدوات، التحليل، التهيئة)
  - الانحدارات الوزيرية للأخطاء المعروفة
- التوقعات:
  - تعمل في CI
  - لا تتطلب مفاتيح حقيقية
  - سريعة ومستقرة

### E2E (فحص دخاني للـ gateway)

- الأمر: `pnpm test:e2e`
- التهيئة: `vitest.e2e.config.ts`
- الملفات: `src/**/*.e2e.test.ts`
- النطاق:
  - سلوك end-to-end لعدة مثيلات Gateway
  - واجهات WebSocket/HTTP، إقران العُقد، وشبكات أثقل
- التوقعات:
  - تعمل في CI (عند تمكينها في خط الأنابيب)
  - لا تتطلب مفاتيح حقيقية
  - أجزاء متحركة أكثر من اختبارات unit (قد تكون أبطأ)

### Live (موفّرون حقيقيون + نماذج حقيقية)

- الأمر: `pnpm test:live`
- التهيئة: `vitest.live.config.ts`
- الملفات: `src/**/*.live.test.ts`
- الافتراضي: **مُمكّن** بواسطة `pnpm test:live` (يضبط `OPENCLAW_LIVE_TEST=1`)
- النطاق:
  - «هل يعمل هذا الموفّر/النموذج فعليًا _اليوم_ مع بيانات اعتماد حقيقية؟»
  - التقاط تغييرات تنسيقات الموفّرين، غرائب استدعاء الأدوات، مشكلات المصادقة، وسلوك تحديد المعدّل
- التوقعات:
  - غير مستقر في CI بطبيعته (شبكات حقيقية، سياسات موفّرين حقيقية، حصص، انقطاعات)
  - يكلّف مالًا / يستهلك حدود المعدّل
  - يُفضّل تشغيل مجموعات مضيّقة بدل «كل شيء»
  - ستجلب تشغيلات live `~/.profile` لالتقاط مفاتيح API المفقودة
  - تدوير مفاتيح Anthropic: اضبط `OPENCLAW_LIVE_ANTHROPIC_KEYS="sk-...,sk-..."` (أو `OPENCLAW_LIVE_ANTHROPIC_KEY=sk-...`) أو عدة متغيرات `ANTHROPIC_API_KEY*`؛ ستُعيد الاختبارات المحاولة عند حدود المعدّل

## أي مجموعة يجب أن أركض ؟

استخدم جدول القرار هذا:

- تعديل المنطق/الاختبارات: شغّل `pnpm test` (و`pnpm test:coverage` إذا غيّرت الكثير)
- لمس شبكات Gateway / بروتوكول WS / الإقران: أضف `pnpm test:e2e`
- تصحيح «البوت متوقف» / أعطال خاصة بموفّر / استدعاء الأدوات: شغّل `pnpm test:live` مضيّقًا

## Live: فحص دخاني للنماذج (مفاتيح الملفات التعريفية)

تنقسم اختبارات live إلى طبقتين لعزل الأعطال:

- «النموذج المباشر» يخبرنا إن كان الموفّر/النموذج قادرًا على الإجابة أصلًا بالمفتاح المعطى.
- «فحص Gateway الدخاني» يخبرنا إن كان خط أنابيب Gateway+الوكيل كاملًا يعمل لهذا النموذج (الجلسات، السجل، الأدوات، سياسة sandbox، إلخ).

### الطبقة 1: إكمال مباشر للنموذج (بدون Gateway)

- الاختبار: `src/agents/models.profiles.live.test.ts`
- الهدف:
  - تعداد النماذج المكتشفة
  - استخدام `getApiKeyForModel` لاختيار النماذج التي لديك لها بيانات اعتماد
  - تشغيل إكمال صغير لكل نموذج (واختبارات انحدار مستهدفة عند الحاجة)
- كيفية التمكين:
  - `pnpm test:live` (أو `OPENCLAW_LIVE_TEST=1` عند استدعاء Vitest مباشرة)
- اضبط `OPENCLAW_LIVE_MODELS=modern` (أو `all`، اسم بديل حديث) لتشغيل هذه المجموعة فعليًا؛ وإلا فسيتم تخطيها للحفاظ على تركيز `pnpm test:live` على فحص Gateway الدخاني
- كيفية اختيار النماذج:
  - `OPENCLAW_LIVE_MODELS=modern` لتشغيل allowlist الحديثة (Opus/Sonnet/Haiku 4.5، GPT-5.x + Codex، Gemini 3، GLM 4.7، MiniMax M2.1، Grok 4)
  - `OPENCLAW_LIVE_MODELS=all` اسم بديل لـ allowlist الحديثة
  - أو `OPENCLAW_LIVE_MODELS="openai/gpt-5.2,anthropic/claude-opus-4-6,..."` (allowlist مفصولة بفواصل)
- كيفية اختيار الموفّرين:
  - `OPENCLAW_LIVE_PROVIDERS="google,google-antigravity,google-gemini-cli"` (allowlist مفصولة بفواصل)
- من أين تأتي المفاتيح:
  - بشكل افتراضي: متجر الملفات الشخصية و ردود فعل env
  - اضبط `OPENCLAW_LIVE_REQUIRE_PROFILE_KEYS=1` لفرض **مخزن الملفات التعريفية** فقط
- لماذا يوجد هذا:
  - يفصل «واجهة API الموفّر معطلة / المفتاح غير صالح» عن «خط أنابيب وكيل Gateway معطّل»
  - يحتوي اختبارات انحدار صغيرة ومعزولة (مثال: إعادة تشغيل الاستدلال في OpenAI Responses/Codex Responses + تدفقات استدعاء الأدوات)

### الطبقة 2: Gateway + وكيل التطوير (ما الذي يفعله “@openclaw” فعليًا)

- الاختبار: `src/gateway/gateway-models.profiles.live.test.ts`
- الهدف:
  - تشغيل Gateway داخل العملية
  - إنشاء/تعديل جلسة `agent:dev:*` (تجاوز النموذج لكل تشغيل)
  - الدوران على النماذج ذات المفاتيح والتحقق من:
    - استجابة «ذات معنى» (بدون أدوات)
    - نجاح استدعاء أداة حقيقي (فحص القراءة)
    - فحوص أدوات إضافية اختيارية (تنفيذ+قراءة)
    - بقاء مسارات انحدار OpenAI (أداة فقط → متابعة) تعمل
- تفاصيل الفحوص (لتفسير الأعطال بسرعة):
  - فحص `read`: يكتب الاختبار ملف nonce في مساحة العمل ويطلب من الوكيل `read` قراءته وإرجاع nonce.
  - فحص `exec+read`: يطلب الاختبار من الوكيل `exec`-كتابة nonce في ملف مؤقت، ثم `read` قراءته.
  - فحص الصورة: يرفق الاختبار PNG مُولّدًا (قط + كود عشوائي) ويتوقع أن يُعيد النموذج `cat <CODE>`.
  - مرجع التنفيذ: `src/gateway/gateway-models.profiles.live.test.ts` و`src/gateway/live-image-probe.ts`.
- كيفية التمكين:
  - `pnpm test:live` (أو `OPENCLAW_LIVE_TEST=1` عند استدعاء Vitest مباشرة)
- كيفية اختيار النماذج:
  - الافتراضي: allowlist الحديثة (Opus/Sonnet/Haiku 4.5، GPT-5.x + Codex، Gemini 3، GLM 4.7، MiniMax M2.1، Grok 4)
  - `OPENCLAW_LIVE_GATEWAY_MODELS=all` اسم بديل لـ allowlist الحديثة
  - أو اضبط `OPENCLAW_LIVE_GATEWAY_MODELS="provider/model"` (أو قائمة مفصولة بفواصل) للتضييق
- كيفية اختيار الموفّرين (تجنّب «OpenRouter كل شيء»):
  - `OPENCLAW_LIVE_GATEWAY_PROVIDERS="google,google-antigravity,google-gemini-cli,openai,anthropic,zai,minimax"` (allowlist مفصولة بفواصل)
- فحوص الأدوات + الصور مفعّلة دائمًا في هذا الاختبار الحي:
  - فحص `read` + فحص `exec+read` (إجهاد الأدوات)
  - فحص الصورة يعمل عندما يعلن النموذج دعم إدخال الصور
  - التدفق (عالي المستوى):
    - يولّد الاختبار PNG صغيرًا يحتوي «CAT» + كودًا عشوائيًا (`src/gateway/live-image-probe.ts`)
    - يرسله عبر `agent` `attachments: [{ mimeType: "image/png", content: "<base64>" }]`
    - يحلّل Gateway المرفقات إلى `images[]` (`src/gateway/server-methods/agent.ts` + `src/gateway/chat-attachments.ts`)
    - يمرّر الوكيل المضمّن رسالة مستخدم متعددة الوسائط إلى النموذج
    - التحقق: يحتوي الرد على `cat` + الكود (تحمّل OCR: أخطاء طفيفة مسموحة)

نصيحة: لمعرفة ما يمكنك اختباره على جهازك (ومعرّفات `provider/model` الدقيقة)، شغّل:

```bash
openclaw models list
openclaw models list --json
```

## Live: فحص دخاني لرمز إعداد Anthropic

- الاختبار: `src/agents/anthropic.setup-token.live.test.ts`
- الهدف: التحقق من أن رمز إعداد Claude Code CLI (أو ملف تعريف رمز إعداد ملصق) يمكنه إكمال مطالبة Anthropic.
- التمكين:
  - `pnpm test:live` (أو `OPENCLAW_LIVE_TEST=1` عند استدعاء Vitest مباشرة)
  - `OPENCLAW_LIVE_SETUP_TOKEN=1`
- مصادر الرمز (اختر واحدًا):
  - ملف تعريفي: `OPENCLAW_LIVE_SETUP_TOKEN_PROFILE=anthropic:setup-token-test`
  - رمز خام: `OPENCLAW_LIVE_SETUP_TOKEN_VALUE=sk-ant-oat01-...`
- تجاوز النموذج (اختياري):
  - `OPENCLAW_LIVE_SETUP_TOKEN_MODEL=anthropic/claude-opus-4-6`

مثال إعداد:

```bash
openclaw models auth paste-token --provider anthropic --profile-id anthropic:setup-token-test
OPENCLAW_LIVE_SETUP_TOKEN=1 OPENCLAW_LIVE_SETUP_TOKEN_PROFILE=anthropic:setup-token-test pnpm test:live src/agents/anthropic.setup-token.live.test.ts
```

## Live: فحص دخاني لواجهة CLI الخلفية (Claude Code CLI أو CLIs محلية أخرى)

- الاختبار: `src/gateway/gateway-cli-backend.live.test.ts`
- الهدف: التحقق من خط أنابيب Gateway + الوكيل باستخدام واجهة CLI محلية، دون لمس التهيئة الافتراضية.
- التمكين:
  - `pnpm test:live` (أو `OPENCLAW_LIVE_TEST=1` عند استدعاء Vitest مباشرة)
  - `OPENCLAW_LIVE_CLI_BACKEND=1`
- الافتراضيات:
  - النموذج: `claude-cli/claude-sonnet-4-5`
  - الأمر: `claude`
  - الوسائط: `["-p","--output-format","json","--dangerously-skip-permissions"]`
- التجاوزات (اختياري):
  - `OPENCLAW_LIVE_CLI_BACKEND_MODEL="claude-cli/claude-opus-4-6"`
  - `OPENCLAW_LIVE_CLI_BACKEND_MODEL="codex-cli/gpt-5.3-codex"`
  - `OPENCLAW_LIVE_CLI_BACKEND_COMMAND="/full/path/to/claude"`
  - `OPENCLAW_LIVE_CLI_BACKEND_ARGS='["-p","--output-format","json","--permission-mode","bypassPermissions"]'`
  - `OPENCLAW_LIVE_CLI_BACKEND_CLEAR_ENV='["ANTHROPIC_API_KEY","ANTHROPIC_API_KEY_OLD"]'`
  - `OPENCLAW_LIVE_CLI_BACKEND_IMAGE_PROBE=1` لإرسال مرفق صورة حقيقي (تُحقن المسارات في المطالبة).
  - `OPENCLAW_LIVE_CLI_BACKEND_IMAGE_ARG="--image"` لتمرير مسارات ملفات الصور كوسائط CLI بدل حقن المطالبة.
  - `OPENCLAW_LIVE_CLI_BACKEND_IMAGE_MODE="repeat"` (أو `"list"`) للتحكم في كيفية تمرير وسائط الصور عند ضبط `IMAGE_ARG`.
  - `OPENCLAW_LIVE_CLI_BACKEND_RESUME_PROBE=1` لإرسال دور ثانٍ والتحقق من تدفق الاستئناف.
- `OPENCLAW_LIVE_CLI_BACKEND_DISABLE_MCP_CONFIG=0` للإبقاء على تهيئة MCP لـ Claude Code CLI مفعّلة (الافتراضي يعطّل تهيئة MCP بملف فارغ مؤقت).

مثال:

```bash
OPENCLAW_LIVE_CLI_BACKEND=1 \
  OPENCLAW_LIVE_CLI_BACKEND_MODEL="claude-cli/claude-sonnet-4-5" \
  pnpm test:live src/gateway/gateway-cli-backend.live.test.ts
```

### وصفات live الموصى بها

الـ allowlist المضيّقة والصريحة هي الأسرع والأقل تقلبًا:

- نموذج واحد، مباشر (بدون Gateway):
  - `OPENCLAW_LIVE_MODELS="openai/gpt-5.2" pnpm test:live src/agents/models.profiles.live.test.ts`

- نموذج واحد، فحص Gateway دخاني:
  - `OPENCLAW_LIVE_GATEWAY_MODELS="openai/gpt-5.2" pnpm test:live src/gateway/gateway-models.profiles.live.test.ts`

- استدعاء الأدوات عبر عدة موفّرين:
  - `OPENCLAW_LIVE_GATEWAY_MODELS="openai/gpt-5.2,anthropic/claude-opus-4-6,google/gemini-3-flash-preview,zai/glm-4.7,minimax/minimax-m2.1" pnpm test:live src/gateway/gateway-models.profiles.live.test.ts`

- تركيز Google (مفتاح Gemini API + Antigravity):
  - Gemini (مفتاح API): `OPENCLAW_LIVE_GATEWAY_MODELS="google/gemini-3-flash-preview" pnpm test:live src/gateway/gateway-models.profiles.live.test.ts`
  - Antigravity (OAuth): `OPENCLAW_LIVE_GATEWAY_MODELS="google-antigravity/claude-opus-4-6-thinking,google-antigravity/gemini-3-pro-high" pnpm test:live src/gateway/gateway-models.profiles.live.test.ts`

ملاحظات:

- `google/...` يستخدم Gemini API (مفتاح API).
- `google-antigravity/...` يستخدم جسر OAuth لـ Antigravity (نقطة نهاية وكيل بأسلوب Cloud Code Assist).
- `google-gemini-cli/...` يستخدم Gemini CLI المحلي على جهازك (مصادقة وأدوات منفصلة).
- Gemini API مقابل Gemini CLI:
  - API: يستدعي OpenClaw واجهة Gemini المستضافة من Google عبر HTTP (مفتاح API / مصادقة ملف تعريفي)؛ وهذا ما يقصده معظم المستخدمين بـ «Gemini».
  - CLI: يستدعي OpenClaw ثنائي `gemini` محليًا؛ له مصادقته الخاصة وقد يتصرف بشكل مختلف (بثّ/دعم أدوات/اختلافات إصدار).

## Live: مصفوفة النماذج (ما الذي نغطيه)

لا توجد «قائمة نماذج CI» ثابتة (live اختياري)، لكن هذه هي النماذج **الموصى بها** للتغطية بانتظام على جهاز المطوّر مع مفاتيح.

### مجموعة الفحص الحديثة (استدعاء الأدوات + الصور)

هذا هو تشغيل «النماذج الشائعة» الذي نتوقع استمراره في العمل:

- OpenAI (غير Codex): `openai/gpt-5.2` (اختياري: `openai/gpt-5.1`)
- OpenAI Codex: `openai-codex/gpt-5.3-codex` (اختياري: `openai-codex/gpt-5.3-codex-codex`)
- Anthropic: `anthropic/claude-opus-4-6` (أو `anthropic/claude-sonnet-4-5`)
- Google (Gemini API): `google/gemini-3-pro-preview` و`google/gemini-3-flash-preview` (تجنّب نماذج Gemini 2.x الأقدم)
- Google (Antigravity): `google-antigravity/claude-opus-4-6-thinking` و`google-antigravity/gemini-3-flash`
- Z.AI (GLM): `zai/glm-4.7`
- MiniMax: `minimax/minimax-m2.1`

شغّل فحص Gateway الدخاني مع الأدوات + الصورة:
`OPENCLAW_LIVE_GATEWAY_MODELS="openai/gpt-5.2,openai-codex/gpt-5.3-codex,anthropic/claude-opus-4-6,google/gemini-3-pro-preview,google/gemini-3-flash-preview,google-antigravity/claude-opus-4-6-thinking,google-antigravity/gemini-3-flash,zai/glm-4.7,minimax/minimax-m2.1" pnpm test:live src/gateway/gateway-models.profiles.live.test.ts`

### الأساس: استدعاء الأدوات (قراءة + تنفيذ اختياري)

اختر واحدًا على الأقل لكل عائلة موفّر:

- OpenAI: `openai/gpt-5.2` (أو `openai/gpt-5-mini`)
- Anthropic: `anthropic/claude-opus-4-6` (أو `anthropic/claude-sonnet-4-5`)
- Google: `google/gemini-3-flash-preview` (أو `google/gemini-3-pro-preview`)
- Z.AI (GLM): `zai/glm-4.7`
- MiniMax: `minimax/minimax-m2.1`

تغطية إضافية اختيارية (من اللطيف توفرها):

- xAI: `xai/grok-4` (أو الأحدث المتاح)
- Mistral: `mistral/`… (اختر نموذجًا واحدًا يدعم «tools» ومُفعّلًا لديك)
- Cerebras: `cerebras/`… (إن كان لديك وصول)
- LM Studio: `lmstudio/`… (محلي؛ يعتمد استدعاء الأدوات على وضع API)

### الرؤية: إرسال صورة (مرفق → رسالة متعددة الوسائط)

ضمّن نموذجًا واحدًا على الأقل يدعم الصور في `OPENCLAW_LIVE_GATEWAY_MODELS` (متغيرات Claude/Gemini/OpenAI الداعمة للرؤية، إلخ) لاختبار فحص الصورة. لتمرين مسبار الصورة.

### المجمّعات / البوابات البديلة

إذا كانت لديك مفاتيح مفعّلة، ندعم أيضًا الاختبار عبر:

- OpenRouter: `openrouter/...` (مئات النماذج؛ استخدم `openclaw models scan` للعثور على مرشحين يدعمون الأدوات+الصور)
- OpenCode Zen: `opencode/...` (مصادقة عبر `OPENCODE_API_KEY` / `OPENCODE_ZEN_API_KEY`)

موفّرون إضافيون يمكنك تضمينهم في مصفوفة live (إن كانت لديك بيانات اعتماد/تهيئة):

- مدمجة: `openai`, `openai-codex`, `anthropic`, `google`, `google-vertex`, `google-antigravity`, `google-gemini-cli`, `zai`, `openrouter`, `opencode`, `xai`, `groq`, `cerebras`, `mistral`, `github-copilot`
- عبر `models.providers` (نقاط نهاية مخصّصة): `minimax` (سحابة/API)، إضافةً إلى أي وكيل متوافق مع OpenAI/Anthropic (LM Studio، vLLM، LiteLLM، إلخ)

نصيحة: لا تحاول تثبيت «كل النماذج» في المستندات. القائمة المرجعية هي ما يُعيده `discoverModels(...)` على جهازك + المفاتيح المتاحة.

## بيانات الاعتماد (لا تلتزم بها أبدًا)

تكتشف اختبارات live بيانات الاعتماد بالطريقة نفسها التي يفعلها CLI. الآثار العملية:

- إذا كان CLI يعمل، ينبغي أن تعثر اختبارات live على المفاتيح نفسها.

- إذا قال اختبار live «لا توجد بيانات اعتماد»، فصَحّح بالطريقة نفسها التي تُصحّح بها `openclaw models list` / اختيار النموذج.

- مخزن الملفات التعريفية: `~/.openclaw/credentials/` (مفضّل؛ وهو ما تعنيه «مفاتيح الملف التعريفي» في الاختبارات)

- التهيئة: `~/.openclaw/openclaw.json` (أو `OPENCLAW_CONFIG_PATH`)

إذا أردت الاعتماد على مفاتيح البيئة (مثل المصدّرة في `~/.profile`)، شغّل الاختبارات المحلية بعد `source ~/.profile`، أو استخدم مشغّلات Docker أدناه (يمكنها تحميل `~/.profile` داخل الحاوية).

## Deepgram live (نسخ الصوت)

- الاختبار: `src/media-understanding/providers/deepgram/audio.live.test.ts`
- التمكين: `DEEPGRAM_API_KEY=... DEEPGRAM_LIVE_TEST=1 pnpm test:live src/media-understanding/providers/deepgram/audio.live.test.ts`

## مشغّلات Docker (اختبارات «تعمل على Linux» اختيارية)

تشغّل هذه `pnpm test:live` داخل صورة Docker الخاصة بالمستودع، مع تحميل دليل التهيئة المحلي ومساحة العمل (واستيراد `~/.profile` إذا تم تحميله):

- النماذج المباشرة: `pnpm test:docker:live-models` (السكريبت: `scripts/test-live-models-docker.sh`)
- Gateway + وكيل التطوير: `pnpm test:docker:live-gateway` (السكريبت: `scripts/test-live-gateway-models-docker.sh`)
- معالج التهيئة الأولية (TTY، توليد كامل): `pnpm test:docker:onboard` (السكريبت: `scripts/e2e/onboard-docker.sh`)
- شبكات Gateway (حاويتان، مصادقة WS + الصحة): `pnpm test:docker:gateway-network` (السكريبت: `scripts/e2e/gateway-network-docker.sh`)
- الإضافات (تحميل امتداد مخصّص + فحص السجل): `pnpm test:docker:plugins` (السكريبت: `scripts/e2e/plugins-docker.sh`)

النور المفيد:

- `OPENCLAW_CONFIG_DIR=...` (الافتراضي: `~/.openclaw`) مُحمّل إلى `/home/node/.openclaw`
- `OPENCLAW_WORKSPACE_DIR=...` (الافتراضي: `~/.openclaw/workspace`) مُحمّل إلى `/home/node/.openclaw/workspace`
- `OPENCLAW_PROFILE_FILE=...` (الافتراضي: `~/.profile`) مُحمّل إلى `/home/node/.profile` ومستورَد قبل تشغيل الاختبارات
- `OPENCLAW_LIVE_GATEWAY_MODELS=...` / `OPENCLAW_LIVE_MODELS=...` لتضييق التشغيل
- `OPENCLAW_LIVE_REQUIRE_PROFILE_KEYS=1` لضمان أن تأتي بيانات الاعتماد من مخزن الملفات التعريفية (وليس من البيئة)

## صحة المستندات

شغّل فحوص المستندات بعد تعديلها: `pnpm docs:list`.

## انحدارات دون اتصال (آمنة لـ CI)

هذه «انحدارات خط أنابيب حقيقية» بدون موفّرين حقيقيين:

- استدعاء أدوات Gateway (OpenAI مُحاكَى، حلقة Gateway + وكيل حقيقية): `src/gateway/gateway.tool-calling.mock-openai.test.ts`
- معالج Gateway (WS `wizard.start`/`wizard.next`، يكتب التهيئة ويفرض المصادقة): `src/gateway/gateway.wizard.e2e.test.ts`

## تقييمات موثوقية الوكيل (skills)

لدينا بالفعل بعض الاختبارات الآمنة لـ CI التي تتصرف كـ «تقييمات موثوقية الوكيل»:

- استدعاء أدوات مُحاكَى عبر حلقة Gateway + وكيل حقيقية (`src/gateway/gateway.tool-calling.mock-openai.test.ts`).
- تدفقات معالج end-to-end تتحقق من توصيل الجلسة وتأثيرات التهيئة (`src/gateway/gateway.wizard.e2e.test.ts`).

ما الذي لا يزال مفقودًا للـ skills (انظر [Skills](/tools/skills)):

- **اتخاذ القرار:** عند سرد skills في المطالبة، هل يختار الوكيل skill الصحيحة (أو يتجنب غير ذات الصلة)؟
- **الامتثال:** هل يقرأ الوكيل `SKILL.md` قبل الاستخدام ويتبع الخطوات/الوسائط المطلوبة؟
- **عقود سير العمل:** سيناريوهات متعددة الأدوار تتحقق من ترتيب الأدوات، وترحيل سجل الجلسة، وحدود sandbox.

يجب أن تبقى التقييمات المستقبلية حتمية أولًا:

- مشغّل سيناريوهات يستخدم موفّرين مُحاكَين للتحقق من استدعاءات الأدوات + ترتيبها، وقراءات ملفات skill، وتوصيل الجلسة.
- مجموعة صغيرة من السيناريوهات المركّزة على skills (استخدم مقابل تجنّب، البوابات، حقن المطالبات).
- تقييمات live اختيارية (مفعّلة بالبيئة) فقط بعد توفر المجموعة الآمنة لـ CI.

## إضافة اختبارات انحدار (إرشادات)

عند إصلاح مشكلة موفّر/نموذج اكتُشفت في live:

- أضف اختبار انحدار آمنًا لـ CI إن أمكن (محاكاة/تجريد الموفّر، أو التقاط تحويل شكل الطلب بدقة)
- إذا كانت بطبيعتها live فقط (حدود المعدّل، سياسات المصادقة)، فأبقِ اختبار live ضيقًا ومفعّلًا اختياريًا عبر متغيرات البيئة
- فضّل استهداف أصغر طبقة تلتقط الخطأ:
  - خطأ تحويل/إعادة تشغيل طلب الموفّر → اختبار النماذج المباشرة
  - خطأ خط أنابيب جلسة/سجل/أدوات Gateway → فحص Gateway الحي أو اختبار Gateway مُحاكَى وآمن لـ CI
