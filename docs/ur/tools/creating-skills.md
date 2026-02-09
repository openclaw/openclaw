---
title: "Skills تخلیق کرنا"
---

# حسبِ ضرورت Skills بنانا 🛠

OpenClaw is designed to be easily extensible. "Skills" are the primary way to add new capabilities to your assistant.

## Skill کیا ہے؟

ایک Skill ایک ڈائریکٹری ہوتی ہے جس میں ایک `SKILL.md` فائل شامل ہوتی ہے (جو LLM کو ہدایات اور ٹول کی تعریفیں فراہم کرتی ہے) اور اختیاری طور پر کچھ اسکرپٹس یا وسائل بھی ہو سکتے ہیں۔

## مرحلہ وار: آپ کی پہلی Skill

### 1. Create the Directory

Skills live in your workspace, usually `~/.openclaw/workspace/skills/`. Create a new folder for your skill:

```bash
mkdir -p ~/.openclaw/workspace/skills/hello-world
```

### 2. Define the `SKILL.md`

Create a `SKILL.md` file in that directory. This file uses YAML frontmatter for metadata and Markdown for instructions.

```markdown
---
name: hello_world
description: A simple skill that says hello.
---

# Hello World Skill

When the user asks for a greeting, use the `echo` tool to say "Hello from your custom skill!".
```

### 3. Add Tools (Optional)

آپ فرنٹ میٹر میں حسبِ ضرورت ٹولز کی تعریف کر سکتے ہیں یا ایجنٹ کو موجودہ سسٹم ٹولز استعمال کرنے کی ہدایت دے سکتے ہیں (جیسے `bash` یا `browser`)۔

### 4. Refresh OpenClaw

Ask your agent to "refresh skills" or restart the gateway. OpenClaw will discover the new directory and index the `SKILL.md`.

## بہترین طریقۂ کار

- **مختصر رہیں**: ماڈل کو یہ بتائیں کہ _کیا_ کرنا ہے، یہ نہیں کہ AI کیسے بننا ہے۔
- **حفاظت اولین**: اگر آپ کی Skill میں `bash` استعمال ہوتا ہے، تو یقینی بنائیں کہ پرامپٹس غیر معتبر صارف ان پٹ سے من مانی کمانڈ انجیکشن کی اجازت نہ دیں۔
- **مقامی طور پر جانچ کریں**: جانچ کے لیے `openclaw agent --message "use my new skill"` استعمال کریں۔

## مشترکہ Skills

آپ [ClawHub](https://clawhub.com) پر Skills دیکھ بھی سکتے ہیں اور اپنا حصہ بھی ڈال سکتے ہیں۔
