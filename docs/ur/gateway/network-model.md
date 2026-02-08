---
summary: "Gateway، نوڈز، اور کینوس ہوسٹ کس طرح جڑتے ہیں۔"
read_when:
  - آپ Gateway کے نیٹ ورکنگ ماڈل کا مختصر منظر چاہتے ہیں
title: "نیٹ ورک ماڈل"
x-i18n:
  source_path: gateway/network-model.md
  source_hash: e3508b884757ef19
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:47:16Z
---

زیادہ تر آپریشنز Gateway (`openclaw gateway`) کے ذریعے گزرتے ہیں، جو ایک واحد طویل عرصے تک چلنے والا
عمل ہے جو چینل کنکشنز اور WebSocket کنٹرول پلین کی ملکیت رکھتا ہے۔

## بنیادی اصول

- فی ہوسٹ ایک Gateway تجویز کیا جاتا ہے۔ WhatsApp Web سیشن کی ملکیت رکھنے کی اجازت صرف اسی عمل کو ہے۔ ریسکیو بوٹس یا سخت علیحدگی کے لیے، علیحدہ پروفائلز اور پورٹس کے ساتھ متعدد گیٹ ویز چلائیں۔ دیکھیں [Multiple gateways](/gateway/multiple-gateways)۔
- لوپ بیک پہلے: Gateway WS بطورِ طے شدہ `ws://127.0.0.1:18789` ہوتا ہے۔ وِزَرڈ بطورِ طے شدہ گیٹ وے ٹوکن تیار کرتا ہے، حتیٰ کہ لوپ بیک کے لیے بھی۔ ٹیل نیٹ رسائی کے لیے `openclaw gateway --bind tailnet --token ...` چلائیں کیونکہ نان-لوپ بیک بائنڈز کے لیے ٹوکنز درکار ہوتے ہیں۔
- نوڈز ضرورت کے مطابق LAN، ٹیل نیٹ، یا SSH کے ذریعے Gateway WS سے جڑتے ہیں۔ لیگیسی TCP برج فرسودہ قرار دیا جا چکا ہے۔
- کینوس ہوسٹ ایک HTTP فائل سرور ہے جو `canvasHost.port` پر (بطورِ طے شدہ `18793`) چلتا ہے اور نوڈ WebViews کے لیے `/__openclaw__/canvas/` فراہم کرتا ہے۔ دیکھیں [Gateway configuration](/gateway/configuration) (`canvasHost`)۔
- ریموٹ استعمال عموماً SSH سرنگ یا ٹیل نیٹ VPN کے ذریعے ہوتا ہے۔ دیکھیں [Remote access](/gateway/remote) اور [Discovery](/gateway/discovery)۔
