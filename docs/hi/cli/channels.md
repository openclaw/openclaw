---
summary: "`openclaw channels` के लिए CLI संदर्भ (accounts, status, login/logout, logs)"
read_when:
  - आप चैनल खातों को जोड़ना/हटाना चाहते हैं (WhatsApp/Telegram/Discord/Google Chat/Slack/Mattermost (plugin)/Signal/iMessage)
  - आप चैनल की स्थिति जाँचना या चैनल लॉग्स को टेल करना चाहते हैं
title: "channels"
---

# `openclaw channels`

Gateway पर चैट चैनल खातों और उनकी रनटाइम स्थिति का प्रबंधन करें।

संबंधित दस्तावेज़:

- चैनल गाइड्स: [Channels](/channels/index)
- Gateway विन्यास: [Configuration](/gateway/configuration)

## सामान्य कमांड्स

```bash
openclaw channels list
openclaw channels status
openclaw channels capabilities
openclaw channels capabilities --channel discord --target channel:123
openclaw channels resolve --channel slack "#general" "@jane"
openclaw channels logs --channel all
```

## खाते जोड़ें / हटाएँ

```bash
openclaw channels add --channel telegram --token <bot-token>
openclaw channels remove --channel telegram --delete
```

सुझाव: `openclaw channels add --help` प्रति-चैनल फ़्लैग्स दिखाता है (token, app token, signal-cli paths, आदि)।

## लॉगिन / लॉगआउट (इंटरैक्टिव)

```bash
openclaw channels login --channel whatsapp
openclaw channels logout --channel whatsapp
```

## समस्या-निवारण

- व्यापक जाँच के लिए `openclaw status --deep` चलाएँ।
- निर्देशित सुधारों के लिए `openclaw doctor` का उपयोग करें।
- `openclaw channels list` `Claude: HTTP 403 ...` प्रिंट करता है `user:profile` → उपयोग स्नैपशॉट के लिए `user:profile` स्कोप आवश्यक है। `--no-usage` का उपयोग करें, या claude.ai सत्र कुंजी (`CLAUDE_WEB_SESSION_KEY` / `CLAUDE_WEB_COOKIE`) प्रदान करें, या Claude Code CLI के माध्यम से पुनः-प्रमाणीकरण करें।

## क्षमताओं की जाँच

उपलब्ध होने पर प्रदाता क्षमताओं के संकेत (intents/scopes) तथा स्थिर फीचर समर्थन प्राप्त करें:

```bash
openclaw channels capabilities
openclaw channels capabilities --channel discord --target channel:123
```

टिप्पणियाँ:

- `--channel` वैकल्पिक है; इसे छोड़ने पर सभी चैनल (एक्सटेंशन्स सहित) सूचीबद्ध होंगे।
- `--target` `channel:<id>` या एक कच्चा संख्यात्मक चैनल आईडी स्वीकार करता है और केवल Discord पर लागू होता है।
- Probes are provider-specific: Discord intents + optional channel permissions; Slack bot + user scopes; Telegram bot flags + webhook; Signal daemon version; MS Teams app token + Graph roles/scopes (annotated where known). Channels without probes report `Probe: unavailable`.

## नामों को आईडी में बदलें

प्रदाता निर्देशिका का उपयोग करके चैनल/उपयोगकर्ता नामों को आईडी में बदलें:

```bash
openclaw channels resolve --channel slack "#general" "@jane"
openclaw channels resolve --channel discord "My Server/#support" "@someone"
openclaw channels resolve --channel matrix "Project Room"
```

टिप्पणियाँ:

- लक्ष्य प्रकार को बाध्य करने के लिए `--kind user|group|auto` का उपयोग करें।
- जब एक ही नाम साझा करने वाली कई प्रविष्टियाँ हों, तो समाधान सक्रिय मिलानों को प्राथमिकता देता है।
