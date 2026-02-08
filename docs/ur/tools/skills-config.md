---
summary: "Skills کنفیگ اسکیما اور مثالیں"
read_when:
  - Skills کنفیگ شامل یا ترمیم کرتے وقت
  - بنڈلڈ allowlist یا انسٹال رویّے میں ردوبدل کرتے وقت
title: "Skills کنفیگ"
x-i18n:
  source_path: tools/skills-config.md
  source_hash: e265c93da7856887
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:47:44Z
---

# Skills کنفیگ

Skills سے متعلق تمام کنفیگریشن `skills` کے تحت `~/.openclaw/openclaw.json` میں موجود ہوتی ہے۔

```json5
{
  skills: {
    allowBundled: ["gemini", "peekaboo"],
    load: {
      extraDirs: ["~/Projects/agent-scripts/skills", "~/Projects/oss/some-skill-pack/skills"],
      watch: true,
      watchDebounceMs: 250,
    },
    install: {
      preferBrew: true,
      nodeManager: "npm", // npm | pnpm | yarn | bun (Gateway runtime still Node; bun not recommended)
    },
    entries: {
      "nano-banana-pro": {
        enabled: true,
        apiKey: "GEMINI_KEY_HERE",
        env: {
          GEMINI_API_KEY: "GEMINI_KEY_HERE",
        },
      },
      peekaboo: { enabled: true },
      sag: { enabled: false },
    },
  },
}
```

## Fields

- `allowBundled`: صرف **بنڈلڈ** Skills کے لیے اختیاری allowlist۔ جب یہ سیٹ ہو تو
  فہرست میں موجود بنڈلڈ Skills ہی اہل ہوتی ہیں (managed/workspace Skills متاثر نہیں ہوتیں)۔
- `load.extraDirs`: اسکین کرنے کے لیے اضافی Skill ڈائریکٹریاں (کم ترین ترجیح)۔
- `load.watch`: Skill فولڈرز کو مانیٹر کریں اور Skills اسنیپ شاٹ ریفریش کریں (بطورِ طے شدہ: true)۔
- `load.watchDebounceMs`: Skill واچر ایونٹس کے لیے ڈی باؤنس (ملی سیکنڈ میں) (بطورِ طے شدہ: 250)۔
- `install.preferBrew`: دستیاب ہونے پر brew انسٹالرز کو ترجیح دیں (بطورِ طے شدہ: true)۔
- `install.nodeManager`: Node انسٹالر کی ترجیح (`npm` | `pnpm` | `yarn` | `bun`، بطورِ طے شدہ: npm)۔
  یہ صرف **Skill انسٹالز** پر اثر انداز ہوتا ہے؛ Gateway رن ٹائم اب بھی Node ہونا چاہیے
  (WhatsApp/Telegram کے لیے Bun تجویز نہیں کیا جاتا)۔
- `entries.<skillKey>`: فی-Skill اووررائیڈز۔

فی-Skill فیلڈز:

- `enabled`: `false` سیٹ کریں تاکہ Skill کو غیر فعال کیا جا سکے چاہے وہ بنڈلڈ/انسٹالڈ ہو۔
- `env`: ایجنٹ رن کے لیے انجیکٹ کیے گئے ماحولیاتی متغیرات (صرف اس صورت میں جب پہلے سے سیٹ نہ ہوں)۔
- `apiKey`: ان Skills کے لیے اختیاری سہولت جو ایک بنیادی env var ڈیکلیئر کرتی ہیں۔

## Notes

- `entries` کے تحت کیز بطورِ طے شدہ Skill کے نام سے میپ ہوتی ہیں۔ اگر کوئی Skill
  `metadata.openclaw.skillKey` ڈیفائن کرتی ہے تو اس کے بجائے وہی کی استعمال کریں۔
- جب واچر فعال ہو تو Skills میں تبدیلیاں اگلی ایجنٹ ٹرن پر نافذ ہو جاتی ہیں۔

### Sandboxed Skills + env vars

جب کوئی سیشن **sandboxed** ہو، تو Skill پراسیسز Docker کے اندر چلتے ہیں۔ Sandbox
ہوسٹ کے `process.env` کو وراثت میں **نہیں** لیتا۔

درج ذیل میں سے ایک استعمال کریں:

- `agents.defaults.sandbox.docker.env` (یا فی-ایجنٹ `agents.list[].sandbox.docker.env`)
- env کو اپنی کسٹم sandbox امیج میں بیک کریں

عالمی `env` اور `skills.entries.<skill>.env/apiKey` صرف **ہوسٹ** رنز پر لاگو ہوتے ہیں۔
