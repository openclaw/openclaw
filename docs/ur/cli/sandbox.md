---
title: سینڈباکس CLI
summary: "سینڈباکس کنٹینرز کا انتظام کریں اور مؤثر سینڈباکس پالیسی کا معائنہ کریں"
read_when: "جب آپ سینڈباکس کنٹینرز کا انتظام کر رہے ہوں یا سینڈباکس/ٹول پالیسی کے رویّے کی ڈیبگنگ کر رہے ہوں۔"
status: active
x-i18n:
  source_path: cli/sandbox.md
  source_hash: 6e1186f26c77e188
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:47:04Z
---

# Sandbox CLI

الگ تھلگ ایجنٹ اجرا کے لیے Docker پر مبنی sandbox کنٹینرز کا انتظام کریں۔

## Overview

OpenClaw سکیورٹی کے لیے ایجنٹس کو الگ تھلگ Docker کنٹینرز میں چلا سکتا ہے۔ `sandbox` کمانڈز آپ کو ان کنٹینرز کے انتظام میں مدد دیتی ہیں، خاص طور پر اپڈیٹس یا کنفیگریشن تبدیلیوں کے بعد۔

## Commands

### `openclaw sandbox explain`

**مؤثر** سینڈباکس موڈ/اسکوپ/ورک اسپیس رسائی، سینڈباکس ٹول پالیسی، اور elevated gates (fix-it کنفیگ کلید کے راستوں کے ساتھ) کا معائنہ کریں۔

```bash
openclaw sandbox explain
openclaw sandbox explain --session agent:main:main
openclaw sandbox explain --agent work
openclaw sandbox explain --json
```

### `openclaw sandbox list`

تمام سینڈباکس کنٹینرز کو ان کی حالت اور کنفیگریشن کے ساتھ فہرست کریں۔

```bash
openclaw sandbox list
openclaw sandbox list --browser  # List only browser containers
openclaw sandbox list --json     # JSON output
```

**Output includes:**

- کنٹینر کا نام اور حالت (چل رہا/روکا ہوا)
- Docker امیج اور آیا یہ کنفیگ سے مطابقت رکھتا ہے یا نہیں
- عمر (تخلیق کے بعد سے وقت)
- غیر فعالی کا وقت (آخری استعمال کے بعد سے وقت)
- منسلک سیشن/ایجنٹ

### `openclaw sandbox recreate`

اپڈیٹ شدہ امیجز/کنفیگ کے ساتھ دوبارہ تخلیق کو مجبور کرنے کے لیے سینڈباکس کنٹینرز ہٹائیں۔

```bash
openclaw sandbox recreate --all                # Recreate all containers
openclaw sandbox recreate --session main       # Specific session
openclaw sandbox recreate --agent mybot        # Specific agent
openclaw sandbox recreate --browser            # Only browser containers
openclaw sandbox recreate --all --force        # Skip confirmation
```

**Options:**

- `--all`: تمام سینڈباکس کنٹینرز دوبارہ تخلیق کریں
- `--session <key>`: مخصوص سیشن کے لیے کنٹینر دوبارہ تخلیق کریں
- `--agent <id>`: مخصوص ایجنٹ کے لیے کنٹینرز دوبارہ تخلیق کریں
- `--browser`: صرف براؤزر کنٹینرز دوبارہ تخلیق کریں
- `--force`: تصدیقی پرامپٹ چھوڑ دیں

**Important:** ایجنٹ کے اگلی بار استعمال ہونے پر کنٹینرز خودکار طور پر دوبارہ تخلیق ہو جاتے ہیں۔

## Use Cases

### Docker امیجز اپڈیٹ کرنے کے بعد

```bash
# Pull new image
docker pull openclaw-sandbox:latest
docker tag openclaw-sandbox:latest openclaw-sandbox:bookworm-slim

# Update config to use new image
# Edit config: agents.defaults.sandbox.docker.image (or agents.list[].sandbox.docker.image)

# Recreate containers
openclaw sandbox recreate --all
```

### سینڈباکس کنفیگریشن تبدیل کرنے کے بعد

```bash
# Edit config: agents.defaults.sandbox.* (or agents.list[].sandbox.*)

# Recreate to apply new config
openclaw sandbox recreate --all
```

### setupCommand تبدیل کرنے کے بعد

```bash
openclaw sandbox recreate --all
# or just one agent:
openclaw sandbox recreate --agent family
```

### صرف کسی مخصوص ایجنٹ کے لیے

```bash
# Update only one agent's containers
openclaw sandbox recreate --agent alfred
```

## Why is this needed?

**Problem:** جب آپ سینڈباکس Docker امیجز یا کنفیگریشن اپڈیٹ کرتے ہیں:

- موجودہ کنٹینرز پرانی ترتیبات کے ساتھ چلتے رہتے ہیں
- کنٹینرز صرف 24 گھنٹے غیر فعالی کے بعد prune ہوتے ہیں
- باقاعدہ استعمال ہونے والے ایجنٹس پرانے کنٹینرز کو غیر معینہ مدت تک چلاتے رہتے ہیں

**Solution:** پرانے کنٹینرز کو زبردستی ہٹانے کے لیے `openclaw sandbox recreate` استعمال کریں۔ اگلی ضرورت پر وہ موجودہ ترتیبات کے ساتھ خودکار طور پر دوبارہ تخلیق ہو جائیں گے۔

Tip: دستی `docker rm` کے بجائے `openclaw sandbox recreate` کو ترجیح دیں۔ یہ
Gateway کی کنٹینر نامگذاری استعمال کرتا ہے اور اسکوپ/سیشن کلیدیں تبدیل ہونے پر عدم مطابقت سے بچاتا ہے۔

## Configuration

سینڈباکس کی ترتیبات `~/.openclaw/openclaw.json` میں `agents.defaults.sandbox` کے تحت موجود ہوتی ہیں (ہر ایجنٹ کے لیے overrides `agents.list[].sandbox` میں جاتی ہیں):

```jsonc
{
  "agents": {
    "defaults": {
      "sandbox": {
        "mode": "all", // off, non-main, all
        "scope": "agent", // session, agent, shared
        "docker": {
          "image": "openclaw-sandbox:bookworm-slim",
          "containerPrefix": "openclaw-sbx-",
          // ... more Docker options
        },
        "prune": {
          "idleHours": 24, // Auto-prune after 24h idle
          "maxAgeDays": 7, // Auto-prune after 7 days
        },
      },
    },
  },
}
```

## See Also

- [Sandbox Documentation](/gateway/sandboxing)
- [Agent Configuration](/concepts/agent-workspace)
- [Doctor Command](/gateway/doctor) - سینڈباکس سیٹ اپ کی جانچ کریں
