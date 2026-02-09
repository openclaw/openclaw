---
summary: "`openclaw directory` के लिए CLI संदर्भ (self, peers, groups)"
read_when:
  - आप किसी चैनल के लिए संपर्क/समूह/self आईडी ढूंढना चाहते हैं
  - आप एक चैनल डायरेक्टरी एडेप्टर विकसित कर रहे हैं
title: "डायरेक्टरी"
---

# `openclaw directory`

उन चैनलों के लिए डायरेक्टरी लुकअप जो इसका समर्थन करते हैं (संपर्क/peers, समूह, और “me”).

## Common flags

- `--channel <name>`: चैनल आईडी/उपनाम (जब कई चैनल विन्यस्त हों तो आवश्यक; केवल एक विन्यस्त होने पर स्वचालित)
- `--account <id>`: खाता आईडी (डिफ़ॉल्ट: चैनल डिफ़ॉल्ट)
- `--json`: आउटपुट JSON

## Notes

- `directory` का उद्देश्य आपको ऐसे आईडी खोजने में मदद करना है जिन्हें आप अन्य कमांड्स में पेस्ट कर सकें (विशेषकर `openclaw message send --target ...`).
- कई चैनलों के लिए, परिणाम लाइव प्रदाता डायरेक्टरी के बजाय विन्यास-आधारित होते हैं (allowlists / विन्यस्त समूह).
- डिफ़ॉल्ट आउटपुट `id` (और कभी-कभी `name`) होता है, जिन्हें टैब से अलग किया जाता है; स्क्रिप्टिंग के लिए `--json` का उपयोग करें.

## `message send` के साथ परिणामों का उपयोग

```bash
openclaw directory peers list --channel slack --query "U0"
openclaw message send --channel slack --target user:U012ABCDEF --message "hello"
```

## ID formats (by channel)

- WhatsApp: `+15551234567` (DM), `1234567890-1234567890@g.us` (group)
- Telegram: `@username` या संख्यात्मक चैट आईडी; समूह संख्यात्मक आईडी होते हैं
- Slack: `user:U…` और `channel:C…`
- Discord: `user:<id>` और `channel:<id>`
- Matrix (plugin): `user:@user:server`, `room:!roomId:server`, या `#alias:server`
- Microsoft Teams (plugin): `user:<id>` और `conversation:<id>`
- Zalo (plugin): उपयोगकर्ता आईडी (Bot API)
- Zalo Personal / `zalouser` (plugin): `zca` से थ्रेड आईडी (DM/समूह) (`me`, `friend list`, `group list`)

## Self (“me”)

```bash
openclaw directory self --channel zalouser
```

## Peers (contacts/users)

```bash
openclaw directory peers list --channel zalouser
openclaw directory peers list --channel zalouser --query "name"
openclaw directory peers list --channel zalouser --limit 50
```

## Groups

```bash
openclaw directory groups list --channel zalouser
openclaw directory groups list --channel zalouser --query "work"
openclaw directory groups members --channel zalouser --group-id <id>
```
