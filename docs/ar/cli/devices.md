---
summary: "مرجع CLI لأمر `openclaw devices` (إقران الأجهزة + تدوير/إلغاء رموز الأجهزة)"
read_when:
  - أنت توافق على طلبات إقران الأجهزة
  - تحتاج إلى تدوير رموز الأجهزة أو إلغائها
title: "الأجهزة"
---

# `openclaw devices`

إدارة طلبات إقران الأجهزة والرموز المميّزة المحصورة بنطاق الجهاز.

## Commands

### `openclaw devices list`

سرد طلبات الإقران المعلّقة والأجهزة المقترنة.

```
openclaw devices list
openclaw devices list --json
```

### `openclaw devices approve <requestId>`

الموافقة على طلب إقران جهاز معلّق.

```
openclaw devices approve <requestId>
```

### `openclaw devices reject <requestId>`

رفض طلب إقران جهاز معلّق.

```
openclaw devices reject <requestId>
```

### `openclaw devices rotate --device <id> --role <role> [--scope <scope...>]`

تدوير رمز جهاز لدور محدّد (مع إمكانية تحديث النطاقات).

```
openclaw devices rotate --device <deviceId> --role operator --scope operator.read --scope operator.write
```

### `openclaw devices revoke --device <id> --role <role>`

إلغاء رمز الجهاز لدور محدد.

```
openclaw devices revoke --device <deviceId> --role node
```

## Common options

- `--url <url>`: عنوان URL لـ Gateway عبر WebSocket (القيمة الافتراضية `gateway.remote.url` عند تهيئته).
- `--token <token>`: رمز Gateway (إذا كان مطلوبًا).
- `--password <password>`: كلمة مرور Gateway (مصادقة كلمة المرور).
- `--timeout <ms>`: مهلة RPC.
- `--json`: إخراج JSON (موصى به للبرمجة النصية).

ملاحظة: عند تعيين `--url`، لا يعود CLI إلى بيانات الاعتماد من التهيئة أو متغيرات البيئة.
مرّر `--token` أو `--password` صراحةً. يُعدّ غياب بيانات اعتماد صريحة خطأً.

## Notes

- يعيد تدوير الرمز رمزًا جديدًا (حسّاسًا). معاملته كسرا.
- تتطلب هذه الأوامر نطاق `operator.pairing` (أو `operator.admin`).
