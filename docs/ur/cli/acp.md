---
summary: "IDE انضمامات کے لیے ACP برج چلائیں"
read_when:
  - ACP پر مبنی IDE انضمامات سیٹ اپ کرتے وقت
  - Gateway تک ACP سیشن روٹنگ کی خرابیوں کا ازالہ کرتے وقت
title: "acp"
---

# acp

ACP (Agent Client Protocol) برج چلائیں جو OpenClaw Gateway سے بات کرتا ہے۔

یہ کمانڈ IDEs کے لیے stdio پر ACP بولتی ہے اور پرامپٹس کو گیٹ وے کی طرف WebSocket کے ذریعے فارورڈ کرتی ہے
۔ یہ ACP سیشنز کو گیٹ وے سیشن کیز کے ساتھ میپ رکھتی ہے۔

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

## ACP کلائنٹ (ڈیبگ)

IDE کے بغیر برج کی جانچ کے لیے بلٹ اِن ACP کلائنٹ استعمال کریں۔
یہ ACP برج کو شروع کرتی ہے اور آپ کو انٹرایکٹو طور پر پرامپٹس ٹائپ کرنے دیتی ہے۔

```bash
openclaw acp client

# Point the spawned bridge at a remote Gateway
openclaw acp client --server-args --url wss://gateway-host:18789 --token <token>

# Override the server command (default: openclaw)
openclaw acp client --server "node" --server-args openclaw.mjs acp --url ws://127.0.0.1:19001
```

## اسے کیسے استعمال کریں

ACP اس وقت استعمال کریں جب کوئی IDE (یا دوسرا کلائنٹ) Agent Client Protocol بولتا ہو اور آپ چاہتے ہوں کہ وہ OpenClaw Gateway سیشن کو چلائے۔

1. یقینی بنائیں کہ Gateway چل رہا ہے (لوکل یا ریموٹ)۔
2. Gateway ہدف کنفیگر کریں (کنفیگ یا فلیگز)۔
3. اپنے IDE کو stdio کے ذریعے `openclaw acp` چلانے کی طرف پوائنٹ کریں۔

مثالی کنفیگ (محفوظ شدہ):

```bash
openclaw config set gateway.remote.url wss://gateway-host:18789
openclaw config set gateway.remote.token <token>
```

مثالی براہِ راست رن (کنفیگ لکھے بغیر):

```bash
openclaw acp --url wss://gateway-host:18789 --token <token>
```

## ایجنٹس کا انتخاب

ACP براہِ راست ایجنٹس کا انتخاب نہیں کرتا۔ یہ گیٹ وے سیشن کی کے ذریعے روٹنگ کرتا ہے۔

کسی مخصوص ایجنٹ کو ہدف بنانے کے لیے ایجنٹ-اسکوپڈ سیشن کیز استعمال کریں:

```bash
openclaw acp --session agent:main:main
openclaw acp --session agent:design:main
openclaw acp --session agent:qa:bug-123
```

ہر ACP سیشن ایک واحد گیٹ وے سیشن کی سے میپ ہوتا ہے۔ One agent can have many
sessions; ACP defaults to an isolated `acp:<uuid>` session unless you override
the key or label.

## Zed ایڈیٹر سیٹ اپ

`~/.config/zed/settings.json` میں ایک کسٹم ACP ایجنٹ شامل کریں (یا Zed کی Settings UI استعمال کریں):

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

کسی مخصوص Gateway یا ایجنٹ کو ہدف بنانے کے لیے:

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

Zed میں، Agent پینل کھولیں اور تھریڈ شروع کرنے کے لیے “OpenClaw ACP” منتخب کریں۔

## سیشن میپنگ

بطور ڈیفالٹ، ACP سیشنز کو `acp:` سابقہ کے ساتھ ایک الگ تھلگ گیٹ وے سیشن کی ملتی ہے۔
کسی معلوم سیشن کو دوبارہ استعمال کرنے کے لیے، سیشن کی یا لیبل پاس کریں:

- `--session <key>`: ایک مخصوص Gateway سیشن کی استعمال کریں۔
- `--session-label <label>`: لیبل کے ذریعے موجودہ سیشن حل کریں۔
- `--reset-session`: اسی کی کے لیے نیا سیشن آئی ڈی بنائیں (وہی کی، نیا ٹرانسکرپٹ)۔

اگر آپ کا ACP کلائنٹ میٹاڈیٹا سپورٹ کرتا ہے، تو آپ فی سیشن اووررائیڈ کر سکتے ہیں:

```json
{
  "_meta": {
    "sessionKey": "agent:main:main",
    "sessionLabel": "support inbox",
    "resetSession": true
  }
}
```

سیشن کیز کے بارے میں مزید جانیں: [/concepts/session](/concepts/session)۔

## Options

- `--url <url>`: Gateway WebSocket URL (کنفیگر ہونے پر gateway.remote.url بطورِ طے شدہ)۔
- `--token <token>`: Gateway تصدیقی ٹوکن۔
- `--password <password>`: Gateway تصدیقی پاس ورڈ۔
- `--session <key>`: بطورِ طے شدہ سیشن کی۔
- `--session-label <label>`: حل کرنے کے لیے بطورِ طے شدہ سیشن لیبل۔
- `--require-existing`: اگر سیشن کی/لیبل موجود نہ ہو تو ناکام ہو۔
- `--reset-session`: پہلی استعمال سے پہلے سیشن کی ری سیٹ کریں۔
- `--no-prefix-cwd`: ورکنگ ڈائریکٹری کے ساتھ پرامپٹس کو پری فکس نہ کریں۔
- `--verbose, -v`: stderr پر تفصیلی لاگنگ۔

### `acp client` اختیارات

- `--cwd <dir>`: ACP سیشن کے لیے ورکنگ ڈائریکٹری۔
- `--server <command>`: ACP سرور کمانڈ (بطورِ طے شدہ: `openclaw`)۔
- `--server-args <args...>`: ACP سرور کو دیے جانے والے اضافی آرگیومنٹس۔
- `--server-verbose`: ACP سرور پر تفصیلی لاگنگ فعال کریں۔
- `--verbose, -v`: تفصیلی کلائنٹ لاگنگ۔
