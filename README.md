# 🦞 OpenClaw — المساعد الشخصي بالذكاء الاصطناعي

<p align="center">
    <picture>
        <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/openclaw/openclaw/main/docs/assets/openclaw-logo-text-dark.png">
        <img src="https://raw.githubusercontent.com/openclaw/openclaw/main/docs/assets/openclaw-logo-text.png" alt="OpenClaw" width="500">
    </picture>
</p>

<p align="center">
  <strong>قشّر! قشّر!</strong>
</p>

<p align="center">
  <a href="https://github.com/openclaw/openclaw/actions/workflows/ci.yml?branch=main"><img src="https://img.shields.io/github/actions/workflow/status/openclaw/openclaw/ci.yml?branch=main&style=for-the-badge" alt="CI status"></a>
  <a href="https://github.com/openclaw/openclaw/releases"><img src="https://img.shields.io/github/v/release/openclaw/openclaw?include_prereleases&style=for-the-badge" alt="GitHub release"></a>
  <a href="https://discord.gg/clawd"><img src="https://img.shields.io/discord/1456350064065904867?label=Discord&logo=discord&logoColor=white&color=5865F2&style=for-the-badge" alt="Discord"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg?style=for-the-badge" alt="MIT License"></a>
</p>

**OpenClaw** هو _مساعد ذكاء اصطناعي شخصي_ يعمل على أجهزتك الخاصة.

يقوم بالرد عليك عبر القنوات التي تستخدمها بالفعل  
(WhatsApp، Telegram، Slack، Discord، Google Chat، Signal، iMessage، BlueBubbles، IRC، Microsoft Teams، Matrix، Feishu، LINE، Mattermost، Nextcloud Talk، Nostr، Synology Chat، Tlon، Twitch، Zalo، Zalo Personal، WebChat).

يمكنه التحدث والاستماع على **macOS و iOS و Android**، كما يمكنه عرض **Canvas تفاعلي مباشر** يمكنك التحكم به.

الـ **Gateway** هو مجرد طبقة التحكم (Control Plane) — أما المنتج الحقيقي فهو **المساعد نفسه**.

إذا كنت تريد مساعدًا شخصيًا يعمل لمستخدم واحد، سريعًا، محليًا، ويعمل دائمًا — فهذا هو الحل.

[الموقع](https://openclaw.ai) ·  
[التوثيق](https://docs.openclaw.ai) ·  
[الرؤية](VISION.md) ·  
[DeepWiki](https://deepwiki.com/openclaw/openclaw) ·  
[البدء](https://docs.openclaw.ai/start/getting-started) ·  
[التحديث](https://docs.openclaw.ai/install/updating) ·  
[العرض](https://docs.openclaw.ai/start/showcase) ·  
[الأسئلة الشائعة](https://docs.openclaw.ai/help/faq) ·  
[المعالج Wizard](https://docs.openclaw.ai/start/wizard) ·  
[Nix](https://github.com/openclaw/nix-openclaw) ·  
[Docker](https://docs.openclaw.ai/install/docker) ·  
[Discord](https://discord.gg/clawd)

الإعداد المفضل: تشغيل معالج الإعداد (`openclaw onboard`) داخل الطرفية.

سيقوم المعالج بإرشادك خطوة بخطوة لإعداد:

- الـ Gateway
- مساحة العمل
- القنوات
- المهارات (Skills)

معالج CLI هو المسار الموصى به ويعمل على:

**macOS، Linux، و Windows (عبر WSL2 — موصى به بشدة)**

يعمل مع:

- npm
- pnpm
- bun

إذا كان هذا تثبيتًا جديدًا، ابدأ من هنا:

[البدء](https://docs.openclaw.ai/start/getting-started)

---

## الرعاة

| OpenAI | Vercel | Blacksmith | Convex |
|------|------|------|------|
| [![OpenAI](docs/assets/sponsors/openai.svg)](https://openai.com/) | [![Vercel](docs/assets/sponsors/vercel.svg)](https://vercel.com/) | [![Blacksmith](docs/assets/sponsors/blacksmith.svg)](https://blacksmith.sh/) | [![Convex](docs/assets/sponsors/convex.svg)](https://www.convex.dev/) |

### الاشتراكات (OAuth)

- **OpenAI** (ChatGPT / Codex)

ملاحظة حول النماذج:  
على الرغم من دعم العديد من المزودين والنماذج، للحصول على أفضل تجربة وتقليل مخاطر **prompt injection** يُنصح باستخدام **أقوى نموذج متاح من الجيل الأحدث**.

راجع:

[Onboarding](https://docs.openclaw.ai/start/onboarding)

---

## النماذج (الاختيار والمصادقة)

- إعداد النماذج وواجهة CLI:  
  [Models](https://docs.openclaw.ai/concepts/models)

- التبديل بين ملفات المصادقة (OAuth أو API Keys) مع آلية fallback:  
  [Model failover](https://docs.openclaw.ai/concepts/model-failover)

---

## التثبيت (موصى به)

بيئة التشغيل المطلوبة:

**Node ≥ 22**

```bash
npm install -g openclaw@latest
# أو
pnpm add -g openclaw@latest

openclaw onboard --install-daemon
