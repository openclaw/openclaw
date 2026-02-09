---
summary: "OpenClaw (macOS ایپ) کے لیے پہلی بار چلانے کا آن بورڈنگ فلو"
read_when:
  - macOS آن بورڈنگ اسسٹنٹ ڈیزائن کرتے وقت
  - تصدیق یا شناخت کے سیٹ اپ کو نافذ کرتے وقت
title: "آن بورڈنگ (macOS ایپ)"
sidebarTitle: "Onboarding: macOS App"
---

# آن بورڈنگ (macOS ایپ)

یہ دستاویز **موجودہ** فرسٹ‑رن آن بورڈنگ فلو کی وضاحت کرتی ہے۔ مقصد ایک ہموار “ڈے 0” تجربہ ہے: یہ منتخب کریں کہ گیٹ وے کہاں چلے گا، آتھنٹیکیشن جوڑیں، وزارڈ چلائیں، اور ایجنٹ کو خود کو بوٹ اسٹرَیپ کرنے دیں۔

<Steps>
<Step title="Approve macOS warning">
<Frame>
<img src="/assets/macos-onboarding/01-macos-warning.jpeg" alt="" />
</Frame>
</Step>
<Step title="Approve find local networks">
<Frame>
<img src="/assets/macos-onboarding/02-local-networks.jpeg" alt="" />
</Frame>
</Step>
<Step title="Welcome and security notice">
<Frame caption="نمایاں کیے گئے سکیورٹی نوٹس کو پڑھیں اور اسی کے مطابق فیصلہ کریں">
<img src="/assets/macos-onboarding/03-security-notice.png" alt="" />
</Frame>
</Step>
<Step title="Local vs Remote">
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
**گیٹ وے آتھنٹیکیشن ٹِپ:**
- وزارڈ اب لوپ بیک کے لیے بھی ایک **ٹوکَن** بناتا ہے، اس لیے لوکل WS کلائنٹس کو آتھنٹیکیٹ کرنا ضروری ہے۔
- اگر آپ آتھنٹیکیشن غیر فعال کریں، تو کوئی بھی لوکل پراسس کنیکٹ کر سکتا ہے؛ اسے صرف مکمل طور پر قابلِ اعتماد مشینوں پر استعمال کریں۔
- ملٹی‑مشین رسائی یا نان‑لوپ بیک بائنڈز کے لیے **ٹوکَن** استعمال کریں۔
</Tip>
</Step>
<Step title="Permissions">
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
<Step title="Onboarding Chat (dedicated session)">
  سیٹ اپ کے بعد، ایپ ایک مخصوص آن بورڈنگ چیٹ سیشن کھولتی ہے تاکہ ایجنٹ اپنا تعارف کرا سکے اور اگلے مراحل کی رہنمائی کرے۔ اس سے فرسٹ‑رن کی رہنمائی آپ کی عام گفتگو سے الگ رہتی ہے۔ دیکھیں [Bootstrapping](/start/bootstrapping) تاکہ معلوم ہو کہ پہلی ایجنٹ رن کے دوران گیٹ وے ہوسٹ پر کیا ہوتا ہے۔
</Step>
</Steps>
