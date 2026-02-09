---
summary: "CLI حوالہ برائے `openclaw system` (سسٹم ایونٹس، ہارٹ بیٹ، موجودگی)"
read_when:
  - آپ بغیر کرون جاب بنائے سسٹم ایونٹ کو قطار میں شامل کرنا چاہتے ہوں
  - آپ ہارٹ بیٹس کو فعال یا غیرفعال کرنا چاہتے ہوں
  - آپ سسٹم موجودگی کی اندراجات کا معائنہ کرنا چاہتے ہوں
title: "سسٹم"
---

# `openclaw system`

Gateway کے لیے سسٹم سطح کے معاون اوزار: سسٹم ایونٹس کو قطار میں شامل کریں، ہارٹ بیٹس کو کنٹرول کریں،
اور موجودگی دیکھیں۔

## Common commands

```bash
openclaw system event --text "Check for urgent follow-ups" --mode now
openclaw system heartbeat enable
openclaw system heartbeat last
openclaw system presence
```

## `system event`

Enqueue a system event on the **main** session. 12. اگلا ہارٹ بیٹ اسے پرامپٹ میں `System:` لائن کے طور پر شامل کرے گا۔ Use `--mode now` to trigger the heartbeat
immediately; `next-heartbeat` waits for the next scheduled tick.

Flags:

- `--text <text>`: لازمی سسٹم ایونٹ متن۔
- `--mode <mode>`: `now` یا `next-heartbeat` (بطورِ طے شدہ)۔
- `--json`: مشین کے لیے قابلِ مطالعہ آؤٹ پٹ۔

## `system heartbeat last|enable|disable`

ہارٹ بیٹ کنٹرولز:

- `last`: آخری ہارٹ بیٹ ایونٹ دکھائیں۔
- `enable`: ہارٹ بیٹس دوبارہ آن کریں (اگر وہ غیرفعال کیے گئے ہوں تو یہ استعمال کریں)۔
- `disable`: ہارٹ بیٹس کو روک دیں۔

Flags:

- `--json`: مشین کے لیے قابلِ مطالعہ آؤٹ پٹ۔

## `system presence`

Gateway کو معلوم موجودہ سسٹم موجودگی کی اندراجات کی فہرست دکھائیں (نوڈز،
انسٹینسز، اور اسی طرح کی اسٹیٹس لائنیں)۔

Flags:

- `--json`: مشین کے لیے قابلِ مطالعہ آؤٹ پٹ۔

## نوٹس

- آپ کی موجودہ کنفیگ (لوکل یا ریموٹ) کے ذریعے قابلِ رسائی ایک چلتا ہوا Gateway درکار ہے۔
- سسٹم ایونٹس عارضی ہوتے ہیں اور ری اسٹارٹ کے بعد برقرار نہیں رہتے۔
