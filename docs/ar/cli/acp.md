---
summary: "تشغيل جسر ACP لتكاملات بيئات التطوير المتكاملة (IDE)"
read_when:
  - إعداد تكاملات IDE المستندة إلى ACP
  - تصحيح توجيه جلسات ACP إلى Gateway
title: "acp"
---

# acp

تشغيل جسر ACP (Agent Client Protocol) الذي يتواصل مع OpenClaw Gateway.

يتحدث هذا الأمر ACP عبر stdio لبيئات IDE ويُمرِّر المطالبات إلى Gateway عبر WebSocket. ويحافظ على ربط جلسات ACP بمفاتيح جلسات Gateway.

## Usage

```bash
openclaw acp

# Remote Gateway
openclaw acp --url wss://gateway-host:18789 --token <token>

# Attach to an existing session key
openclaw acp --session agent:main:main

# Attach by label (must already exist)
openclaw acp --session-label "support inbox"

# Reset the session key before the first prompt
openclaw acp --session agent:main:main --reset-session
```

## ACP client (debug)

استخدم عميل ACP المدمج للتحقق السريع من سلامة الجسر دون الحاجة إلى IDE.
يقوم بتشغيل جسر ACP ويتيح لك إدخال المطالبات تفاعليًا.

```bash
openclaw acp client

# Point the spawned bridge at a remote Gateway
openclaw acp client --server-args --url wss://gateway-host:18789 --token <token>

# Override the server command (default: openclaw)
openclaw acp client --server "node" --server-args openclaw.mjs acp --url ws://127.0.0.1:19001
```

## How to use this

استخدم ACP عندما يتحدث IDE (أو عميل آخر) Agent Client Protocol وترغب في أن يقود جلسة OpenClaw Gateway.

1. تأكّد من أن Gateway قيد التشغيل (محليًا أو عن بُعد).
2. اضبط هدف Gateway (عبر التهيئة أو الأعلام).
3. وجّه IDE لديك لتشغيل `openclaw acp` عبر stdio.

مثال تهيئة (محفوظة):

```bash
openclaw config set gateway.remote.url wss://gateway-host:18789
openclaw config set gateway.remote.token <token>
```

مثال تشغيل مباشر (من دون كتابة تهيئة):

```bash
openclaw acp --url wss://gateway-host:18789 --token <token>
```

## Selecting agents

لا يختار ACP الوكلاء مباشرة. بل يقوم بالتوجيه عبر مفتاح جلسة Gateway.

استخدم مفاتيح جلسات ذات نطاق الوكيل لاستهداف وكيل محدد:

```bash
openclaw acp --session agent:main:main
openclaw acp --session agent:design:main
openclaw acp --session agent:qa:bug-123
```

تُطابِق كل جلسة ACP مفتاح جلسة Gateway واحدًا. يمكن لوكيل واحد امتلاك عدة جلسات؛
ويستخدم ACP افتراضيًا جلسة `acp:<uuid>` معزولة ما لم تتجاوز المفتاح أو التسمية.

## Zed editor setup

أضِف وكيل ACP مخصصًا في `~/.config/zed/settings.json` (أو استخدم واجهة إعدادات Zed):

```json
{
  "agent_servers": {
    "OpenClaw ACP": {
      "type": "custom",
      "command": "openclaw",
      "args": ["acp"],
      "env": {}
    }
  }
}
```

لاستهداف Gateway أو وكيل معيّن:

```json
{
  "agent_servers": {
    "OpenClaw ACP": {
      "type": "custom",
      "command": "openclaw",
      "args": [
        "acp",
        "--url",
        "wss://gateway-host:18789",
        "--token",
        "<token>",
        "--session",
        "agent:design:main"
      ],
      "env": {}
    }
  }
}
```

في Zed، افتح لوحة Agent واختر «OpenClaw ACP» لبدء سلسلة محادثة.

## Session mapping

افتراضيًا، تحصل جلسات ACP على مفتاح جلسة Gateway معزول ببادئة `acp:`.
لإعادة استخدام جلسة معروفة، مرِّر مفتاح جلسة أو تسمية:

- `--session <key>`: استخدام مفتاح جلسة Gateway محدّد.
- `--session-label <label>`: حلّ جلسة موجودة بواسطة التسمية.
- `--reset-session`: إنشاء معرّف جلسة جديد لذلك المفتاح (نفس المفتاح، وسجل جديد).

إذا كان عميل ACP يدعم البيانات الوصفية، يمكنك التجاوز لكل جلسة:

```json
{
  "_meta": {
    "sessionKey": "agent:main:main",
    "sessionLabel": "support inbox",
    "resetSession": true
  }
}
```

تعرّف على المزيد حول مفاتيح الجلسات في [/concepts/session](/concepts/session).

## Options

- `--url <url>`: عنوان WebSocket لـ Gateway (الافتراضي هو gateway.remote.url عند الضبط).
- `--token <token>`: رمز مصادقة Gateway.
- `--password <password>`: كلمة مرور مصادقة Gateway.
- `--session <key>`: مفتاح الجلسة الافتراضي.
- `--session-label <label>`: تسمية الجلسة الافتراضية المراد حلّها.
- `--require-existing`: الفشل إذا لم يكن مفتاح/تسمية الجلسة موجودًا.
- `--reset-session`: إعادة تعيين مفتاح الجلسة قبل أول استخدام.
- `--no-prefix-cwd`: عدم إضافة بادئة دليل العمل إلى المطالبات.
- `--verbose, -v`: تسجيل مُفصّل إلى stderr.

### `acp client` options

- `--cwd <dir>`: دليل العمل لجلسة ACP.
- `--server <command>`: أمر خادم ACP (الافتراضي: `openclaw`).
- `--server-args <args...>`: وسيطات إضافية تُمرَّر إلى خادم ACP.
- `--server-verbose`: تمكين التسجيل المُفصّل على خادم ACP.
- `--verbose, -v`: تسجيل مُفصّل للعميل.
