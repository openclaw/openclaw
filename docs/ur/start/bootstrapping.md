---
summary: "ایجنٹ بوٹ اسٹرَیپنگ کا عمل جو ورک اسپیس اور شناختی فائلوں کی بنیاد رکھتا ہے"
read_when:
  - پہلی بار ایجنٹ چلنے پر کیا ہوتا ہے، اس کی سمجھ بوجھ
  - یہ وضاحت کہ بوٹ اسٹرَیپنگ فائلیں کہاں موجود ہوتی ہیں
  - آن بورڈنگ کے دوران شناختی سیٹ اپ کی خرابیوں کی جانچ
title: "ایجنٹ بوٹ اسٹرَیپنگ"
sidebarTitle: "Bootstrapping"
---

# ایجنٹ بوٹ اسٹرَیپنگ

Bootstrapping is the **first‑run** ritual that prepares an agent workspace and
collects identity details. It happens after onboarding, when the agent starts
for the first time.

## بوٹ اسٹرَیپنگ کیا کرتا ہے

ایجنٹ کے پہلی بار چلنے پر، OpenClaw ورک اسپیس کو بوٹ اسٹرَیپ کرتا ہے (بطورِ طے شدہ
`~/.openclaw/workspace`):

- `AGENTS.md`، `BOOTSTRAP.md`، `IDENTITY.md`، `USER.md` کو بیج فراہم کرتا ہے۔
- ایک مختصر سوال و جواب کا عمل چلاتا ہے (ایک وقت میں ایک سوال)۔
- شناخت اور ترجیحات کو `IDENTITY.md`، `USER.md`، `SOUL.md` میں لکھتا ہے۔
- مکمل ہونے پر `BOOTSTRAP.md` کو ہٹا دیتا ہے تاکہ یہ صرف ایک بار ہی چلے۔

## یہ کہاں چلتا ہے

Bootstrapping always runs on the **gateway host**. If the macOS app connects to
a remote Gateway, the workspace and bootstrapping files live on that remote
machine.

<Note>
جب Gateway کسی دوسری مشین پر چل رہا ہو، تو ورک اسپیس فائلوں میں ترمیم گیٹ وے ہوسٹ
پر کریں (مثال کے طور پر، `user@gateway-host:~/.openclaw/workspace`)۔
</Note>

## متعلقہ دستاویزات

- macOS ایپ آن بورڈنگ: [Onboarding](/start/onboarding)
- ورک اسپیس لے آؤٹ: [Agent workspace](/concepts/agent-workspace)
