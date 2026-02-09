---
summary: "نظرة عامة على موفّري النماذج مع أمثلة تهيئة وتدفّقات CLI"
read_when:
  - تحتاج إلى مرجع لإعداد النماذج حسب كل موفّر
  - تريد أمثلة تهيئة أو أوامر تهيئة أولية عبر CLI لموفّري النماذج
title: "موفّرو النماذج"
---

# موفّرو النماذج

تغطي هذه الصفحة **موفّري نماذج LLM** (وليس قنوات الدردشة مثل WhatsApp/Telegram).
لقواعد اختيار النماذج، راجع [/concepts/models](/concepts/models).

## قواعد سريعة

- مراجع النماذج تستخدم `provider/model` (مثال: `opencode/claude-opus-4-6`).
- إذا قمت بتعيين `agents.defaults.models`، فسيصبح قائمة السماح.
- مساعدات CLI: `openclaw onboard`، `openclaw models list`، `openclaw models set <provider/model>`.

## الموفّرون المدمجون (كتالوج pi-ai)

يأتي OpenClaw مضمّنًا مع كتالوج pi‑ai. لا تتطلب هذه الموفّرات **أي**
تهيئة `models.providers`؛ فقط عيّن المصادقة واختر نموذجًا.

### OpenAI

- الموفّر: `openai`
- المصادقة: `OPENAI_API_KEY`
- نموذج مثال: `openai/gpt-5.1-codex`
- CLI: `openclaw onboard --auth-choice openai-api-key`

```json5
{
  agents: { defaults: { model: { primary: "openai/gpt-5.1-codex" } } },
}
```

### Anthropic

- الموفّر: `anthropic`
- المصادقة: `ANTHROPIC_API_KEY` أو `claude setup-token`
- نموذج مثال: `anthropic/claude-opus-4-6`
- CLI: `openclaw onboard --auth-choice token` (الصق رمز الإعداد) أو `openclaw models auth paste-token --provider anthropic`

```json5
{
  agents: { defaults: { model: { primary: "anthropic/claude-opus-4-6" } } },
}
```

### OpenAI Code (Codex)

- الموفّر: `openai-codex`
- المصادقة: OAuth (ChatGPT)
- نموذج مثال: `openai-codex/gpt-5.3-codex`
- CLI: `openclaw onboard --auth-choice openai-codex` أو `openclaw models auth login --provider openai-codex`

```json5
{
  agents: { defaults: { model: { primary: "openai-codex/gpt-5.3-codex" } } },
}
```

### OpenCode Zen

- الموفّر: `opencode`
- المصادقة: `OPENCODE_API_KEY` (أو `OPENCODE_ZEN_API_KEY`)
- نموذج مثال: `opencode/claude-opus-4-6`
- CLI: `openclaw onboard --auth-choice opencode-zen`

```json5
{
  agents: { defaults: { model: { primary: "opencode/claude-opus-4-6" } } },
}
```

### Google Gemini (مفتاح API)

- الموفّر: `google`
- المصادقة: `GEMINI_API_KEY`
- نموذج مثال: `google/gemini-3-pro-preview`
- CLI: `openclaw onboard --auth-choice gemini-api-key`

### Google Vertex وAntigravity وGemini CLI

- الموفّرون: `google-vertex`، `google-antigravity`، `google-gemini-cli`
- المصادقة: يستخدم Vertex بيانات اعتماد gcloud ADC؛ ويستخدم Antigravity/Gemini CLI تدفّقات المصادقة الخاصة بكل منهما
- يتم شحن OAuth الخاص بـ Antigravity كإضافة مدمجة (`google-antigravity-auth`، معطّلة افتراضيًا).
  - التمكين: `openclaw plugins enable google-antigravity-auth`
  - تسجيل الدخول: `openclaw models auth login --provider google-antigravity --set-default`
