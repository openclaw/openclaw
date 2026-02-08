---
summary: "प्लेटफ़ॉर्म समर्थन का अवलोकन (Gateway + सहचर ऐप्स)"
read_when:
  - OS समर्थन या इंस्टॉल पथ खोज रहे हों
  - यह तय कर रहे हों कि Gateway कहाँ चलाना है
title: "प्लेटफ़ॉर्म"
x-i18n:
  source_path: platforms/index.md
  source_hash: 959479995f9ecca3
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:49:25Z
---

# प्लेटफ़ॉर्म

OpenClaw का कोर TypeScript में लिखा गया है। **Node अनुशंसित रनटाइम है**।
Gateway के लिए Bun की अनुशंसा नहीं की जाती (WhatsApp/Telegram बग्स के कारण)।

macOS (मेनू बार ऐप) और मोबाइल नोड्स (iOS/Android) के लिए सहचर ऐप्स उपलब्ध हैं। Windows और
Linux के लिए सहचर ऐप्स योजनाबद्ध हैं, लेकिन Gateway आज पूरी तरह समर्थित है।
Windows के लिए नेटिव सहचर ऐप्स भी योजनाबद्ध हैं; Gateway के लिए WSL2 के माध्यम से चलाने की अनुशंसा की जाती है।

## अपना OS चुनें

- macOS: [macOS](/platforms/macos)
- iOS: [iOS](/platforms/ios)
- Android: [Android](/platforms/android)
- Windows: [Windows](/platforms/windows)
- Linux: [Linux](/platforms/linux)

## VPS और होस्टिंग

- VPS हब: [VPS hosting](/vps)
- Fly.io: [Fly.io](/install/fly)
- Hetzner (Docker): [Hetzner](/install/hetzner)
- GCP (Compute Engine): [GCP](/install/gcp)
- exe.dev (VM + HTTPS प्रॉक्सी): [exe.dev](/install/exe-dev)

## सामान्य लिंक

- इंस्टॉल गाइड: [आरंभ करें](/start/getting-started)
- Gateway रनबुक: [Gateway](/gateway)
- Gateway विन्यास: [Configuration](/gateway/configuration)
- सेवा स्थिति: `openclaw gateway status`

## Gateway सेवा इंस्टॉल (CLI)

इनमें से किसी एक का उपयोग करें (सभी समर्थित हैं):

- विज़ार्ड (अनुशंसित): `openclaw onboard --install-daemon`
- डायरेक्ट: `openclaw gateway install`
- Configure फ्लो: `openclaw configure` → **Gateway सेवा** चुनें
- Repair/migrate: `openclaw doctor` (सेवा को इंस्टॉल करने या ठीक करने का विकल्प देता है)

सेवा लक्ष्य OS पर निर्भर करता है:

- macOS: LaunchAgent (`bot.molt.gateway` या `bot.molt.<profile>`; लेगेसी `com.openclaw.*`)
- Linux/WSL2: systemd यूज़र सेवा (`openclaw-gateway[-<profile>].service`)
