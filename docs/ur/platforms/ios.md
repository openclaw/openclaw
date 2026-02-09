---
summary: "iOS نوڈ ایپ: Gateway سے کنکشن، جوڑی بنانا، کینوس، اور خرابیوں کا ازالہ"
read_when:
  - iOS نوڈ کی جوڑی بنانا یا دوبارہ کنیکٹ کرنا
  - سورس سے iOS ایپ چلانا
  - گیٹ وے ڈسکوری یا کینوس کمانڈز کی ڈیبگنگ
title: "iOS ایپ"
---

# iOS ایپ (نوڈ)

Availability: internal preview. 37. iOS ایپ ابھی عوامی طور پر تقسیم نہیں کی گئی۔

## یہ کیا کرتی ہے

- WebSocket کے ذریعے Gateway سے کنیکٹ ہوتی ہے (LAN یا tailnet)۔
- نوڈ کی صلاحیتیں فراہم کرتی ہے: کینوس، اسکرین اسنیپ شاٹ، کیمرہ کیپچر، مقام، ٹاک موڈ، وائس ویک۔
- `node.invoke` کمانڈز وصول کرتی ہے اور نوڈ اسٹیٹس ایونٹس رپورٹ کرتی ہے۔

## ضروریات

- Gateway کسی دوسرے ڈیوائس پر چل رہا ہو (macOS، Linux، یا WSL2 کے ذریعے Windows)۔
- نیٹ ورک راستہ:
  - Bonjour کے ذریعے وہی LAN، **یا**
  - unicast DNS-SD کے ذریعے Tailnet (مثالی ڈومین: `openclaw.internal.`)، **یا**
  - دستی ہوسٹ/پورٹ (فالبیک)۔

## فوری آغاز (جوڑی + کنیکٹ)

1. Gateway شروع کریں:

```bash
openclaw gateway --port 18789
```

2. iOS ایپ میں، Settings کھولیں اور دریافت شدہ گیٹ وے منتخب کریں (یا Manual Host فعال کریں اور ہوسٹ/پورٹ درج کریں)۔

3. گیٹ وے ہوسٹ پر جوڑی بنانے کی درخواست منظور کریں:

```bash
openclaw nodes pending
openclaw nodes approve <requestId>
```

4. کنکشن کی تصدیق کریں:

```bash
openclaw nodes status
openclaw gateway call node.list --params "{}"
```

## ڈسکوری کے راستے

### Bonjour (LAN)

38. گیٹ وے `local.` پر `_openclaw-gw._tcp` کی تشہیر کرتا ہے۔ 39. iOS ایپ انہیں خودکار طور پر فہرست میں دکھاتی ہے۔

### Tailnet (کراس-نیٹ ورک)

40. اگر mDNS بلاک ہو تو unicast DNS-SD زون استعمال کریں (ایک ڈومین منتخب کریں؛ مثال: `openclaw.internal.`) اور Tailscale split DNS۔
41. CoreDNS مثال کے لیے دیکھیں [Bonjour](/gateway/bonjour).

### دستی ہوسٹ/پورٹ

Settings میں **Manual Host** فعال کریں اور گیٹ وے ہوسٹ + پورٹ درج کریں (ڈیفالٹ `18789`)۔

## کینوس + A2UI

The iOS node renders a WKWebView canvas. 43. اسے کنٹرول کرنے کے لیے `node.invoke` استعمال کریں:

```bash
openclaw nodes invoke --node "iOS Node" --command canvas.navigate --params '{"url":"http://<gateway-host>:18793/__openclaw__/canvas/"}'
```

نوٹس:

- Gateway کینوس ہوسٹ `/__openclaw__/canvas/` اور `/__openclaw__/a2ui/` فراہم کرتا ہے۔
- جب کینوس ہوسٹ URL کی تشہیر ہوتی ہے تو iOS نوڈ کنیکٹ ہوتے ہی خودکار طور پر A2UI پر نیویگیٹ کرتا ہے۔
- بلٹ اِن اسکیفولڈ پر واپس جانے کے لیے `canvas.navigate` اور `{"url":""}` استعمال کریں۔

### کینوس eval / اسنیپ شاٹ

```bash
openclaw nodes invoke --node "iOS Node" --command canvas.eval --params '{"javaScript":"(() => { const {ctx} = window.__openclaw; ctx.clearRect(0,0,innerWidth,innerHeight); ctx.lineWidth=6; ctx.strokeStyle=\"#ff2d55\"; ctx.beginPath(); ctx.moveTo(40,40); ctx.lineTo(innerWidth-40, innerHeight-40); ctx.stroke(); return \"ok\"; })()"}'
```

```bash
openclaw nodes invoke --node "iOS Node" --command canvas.snapshot --params '{"maxWidth":900,"format":"jpeg"}'
```

## وائس ویک + ٹاک موڈ

- وائس ویک اور ٹاک موڈ Settings میں دستیاب ہیں۔
- iOS پس منظر کی آڈیو کو معطل کر سکتا ہے؛ جب ایپ فعال نہ ہو تو وائس فیچرز کو بہترین کوشش (best-effort) کے طور پر سمجھیں۔

## عام غلطیاں

- `NODE_BACKGROUND_UNAVAILABLE`: iOS ایپ کو فورگراؤنڈ میں لائیں (کینوس/کیمرہ/اسکرین کمانڈز کے لیے یہ ضروری ہے)۔
- `A2UI_HOST_NOT_CONFIGURED`: Gateway نے کینوس ہوسٹ URL کی تشہیر نہیں کی؛ [Gateway کنفیگریشن](/gateway/configuration) میں `canvasHost` چیک کریں۔
- جوڑی بنانے کا پرامپٹ کبھی ظاہر نہیں ہوتا: `openclaw nodes pending` چلائیں اور دستی طور پر منظور کریں۔
- دوبارہ انسٹال کے بعد ری کنیکٹ ناکام: Keychain کی جوڑی بنانے والی ٹوکن صاف ہو گئی؛ نوڈ کو دوبارہ جوڑیں۔

## متعلقہ دستاویزات

- [Pairing](/gateway/pairing)
- [Discovery](/gateway/discovery)
- [Bonjour](/gateway/bonjour)
