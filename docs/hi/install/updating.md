---
summary: "OpenClaw को सुरक्षित रूप से अपडेट करना (ग्लोबल इंस्टॉल या सोर्स), साथ ही रोलबैक रणनीति"
read_when:
  - OpenClaw को अपडेट करना
  - अपडेट के बाद कुछ टूट जाए
title: "अपडेट करना"
---

# अपडेट करना

OpenClaw तेज़ी से आगे बढ़ रहा है (pre “1.0”)। अपडेट्स को इंफ़्रा शिप करने की तरह ट्रीट करें: update → checks चलाएँ → restart (या `openclaw update` का उपयोग करें, जो restart करता है) → verify।

## अनुशंसित: वेबसाइट इंस्टॉलर को दोबारा चलाएँ (इन-प्लेस अपग्रेड)

**preferred** अपडेट पाथ वेबसाइट से installer को फिर से चलाना है। यह
मौजूदा इंस्टॉल्स को detect करता है, वहीं पर upgrade करता है, और ज़रूरत पड़ने पर `openclaw doctor` चलाता है।

```bash
curl -fsSL https://openclaw.ai/install.sh | bash
```

नोट्स:

- यदि आप ऑनबोर्डिंग विज़ार्ड को फिर से नहीं चलाना चाहते, तो `--no-onboard` जोड़ें।

- **सोर्स इंस्टॉल्स** के लिए, उपयोग करें:

  ```bash
  curl -fsSL https://openclaw.ai/install.sh | bash -s -- --install-method git --no-onboard
  ```

  इंस्टॉलर `git pull --rebase` **केवल** तभी करेगा जब रिपॉज़िटरी साफ़ हो।

- **ग्लोबल इंस्टॉल्स** के लिए, स्क्रिप्ट अंदरूनी तौर पर `npm install -g openclaw@latest` का उपयोग करती है।

- लेगेसी नोट: `clawdbot` संगतता शिम के रूप में उपलब्ध रहता है।

## अपडेट करने से पहले

- जानें कि आपने कैसे इंस्टॉल किया: **ग्लोबल** (npm/pnpm) बनाम **सोर्स से** (git clone)।
- जानें कि आपका Gateway कैसे चल रहा है: **फ़ोरग्राउंड टर्मिनल** बनाम **सुपरवाइज़्ड सर्विस** (launchd/systemd)।
- अपने कस्टमाइज़ेशन का स्नैपशॉट लें:
  - Config: `~/.openclaw/openclaw.json`
  - Credentials: `~/.openclaw/credentials/`
  - Workspace: `~/.openclaw/workspace`

## अपडेट (ग्लोबल इंस्टॉल)

ग्लोबल इंस्टॉल (एक चुनें):

```bash
npm i -g openclaw@latest
```

```bash
pnpm add -g openclaw@latest
```

Gateway रनटाइम के लिए हम Bun की **अनुशंसा नहीं** करते (WhatsApp/Telegram बग्स)।

अपडेट चैनल बदलने के लिए (git + npm इंस्टॉल्स):

```bash
openclaw update --channel beta
openclaw update --channel dev
openclaw update --channel stable
```

एक-बार के इंस्टॉल टैग/वर्ज़न के लिए `--tag <dist-tag|version>` का उपयोग करें।

चैनल सेमांटिक्स और रिलीज़ नोट्स के लिए देखें: [Development channels](/install/development-channels)।

नोट: npm इंस्टॉल्स पर, गेटवे स्टार्टअप पर एक update hint लॉग करता है (current channel tag की जाँच करता है)। `update.checkOnStart: false` के ज़रिए इसे disable करें।

फिर:

```bash
openclaw doctor
openclaw gateway restart
openclaw health
```

नोट्स:

- यदि आपका Gateway एक सर्विस के रूप में चलता है, तो PIDs मारने की बजाय `openclaw gateway restart` को प्राथमिकता दें।
- यदि आप किसी विशिष्ट वर्ज़न पर पिन हैं, तो नीचे “Rollback / pinning” देखें।

## अपडेट (`openclaw update`)

**सोर्स इंस्टॉल्स** (git checkout) के लिए, प्राथमिकता दें:

```bash
openclaw update
```

यह एक सुरक्षित-सा अपडेट फ़्लो चलाता है:

- साफ़ worktree आवश्यक।
- चयनित चैनल (टैग या ब्रांच) पर स्विच करता है।
- कॉन्फ़िगर किए गए upstream (dev चैनल) के विरुद्ध फ़ेच + रिबेस करता है।
- डिपेंडेंसीज़ इंस्टॉल करता है, बिल्ड करता है, Control UI बनाता है, और `openclaw doctor` चलाता है।
- डिफ़ॉल्ट रूप से गेटवे रीस्टार्ट करता है (स्किप करने के लिए `--no-restart` का उपयोग करें)।

यदि आपने **npm/pnpm** के ज़रिए इंस्टॉल किया है (कोई git metadata नहीं), तो `openclaw update` आपके package manager के ज़रिए अपडेट करने की कोशिश करेगा। यदि यह इंस्टॉल detect नहीं कर पाता, तो “Update (global install)” का उपयोग करें।

## अपडेट (Control UI / RPC)

कंट्रोल UI में **Update & Restart** (RPC: `update.run`) होता है। यह:

1. `openclaw update` जैसा ही सोर्स-अपडेट फ़्लो चलाता है (केवल git checkout)।
2. एक संरचित रिपोर्ट (stdout/stderr टेल) के साथ एक रीस्टार्ट सेंटिनल लिखता है।
3. गेटवे रीस्टार्ट करता है और रिपोर्ट के साथ अंतिम सक्रिय सत्र को पिंग करता है।

