---
summary: "OpenClaw (macOS ایپ) کے لیے پہلی بار چلانے کا آن بورڈنگ فلو"
read_when:
  - macOS آن بورڈنگ اسسٹنٹ ڈیزائن کرتے وقت
  - تصدیق یا شناخت کے سیٹ اپ کو نافذ کرتے وقت
title: "آن بورڈنگ (macOS ایپ)"
sidebarTitle: "Onboarding: macOS App"
x-i18n:
  source_path: start/onboarding.md
  source_hash: 45f912067527158f
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:47:42Z
---

# آن بورڈنگ (macOS ایپ)

یہ دستاویز **موجودہ** پہلی بار چلانے کے آن بورڈنگ فلو کی وضاحت کرتی ہے۔ مقصد ایک
ہموار “دن 0” تجربہ ہے: یہ منتخب کرنا کہ Gateway کہاں چلے گا، تصدیق کو جوڑنا،
وزرڈ چلانا، اور ایجنٹ کو خود کو بوٹسٹرَیپ کرنے دینا۔

<Steps>
<Step title="macOS انتباہ کی منظوری دیں">
<Frame>
<img src="/assets/macos-onboarding/01-macos-warning.jpeg" alt="" />
</Frame>
</Step>
<Step title="مقامی نیٹ ورکس تلاش کرنے کی منظوری دیں">
<Frame>
<img src="/assets/macos-onboarding/02-local-networks.jpeg" alt="" />
</Frame>
</Step>
<Step title="خوش آمدید اور سکیورٹی نوٹس">
<Frame caption="نمایاں کیے گئے سکیورٹی نوٹس کو پڑھیں اور اسی کے مطابق فیصلہ کریں">
<img src="/assets/macos-onboarding/03-security-notice.png" alt="" />
</Frame>
</Step>
<Step title="لوکل بمقابلہ ریموٹ">
<Frame>
<img src="/assets/macos-onboarding/04-choose-gateway.png" alt="" />
</Frame>

**Gateway** کہاں چلتا ہے؟

- **یہ میک (صرف لوکل):** آن بورڈنگ OAuth فلو چلا سکتی ہے اور اسناد کو
  مقامی طور پر لکھ سکتی ہے۔
- **ریموت (SSH/Tailnet کے ذریعے):** آن بورڈنگ مقامی طور پر OAuth نہیں چلاتی؛
  اسناد گیٹ وے ہوسٹ پر موجود ہونی چاہئیں۔
- **بعد میں کنفیگر کریں:** سیٹ اپ چھوڑ دیں اور ایپ کو غیر کنفیگر شدہ رہنے دیں۔

<Tip>
**Gateway تصدیق کا مشورہ:**
- وزرڈ اب loopback کے لیے بھی **ٹوکَن** بناتا ہے، اس لیے مقامی WS کلائنٹس کو تصدیق کرنی ہوگی۔
- اگر آپ تصدیق کو غیر فعال کرتے ہیں تو کوئی بھی مقامی عمل کنیکٹ ہو سکتا ہے؛ اسے صرف مکمل طور پر قابلِ اعتماد مشینوں پر استعمال کریں۔
- کثیر مشین رسائی یا non‑loopback بائنڈز کے لیے **ٹوکَن** استعمال کریں۔
</Tip>
</Step>
<Step title="اجازتیں">
<Frame caption="منتخب کریں کہ آپ OpenClaw کو کون سی اجازتیں دینا چاہتے ہیں">
<img src="/assets/macos-onboarding/05-permissions.png" alt="" />
</Frame>

آن بورڈنگ درج ذیل کے لیے درکار TCC اجازتیں مانگتی ہے:

- آٹومیشن (AppleScript)
- اطلاعات
- رسائی پذیری
- اسکرین ریکارڈنگ
- مائیکروفون
- اسپیچ ریکگنیشن
- کیمرا
- مقام

</Step>
<Step title="CLI">
  <Info>یہ مرحلہ اختیاری ہے</Info>
  ایپ npm/pnpm کے ذریعے عالمی `openclaw` CLI انسٹال کر سکتی ہے تاکہ ٹرمینل
  ورک فلو اور launchd ٹاسکس بطورِ طے شدہ درست طور پر کام کریں۔
</Step>
<Step title="آن بورڈنگ چیٹ (مخصوص سیشن)">
  سیٹ اپ کے بعد، ایپ ایک مخصوص آن بورڈنگ چیٹ سیشن کھولتی ہے تاکہ ایجنٹ
  اپنا تعارف کروا سکے اور اگلے اقدامات کی رہنمائی کرے۔ اس سے پہلی بار کی رہنمائی
  آپ کی معمول کی گفتگو سے الگ رہتی ہے۔ گیٹ وے ہوسٹ پر پہلی ایجنٹ رَن کے دوران
  کیا ہوتا ہے، اس کے لیے [Bootstrapping](/start/bootstrapping) دیکھیں۔
</Step>
</Steps>