- يتم شحن OAuth الخاص بـ Gemini CLI كإضافة مدمجة (`google-gemini-cli-auth`، معطّلة افتراضيًا).
  - التمكين: `openclaw plugins enable google-gemini-cli-auth`
  - تسجيل الدخول: `openclaw models auth login --provider google-gemini-cli --set-default`
  - ملاحظة: **لا** تقوم بلصق معرّف العميل أو السر في `openclaw.json`. يقوم تدفّق تسجيل الدخول عبر CLI
    بتخزين الرموز في ملفات تعريف المصادقة على مضيف Gateway.

### Z.AI (GLM)

- الموفّر: `zai`
- المصادقة: `ZAI_API_KEY`
- نموذج مثال: `zai/glm-4.7`
- CLI: `openclaw onboard --auth-choice zai-api-key`
  - الأسماء المستعارة: `z.ai/*` و`z-ai/*` يتم تطبيعهما إلى `zai/*`

### Vercel AI Gateway

- الموفّر: `vercel-ai-gateway`
- المصادقة: `AI_GATEWAY_API_KEY`
- نموذج مثال: `vercel-ai-gateway/anthropic/claude-opus-4.6`
- CLI: `openclaw onboard --auth-choice ai-gateway-api-key`

### موفّرون مدمجون آخرون

- OpenRouter: `openrouter` (`OPENROUTER_API_KEY`)
- نموذج مثال: `openrouter/anthropic/claude-sonnet-4-5`
- xAI: `xai` (`XAI_API_KEY`)
- Groq: `groq` (`GROQ_API_KEY`)
- Cerebras: `cerebras` (`CEREBRAS_API_KEY`)
  - نماذج GLM على Cerebras تستخدم المعرّفات `zai-glm-4.7` و`zai-glm-4.6`.
  - عنوان URL أساسي متوافق مع OpenAI: `https://api.cerebras.ai/v1`.
- Mistral: `mistral` (`MISTRAL_API_KEY`)
- GitHub Copilot: `github-copilot` (`COPILOT_GITHUB_TOKEN` / `GH_TOKEN` / `GITHUB_TOKEN`)

## موفّرون عبر `models.providers` (عنوان URL مخصّص/أساسي)

استخدم `models.providers` (أو `models.json`) لإضافة موفّرين **مخصّصين**
أو وسطاء متوافقين مع OpenAI/Anthropic.

### Moonshot AI (Kimi)

يستخدم Moonshot نقاط نهاية متوافقة مع OpenAI، لذا قم بتهيئته كموفّر مخصّص:

- الموفّر: `moonshot`
- المصادقة: `MOONSHOT_API_KEY`
- نموذج مثال: `moonshot/kimi-k2.5`

معرّفات نماذج Kimi K2:

{/_moonshot-kimi-k2-model-refs:start_/ && null}

- `moonshot/kimi-k2.5`
- `moonshot/kimi-k2-0905-preview`
- `moonshot/kimi-k2-turbo-preview`
- `moonshot/kimi-k2-thinking`
- `moonshot/kimi-k2-thinking-turbo`
  {/_moonshot-kimi-k2-model-refs:end_/ && null}

```json5
{
  agents: {
    defaults: { model: { primary: "moonshot/kimi-k2.5" } },
  },
  models: {
    mode: "merge",
    providers: {
      moonshot: {
        baseUrl: "https://api.moonshot.ai/v1",
        apiKey: "${MOONSHOT_API_KEY}",
        api: "openai-completions",
        models: [{ id: "kimi-k2.5", name: "Kimi K2.5" }],
      },
    },
  },
}
```

### Kimi Coding

يستخدم Kimi Coding نقطة نهاية Moonshot AI المتوافقة مع Anthropic:

- الموفّر: `kimi-coding`
- المصادقة: `KIMI_API_KEY`
- نموذج مثال: `kimi-coding/k2p5`

```json5
{
  env: { KIMI_API_KEY: "sk-..." },
  agents: {
    defaults: { model: { primary: "kimi-coding/k2p5" } },
  },
}
```

### Qwen OAuth (الطبقة المجانية)

