---
summary: "Bun वर्कफ़्लो (प्रयोगात्मक): pnpm की तुलना में इंस्टॉल और सामान्य समस्याएँ"
read_when:
  - आप सबसे तेज़ स्थानीय डेवलपमेंट लूप चाहते हैं (bun + watch)
  - आप Bun के install/patch/lifecycle script से जुड़ी समस्याओं से टकराते हैं
title: "Bun (प्रयोगात्मक)"
---

# Bun (प्रयोगात्मक)

लक्ष्य: pnpm वर्कफ़्लो से अलग हुए बिना इस रिपॉज़िटरी को **Bun** के साथ चलाना (वैकल्पिक, WhatsApp/Telegram के लिए अनुशंसित नहीं)।

प्रोडक्शन के लिए Node का उपयोग करें। Note: `bun.lock`/`bun.lockb` gitignored हैं, इसलिए किसी भी तरह repo churn नहीं होता।

## Status

- Bun, TypeScript को सीधे चलाने के लिए एक वैकल्पिक स्थानीय रनटाइम है (`bun run …`, `bun --watch …`)।
- `pnpm` बिल्ड के लिए डिफ़ॉल्ट है और पूर्ण रूप से समर्थित रहता है (और कुछ डॉक्स टूलिंग द्वारा उपयोग किया जाता है)।
- Bun, `pnpm-lock.yaml` का उपयोग नहीं कर सकता और इसे अनदेखा करेगा।

## Install

डिफ़ॉल्ट:

```sh
bun install
```

अगर आप _no lockfile writes_ चाहते हैं: Bun, dependency lifecycle scripts को तब तक ब्लॉक कर सकता है जब तक उन्हें स्पष्ट रूप से trusted न किया जाए (`bun pm untrusted` / `bun pm trust`)।

```sh
bun install --no-save
```

## Build / Test (Bun)

```sh
bun run build
bun run vitest run
```

## Bun lifecycle scripts (डिफ़ॉल्ट रूप से अवरुद्ध)

इस repo के लिए, आमतौर पर ब्लॉक होने वाले scripts आवश्यक नहीं हैं:
कुछ scripts अभी भी pnpm को हार्डकोड करते हैं (उदा. `docs:build`, `ui:*`, `protocol:check`)।

- `@whiskeysockets/baileys` `preinstall`: Node major >= 20 की जाँच करता है (हम Node 22+ चलाते हैं)।
- `protobufjs` `postinstall`: असंगत संस्करण योजनाओं के बारे में चेतावनियाँ देता है (कोई बिल्ड आर्टिफ़ैक्ट नहीं)।

यदि आपको किसी वास्तविक रनटाइम समस्या का सामना होता है जिसके लिए इन scripts की आवश्यकता हो, तो उन्हें स्पष्ट रूप से भरोसेमंद बनाएँ:

```sh
bun pm trust @whiskeysockets/baileys protobufjs
```

## Caveats

- अभी के लिए उन्हें pnpm के ज़रिए चलाएँ। **dev**: `main` का moving head (git)।
