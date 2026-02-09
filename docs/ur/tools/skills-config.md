---
summary: "Skills کنفیگ اسکیما اور مثالیں"
read_when:
  - Skills کنفیگ شامل یا ترمیم کرتے وقت
  - بنڈلڈ allowlist یا انسٹال رویّے میں ردوبدل کرتے وقت
title: "Skills کنفیگ"
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

- `allowBundled`: صرف **بنڈلڈ** اسکلز کے لیے اختیاری الاؤ لسٹ۔ جب سیٹ ہو، تو صرف
  فہرست میں موجود بنڈلڈ اسکلز اہل ہوں گی (منیجڈ/ورک اسپیس اسکلز متاثر نہیں ہوتیں)۔
- `load.extraDirs`: اسکین کرنے کے لیے اضافی Skill ڈائریکٹریاں (کم ترین ترجیح)۔
- `load.watch`: Skill فولڈرز کو مانیٹر کریں اور Skills اسنیپ شاٹ ریفریش کریں (بطورِ طے شدہ: true)۔
- `load.watchDebounceMs`: Skill واچر ایونٹس کے لیے ڈی باؤنس (ملی سیکنڈ میں) (بطورِ طے شدہ: 250)۔
- `install.preferBrew`: دستیاب ہونے پر brew انسٹالرز کو ترجیح دیں (بطورِ طے شدہ: true)۔
- `install.nodeManager`: نوڈ انسٹالر کی ترجیح (`npm` | `pnpm` | `yarn` | `bun`، ڈیفالٹ: npm)۔
  یہ صرف **اسکل انسٹالز** کو متاثر کرتا ہے؛ گیٹ وے رن ٹائم پھر بھی Node ہونا چاہیے
  (WhatsApp/Telegram کے لیے Bun کی سفارش نہیں کی جاتی)۔
- \`entries.<skillKey>\`\`: ہر اسکل کے لیے اووررائیڈز۔

فی-Skill فیلڈز:

- `enabled`: `false` سیٹ کریں تاکہ Skill کو غیر فعال کیا جا سکے چاہے وہ بنڈلڈ/انسٹالڈ ہو۔
- `env`: ایجنٹ رن کے لیے انجیکٹ کیے گئے ماحولیاتی متغیرات (صرف اس صورت میں جب پہلے سے سیٹ نہ ہوں)۔
- `apiKey`: ان Skills کے لیے اختیاری سہولت جو ایک بنیادی env var ڈیکلیئر کرتی ہیں۔

## Notes

- `entries` کے تحت موجود کیز ڈیفالٹ طور پر اسکل کے نام سے میپ ہوتی ہیں۔ اگر کوئی اسکل
  `metadata.openclaw.skillKey` ڈیفائن کرے، تو اسی کی کو استعمال کریں۔
- جب واچر فعال ہو تو Skills میں تبدیلیاں اگلی ایجنٹ ٹرن پر نافذ ہو جاتی ہیں۔

### Sandboxed Skills + env vars

جب کوئی سیشن **سینڈ باکسڈ** ہو، تو اسکل پروسیسز Docker کے اندر چلتے ہیں۔ سینڈ باکس
ہوسٹ `process.env` کو **وراثت میں نہیں لیتا**۔

درج ذیل میں سے ایک استعمال کریں:

- `agents.defaults.sandbox.docker.env` (یا فی-ایجنٹ `agents.list[].sandbox.docker.env`)
- env کو اپنی کسٹم sandbox امیج میں بیک کریں

گلوبل `env` اور `skills.entries.<skill>``.env/apiKey` صرف **ہوسٹ** رنز پر لاگو ہوتے ہیں۔
