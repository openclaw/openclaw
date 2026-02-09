---
summary: "iOS اور دیگر ریموٹ نوڈز کے لیے Gateway کی ملکیت والی نوڈ جوڑی (آپشن B)"
read_when:
  - macOS UI کے بغیر نوڈ جوڑی کی منظوریوں پر عمل درآمد کرتے وقت
  - ریموٹ نوڈز کی منظوری کے لیے CLI فلو شامل کرتے وقت
  - نوڈ مینجمنٹ کے ساتھ gateway پروٹوکول کو وسعت دیتے وقت
title: "Gateway کی ملکیت والی جوڑی"
---

# Gateway کی ملکیت والی جوڑی (آپشن B)

In Gateway-owned pairing, the **Gateway** is the source of truth for which nodes
are allowed to join. UIs (macOS app, future clients) are just frontends that
approve or reject pending requests.

**Important:** WS nodes use **device pairing** (role `node`) during `connect`.
`node.pair.*` is a separate pairing store and does **not** gate the WS handshake.
Only clients that explicitly call `node.pair.*` use this flow.

## تصورات

- **Pending request**: شامل ہونے کی درخواست کرنے والا نوڈ؛ منظوری درکار ہوتی ہے۔
- **Paired node**: منظور شدہ نوڈ جسے تصدیقی ٹوکن جاری کیا گیا ہو۔
- **Transport**: the Gateway WS endpoint forwards requests but does not decide
  membership. (Legacy TCP bridge support is deprecated/removed.)

## جوڑی کیسے کام کرتی ہے

1. ایک نوڈ Gateway WS سے جڑتا ہے اور جوڑی کی درخواست کرتا ہے۔
2. Gateway ایک **pending request** محفوظ کرتا ہے اور `node.pair.requested` خارج کرتا ہے۔
3. آپ درخواست کو منظور یا مسترد کرتے ہیں (CLI یا UI کے ذریعے)۔
4. منظوری پر، Gateway ایک **نیا ٹوکن** جاری کرتا ہے (دوبارہ جوڑی پر ٹوکنز گھمائے جاتے ہیں)۔
5. نوڈ ٹوکن کے ساتھ دوبارہ جڑتا ہے اور اب “paired” ہوتا ہے۔

زیرِ التواء درخواستیں **5 منٹ** بعد خودکار طور پر ختم ہو جاتی ہیں۔

## CLI ورک فلو (ہیڈ لیس کے لیے موزوں)

```bash
openclaw nodes pending
openclaw nodes approve <requestId>
openclaw nodes reject <requestId>
openclaw nodes status
openclaw nodes rename --node <id|name|ip> --name "Living Room iPad"
```

`nodes status` جوڑے/منسلک نوڈز اور ان کی صلاحیتیں دکھاتا ہے۔

## API سطح (gateway پروٹوکول)

واقعات:

- `node.pair.requested` — جب نئی pending request بنائی جائے تو خارج ہوتا ہے۔
- `node.pair.resolved` — جب کوئی درخواست منظور/مسترد/ختم ہو تو خارج ہوتا ہے۔

طریقے:

- `node.pair.request` — pending request بنائیں یا دوبارہ استعمال کریں۔
- `node.pair.list` — pending + paired نوڈز کی فہرست دیں۔
- `node.pair.approve` — pending request منظور کریں (ٹوکن جاری کرتا ہے)۔
- `node.pair.reject` — pending request مسترد کریں۔
- `node.pair.verify` — `{ nodeId, token }` کی توثیق کریں۔

نوٹس:

- `node.pair.request` ہر نوڈ کے لیے idempotent ہے: بار بار کالز ایک ہی
  pending request واپس کرتی ہیں۔
- منظوری **ہمیشہ** نیا ٹوکن بناتی ہے؛ `node.pair.request` سے کبھی کوئی ٹوکن واپس نہیں کیا جاتا۔
- درخواستوں میں خودکار منظوری کے فلو کے لیے بطور اشارہ `silent: true` شامل ہو سکتا ہے۔

## خودکار منظوری (macOS ایپ)

macOS ایپ اختیاری طور پر **خاموش منظوری** کی کوشش کر سکتی ہے جب:

- درخواست `silent` کے طور پر نشان زد ہو، اور
- ایپ اسی صارف کے ساتھ گیٹ وے ہوسٹ سے SSH کنکشن کی توثیق کر سکے۔

اگر خاموش منظوری ناکام ہو جائے تو یہ معمول کے “Approve/Reject” پرامپٹ پر واپس آ جاتی ہے۔

## اسٹوریج (مقامی، نجی)

جوڑی کی حالت Gateway اسٹیٹ ڈائریکٹری کے تحت محفوظ ہوتی ہے (ڈیفالٹ `~/.openclaw`):

- `~/.openclaw/nodes/paired.json`
- `~/.openclaw/nodes/pending.json`

اگر آپ `OPENCLAW_STATE_DIR` کو اوور رائیڈ کریں، تو `nodes/` فولڈر بھی اس کے ساتھ منتقل ہو جاتا ہے۔

سکیورٹی نوٹس:

- ٹوکنز راز ہوتے ہیں؛ `paired.json` کو حساس سمجھیں۔
- ٹوکن کو گھمانے کے لیے دوبارہ منظوری درکار ہوتی ہے (یا نوڈ انٹری حذف کرنا)۔

## ٹرانسپورٹ رویّہ

- ٹرانسپورٹ **stateless** ہے؛ یہ رکنیت محفوظ نہیں کرتا۔
- اگر Gateway آف لائن ہو یا جوڑی غیر فعال ہو، تو نوڈز جوڑی نہیں بنا سکتے۔
- اگر Gateway ریموٹ موڈ میں ہو، تب بھی جوڑی ریموٹ Gateway کے اسٹور کے خلاف ہی ہوتی ہے۔
