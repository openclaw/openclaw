---
summary: "प्लेटफ़ॉर्म समर्थन का अवलोकन (Gateway + सहचर ऐप्स)"
read_when:
  - OS समर्थन या इंस्टॉल पथ खोज रहे हों
  - यह तय कर रहे हों कि Gateway कहाँ चलाना है
title: "प्लेटफ़ॉर्म"
---

# प्लेटफ़ॉर्म

OpenClaw core is written in TypeScript. **Node is the recommended runtime**.
Bun is not recommended for the Gateway (WhatsApp/Telegram bugs).

macOS (menu bar app) और mobile nodes (iOS/Android) के लिए companion apps मौजूद हैं। Windows and
Linux companion apps are planned, but the Gateway is fully supported today.
Native companion apps for Windows are also planned; the Gateway is recommended via WSL2.

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

- macOS: LaunchAgent (`bot.molt.gateway` or `bot.molt.<profile>`; legacy `com.openclaw.*`)
- Linux/WSL2: systemd यूज़र सेवा (`openclaw-gateway[-<profile>].service`)