يوفّر Qwen وصول OAuth إلى Qwen Coder وVision عبر تدفّق رمز الجهاز.
قم بتمكين الإضافة المدمجة، ثم سجّل الدخول:

```bash
openclaw plugins enable qwen-portal-auth
openclaw models auth login --provider qwen-portal --set-default
```

مراجع النماذج:

- `qwen-portal/coder-model`
- `qwen-portal/vision-model`

راجع [/providers/qwen](/providers/qwen) لتفاصيل الإعداد والملاحظات.

### Synthetic

يوفّر Synthetic نماذج متوافقة مع Anthropic خلف موفّر `synthetic`:

- الموفّر: `synthetic`
- المصادقة: `SYNTHETIC_API_KEY`
- نموذج مثال: `synthetic/hf:MiniMaxAI/MiniMax-M2.1`
- CLI: `openclaw onboard --auth-choice synthetic-api-key`

```json5
{
  agents: {
    defaults: { model: { primary: "synthetic/hf:MiniMaxAI/MiniMax-M2.1" } },
  },
  models: {
    mode: "merge",
    providers: {
      synthetic: {
        baseUrl: "https://api.synthetic.new/anthropic",
        apiKey: "${SYNTHETIC_API_KEY}",
        api: "anthropic-messages",
        models: [{ id: "hf:MiniMaxAI/MiniMax-M2.1", name: "MiniMax M2.1" }],
      },
    },
  },
}
```

### MiniMax

يتم تهيئة MiniMax عبر `models.providers` لأنه يستخدم نقاط نهاية مخصّصة:

- MiniMax (متوافق مع Anthropic): `--auth-choice minimax-api`
- المصادقة: `MINIMAX_API_KEY`

راجع [/providers/minimax](/providers/minimax) لتفاصيل الإعداد وخيارات النماذج ومقتطفات التهيئة.

### Ollama

Ollama هو وقت تشغيل LLM محلي يوفّر واجهة برمجة تطبيقات متوافقة مع OpenAI:

- الموفّر: `ollama`
- المصادقة: غير مطلوبة (خادم محلي)
- نموذج مثال: `ollama/llama3.3`
- التثبيت: [https://ollama.ai](https://ollama.ai)

```bash
# Install Ollama, then pull a model:
ollama pull llama3.3
```

```json5
{
  agents: {
    defaults: { model: { primary: "ollama/llama3.3" } },
  },
}
```

يتم اكتشاف Ollama تلقائيًا عند التشغيل محليًا على `http://127.0.0.1:11434/v1`. راجع [/providers/ollama](/providers/ollama) لتوصيات النماذج والتهيئة المخصّصة.

### الوسطاء المحليون (LM Studio، vLLM، LiteLLM، إلخ)

مثال (متوافق مع OpenAI):

```json5
{
  agents: {
    defaults: {
      model: { primary: "lmstudio/minimax-m2.1-gs32" },
      models: { "lmstudio/minimax-m2.1-gs32": { alias: "Minimax" } },
    },
  },
  models: {
    providers: {
      lmstudio: {
        baseUrl: "http://localhost:1234/v1",
        apiKey: "LMSTUDIO_KEY",
        api: "openai-completions",
        models: [
          {
            id: "minimax-m2.1-gs32",
            name: "MiniMax M2.1",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 200000,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
}
```

ملاحظات:

- بالنسبة للموفّرين المخصّصين، فإن `reasoning` و`input` و`cost` و`contextWindow` و`maxTokens` اختيارية.
  عند الإغفال، يستخدم OpenClaw القيم الافتراضية:
  - `reasoning: false`
  - `input: ["text"]`
  - `cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }`
  - `contextWindow: 200000`
  - `maxTokens: 8192`
- موصى به: تعيين قيم صريحة تتوافق مع حدود الوكيل/النموذج لديك.

## أمثلة CLI

```bash
openclaw onboard --auth-choice opencode-zen
openclaw models set opencode/claude-opus-4-6
openclaw models list
```

انظر أيضًا: [/gateway/configuration](/gateway/configuration) لأمثلة تهيئة كاملة.