यदि रिबेस विफल होता है, तो गेटवे अपडेट लागू किए बिना एबॉर्ट करता है और रीस्टार्ट हो जाता है।

## अपडेट (सोर्स से)

रिपॉज़िटरी checkout से:

प्राथमिक:

```bash
openclaw update
```

मैनुअल (लगभग समकक्ष):

```bash
git pull
pnpm install
pnpm build
pnpm ui:build # auto-installs UI deps on first run
openclaw doctor
openclaw health
```

नोट्स:

- `pnpm build` तब महत्वपूर्ण होता है जब आप पैकेज्ड `openclaw` बाइनरी ([`openclaw.mjs`](https://github.com/openclaw/openclaw/blob/main/openclaw.mjs)) चलाते हैं या Node का उपयोग करके `dist/` चलाते हैं।
- यदि आप बिना ग्लोबल इंस्टॉल के repo checkout से चला रहे हैं, तो CLI कमांड्स के लिए `pnpm openclaw ...` का उपयोग करें।
- यदि आप सीधे TypeScript से चला रहे हैं (`pnpm openclaw ...`), तो आमतौर पर रीबिल्ड आवश्यक नहीं होता, लेकिन **config माइग्रेशन फिर भी लागू होते हैं** → doctor चलाएँ।
- ग्लोबल और git इंस्टॉल्स के बीच स्विच करना आसान है: दूसरे फ्लेवर को इंस्टॉल करें, फिर `openclaw doctor` चलाएँ ताकि गेटवे सर्विस एंट्रीपॉइंट वर्तमान इंस्टॉल पर फिर से लिखा जाए।

## हमेशा चलाएँ: `openclaw doctor`

Doctor “safe update” कमांड है। यह जानबूझकर उबाऊ है: repair + migrate + warn।

नोट: यदि आप **सोर्स इंस्टॉल** (git checkout) पर हैं, तो `openclaw doctor` पहले `openclaw update` चलाने का प्रस्ताव देगा।

आम तौर पर यह जो करता है:

- डिप्रिकेटेड config keys / लेगेसी config फ़ाइल लोकेशंस का माइग्रेशन।
- DM नीतियों का ऑडिट और जोखिमपूर्ण “open” सेटिंग्स पर चेतावनी।
- Gateway स्वास्थ्य की जाँच और रीस्टार्ट का प्रस्ताव।
- पुराने गेटवे सर्विसेज़ (launchd/systemd; लेगेसी schtasks) का पता लगाना और उन्हें वर्तमान OpenClaw सेवाओं में माइग्रेट करना।
- Linux पर, systemd user lingering सुनिश्चित करना (ताकि Gateway लॉगआउट के बाद भी चलता रहे)।

विवरण: [Doctor](/gateway/doctor)

## Gateway को स्टार्ट / स्टॉप / रीस्टार्ट करें

CLI (OS से स्वतंत्र रूप से काम करता है):

```bash
openclaw gateway status
openclaw gateway stop
openclaw gateway restart
openclaw gateway --port 18789
openclaw logs --follow
```

यदि आप सुपरवाइज़्ड हैं:

- macOS launchd (app-bundled LaunchAgent): `launchctl kickstart -k gui/$UID/bot.molt.gateway` (use `bot.molt.<profile>`; legacy `com.openclaw.*` अभी भी काम करता है)
- Linux systemd user service: `systemctl --user restart openclaw-gateway[-<profile>].service`
- Windows (WSL2): `systemctl --user restart openclaw-gateway[-<profile>].service`
  - `launchctl`/`systemctl` केवल तभी काम करते हैं जब सर्विस इंस्टॉल हो; अन्यथा `openclaw gateway install` चलाएँ।

रनबुक + सटीक सर्विस लेबल्स: [Gateway runbook](/gateway)

## रोलबैक / पिनिंग (जब कुछ टूट जाए)

### पिन (ग्लोबल इंस्टॉल)

ज्ञात-अच्छा वर्ज़न इंस्टॉल करें (`<version>` को आख़िरी काम करने वाले से बदलें):

```bash
npm i -g openclaw@<version>
```

```bash
pnpm add -g openclaw@<version>
```

सुझाव: वर्तमान प्रकाशित वर्ज़न देखने के लिए `npm view openclaw version` चलाएँ।

फिर रीस्टार्ट + doctor दोबारा चलाएँ:

```bash
openclaw doctor
openclaw gateway restart
```

### पिन (सोर्स) तिथि के अनुसार

किसी तिथि से एक कमिट चुनें (उदाहरण: “2026-01-01 के अनुसार main की स्थिति”):

```bash
git fetch origin
git checkout "$(git rev-list -n 1 --before=\"2026-01-01\" origin/main)"
```

फिर डिपेंडेंसीज़ फिर से इंस्टॉल करें + रीस्टार्ट करें:

```bash
pnpm install
pnpm build
openclaw gateway restart
```

यदि बाद में आप नवीनतम पर वापस जाना चाहते हैं:

```bash
git checkout main
git pull
```

## यदि आप अटके हुए हैं

- `openclaw doctor` फिर से चलाएँ और आउटपुट ध्यान से पढ़ें (अक्सर यह समाधान बता देता है)।
- जाँचें: [समस्या-निवारण](/gateway/troubleshooting)
- Discord में पूछें: [https://discord.gg/clawd](https://discord.gg/clawd)
