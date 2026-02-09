---
summary: "ویک ورڈ اور پُش ٹو ٹاک کے اوورلیپ ہونے پر وائس اوورلے کا لائف سائیکل"
read_when:
  - وائس اوورلے کے رویّے کو ایڈجسٹ کرتے وقت
title: "وائس اوورلے"
---

# وائس اوورلے لائف سائیکل (macOS)

Audience: macOS ایپ کے معاونین۔ Goal: keep the voice overlay predictable when wake-word and push-to-talk overlap.

## موجودہ نیت

- If the overlay is already visible from wake-word and the user presses the hotkey, the hotkey session _adopts_ the existing text instead of resetting it. ہاٹ کی دبائے رکھنے تک اوورلے دکھائی دیتا رہتا ہے۔ جب صارف چھوڑتا ہے: اگر تراشا ہوا متن موجود ہو تو بھیجیں، ورنہ dismiss کریں۔
- صرف ویک ورڈ ہونے پر خاموشی کے بعد خودکار بھیج دیا جاتا ہے؛ پُش ٹو ٹاک چھوڑنے پر فوراً بھیج دیتا ہے۔

## نافذ شدہ (9 دسمبر 2025)

- اوورلے سیشنز اب ہر کیپچر (wake-word یا push-to-talk) کے لیے ایک ٹوکن رکھتے ہیں۔ جب ٹوکن میچ نہ کرے تو partial/final/send/dismiss/level اپڈیٹس کو ڈراپ کر دیا جاتا ہے، جس سے پرانے callbacks سے بچاؤ ہوتا ہے۔
- Push-to-talk کسی بھی نظر آنے والے اوورلے متن کو بطور prefix اپنا لیتا ہے (لہٰذا جب wake اوورلے موجود ہو اور ہاٹ کی دبائی جائے تو متن برقرار رہتا ہے اور نئی گفتار شامل ہو جاتی ہے)۔ یہ فائنل ٹرانسکرپٹ کے لیے 1.5s تک انتظار کرتا ہے، ورنہ موجودہ متن پر واپس آ جاتا ہے۔
- چائم/اوورلے لاگنگ `info` پر زمروں `voicewake.overlay`، `voicewake.ptt`، اور `voicewake.chime` میں خارج کی جاتی ہے (سیشن آغاز، جزوی، حتمی، بھیجیں، برخاست، چائم کی وجہ)۔

## اگلے اقدامات

1. **VoiceSessionCoordinator (actor)**
   - ایک وقت میں بالکل ایک `VoiceSession` کی ملکیت رکھتا ہے۔
   - API (ٹوکن پر مبنی): `beginWakeCapture`، `beginPushToTalk`، `updatePartial`، `endCapture`، `cancel`، `applyCooldown`۔
   - باسی ٹوکن لے جانے والی کال بیکس کو چھوڑ دیتا ہے (پرانے ریکگنائزرز کے ذریعے اوورلے کے دوبارہ کھلنے سے بچاؤ)۔
2. **VoiceSession (ماڈل)**
   - فیلڈز: `token`، `source` (wakeWord|pushToTalk)، committed/volatile متن، چائم فلیگز، ٹائمرز (خودکار بھیجنا، آئیڈل)، `overlayMode` (display|editing|sending)، کول ڈاؤن ڈیڈ لائن۔
3. **اوورلے بائنڈنگ**
   - `VoiceSessionPublisher` (`ObservableObject`) فعال سیشن کو SwiftUI میں عکس بند کرتا ہے۔
   - `VoiceWakeOverlayView` صرف پبلشر کے ذریعے رینڈر کرتا ہے؛ یہ کبھی براہِ راست گلوبل سنگل ٹنز میں ترمیم نہیں کرتا۔
   - اوورلے کی صارف کارروائیاں (`sendNow`، `dismiss`، `edit`) سیشن ٹوکن کے ساتھ کوآرڈینیٹر کو کال بیک کرتی ہیں۔
4. **یکجا بھیجنے کا راستہ**
   - `endCapture` پر: اگر کٹا ہوا متن خالی ہو → برخاست؛ ورنہ `performSend(session:)` (بھیجنے کا چائم ایک بار چلاتا ہے، آگے بھیجتا ہے، برخاست کرتا ہے)۔
   - پُش ٹو ٹاک: کوئی تاخیر نہیں؛ ویک ورڈ: خودکار بھیجنے کے لیے اختیاری تاخیر۔
   - پُش ٹو ٹاک ختم ہونے کے بعد ویک رن ٹائم پر مختصر کول ڈاؤن لاگو کریں تاکہ ویک ورڈ فوراً دوبارہ ٹرگر نہ ہو۔
5. **لاگنگ**
   - کوآرڈینیٹر سب سسٹم `bot.molt` میں زمروں `voicewake.overlay` اور `voicewake.chime` کے تحت `.info` لاگز خارج کرتا ہے۔
   - اہم واقعات: `session_started`، `adopted_by_push_to_talk`، `partial`، `finalized`، `send`، `dismiss`، `cancel`، `cooldown`۔

## ڈیبگنگ چیک لسٹ

- چپکے ہوئے اوورلے کو دوبارہ پیدا کرتے وقت اسٹریم لاگز:

  ```bash
  sudo log stream --predicate 'subsystem == "bot.molt" AND category CONTAINS "voicewake"' --level info --style compact
  ```

- صرف ایک فعال سیشن ٹوکن کی توثیق کریں؛ باسی کال بیکس کو کوآرڈینیٹر کے ذریعے چھوڑ دیا جانا چاہیے۔

- یقینی بنائیں کہ پُش ٹو ٹاک چھوڑنے پر ہمیشہ فعال ٹوکن کے ساتھ `endCapture` کال ہو؛ اگر متن خالی ہو تو چائم یا بھیجنے کے بغیر `dismiss` متوقع ہے۔

## مائیگریشن مراحل (تجویز کردہ)

1. `VoiceSessionCoordinator`، `VoiceSession`، اور `VoiceSessionPublisher` شامل کریں۔
2. `VoiceWakeRuntime` کو ری فیکٹر کریں تاکہ `VoiceWakeOverlayController` کو براہِ راست چھیڑنے کے بجائے سیشنز بنائے/اپڈیٹ کرے/ختم کرے۔
3. `VoicePushToTalk` کو ری فیکٹر کریں تاکہ موجودہ سیشنز کو اپنا سکے اور ریلیز پر `endCapture` کال کرے؛ رن ٹائم کول ڈاؤن لاگو کریں۔
4. `VoiceWakeOverlayController` کو پبلشر سے وائر کریں؛ رن ٹائم/PTT سے براہِ راست کالز ہٹا دیں۔
5. سیشن اپنانے، کول ڈاؤن، اور خالی متن کی برخاستگی کے لیے انضمامی ٹیسٹس شامل کریں۔
