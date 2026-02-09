---
summary: "`openclaw message` के लिए CLI संदर्भ (संदेश भेजना + चैनल क्रियाएँ)"
read_when:
  - संदेश CLI क्रियाएँ जोड़ते या संशोधित करते समय
  - आउटबाउंड चैनल व्यवहार बदलते समय
title: "संदेश"
---

# `openclaw message`

संदेश भेजने और चैनल क्रियाओं के लिए एकल आउटबाउंड कमांड
(Discord/Google Chat/Slack/Mattermost (प्लगइन)/Telegram/WhatsApp/Signal/iMessage/MS Teams)।

## उपयोग

```
openclaw message <subcommand> [flags]
```

चैनल चयन:

- `--channel` आवश्यक है यदि एक से अधिक चैनल विन्यस्त हैं।
- यदि ठीक एक चैनल विन्यस्त है, तो वही डिफ़ॉल्ट बन जाता है।
- मान: `whatsapp|telegram|discord|googlechat|slack|mattermost|signal|imessage|msteams` (Mattermost के लिए प्लगइन आवश्यक)

लक्ष्य प्रारूप (`--target`):

- WhatsApp: E.164 या समूह JID
- Telegram: चैट आईडी या `@username`
- Discord: `channel:<id>` या `user:<id>` (या `<@id>` मेंशन; कच्चे संख्यात्मक आईडी को चैनल माना जाता है)
- Google Chat: `spaces/<spaceId>` या `users/<userId>`
- Slack: `channel:<id>` या `user:<id>` (कच्चा चैनल आईडी स्वीकार्य है)
- Mattermost (प्लगइन): `channel:<id>`, `user:<id>`, या `@username` (साधारण आईडी को चैनल माना जाता है)
- Signal: `+E.164`, `group:<id>`, `signal:+E.164`, `signal:group:<id>`, या `username:<name>`/`u:<name>`
- iMessage: हैंडल, `chat_id:<id>`, `chat_guid:<guid>`, या `chat_identifier:<id>`
- MS Teams: वार्तालाप आईडी (`19:...@thread.tacv2`) या `conversation:<id>` या `user:<aad-object-id>`

नाम लुकअप:

- समर्थित प्रदाताओं (Discord/Slack/आदि) के लिए, `Help` या `#help` जैसे चैनल नाम डायरेक्टरी कैश के माध्यम से हल किए जाते हैं।
- कैश मिस होने पर, प्रदाता समर्थन करता हो तो OpenClaw लाइव डायरेक्टरी लुकअप का प्रयास करेगा।

## सामान्य फ़्लैग

- `--channel <name>`
- `--account <id>`
- `--target <dest>` (send/poll/read/आदि के लिए लक्ष्य चैनल या उपयोगकर्ता)
- `--targets <name>` (दोहराएँ; केवल ब्रॉडकास्ट)
- `--json`
- `--dry-run`
- `--verbose`

## क्रियाएँ

### कोर

- `send`
  - चैनल: WhatsApp/Telegram/Discord/Google Chat/Slack/Mattermost (प्लगइन)/Signal/iMessage/MS Teams
  - आवश्यक: `--target`, तथा `--message` या `--media`
  - वैकल्पिक: `--media`, `--reply-to`, `--thread-id`, `--gif-playback`
  - केवल Telegram: `--buttons` (इसे अनुमति देने के लिए `channels.telegram.capabilities.inlineButtons` आवश्यक)
  - केवल Telegram: `--thread-id` (फ़ोरम टॉपिक आईडी)
  - केवल Slack: `--thread-id` (थ्रेड टाइमस्टैम्प; `--reply-to` उसी फ़ील्ड का उपयोग करता है)
  - केवल WhatsApp: `--gif-playback`

- `poll`
  - चैनल: WhatsApp/Discord/MS Teams
  - आवश्यक: `--target`, `--poll-question`, `--poll-option` (दोहराएँ)
  - वैकल्पिक: `--poll-multi`
  - केवल Discord: `--poll-duration-hours`, `--message`

- `react`
  - चैनल: Discord/Google Chat/Slack/Telegram/WhatsApp/Signal
  - आवश्यक: `--message-id`, `--target`
  - वैकल्पिक: `--emoji`, `--remove`, `--participant`, `--from-me`, `--target-author`, `--target-author-uuid`
  - टिप्पणी: `--remove` के लिए `--emoji` आवश्यक है (जहाँ समर्थित हो वहाँ अपनी प्रतिक्रियाएँ हटाने के लिए `--emoji` छोड़ दें; /tools/reactions देखें)
  - केवल WhatsApp: `--participant`, `--from-me`
  - Signal समूह प्रतिक्रियाएँ: `--target-author` या `--target-author-uuid` आवश्यक

- `reactions`
  - चैनल: Discord/Google Chat/Slack
  - आवश्यक: `--message-id`, `--target`
  - वैकल्पिक: `--limit`

- `read`
  - चैनल: Discord/Slack
  - आवश्यक: `--target`
  - वैकल्पिक: `--limit`, `--before`, `--after`
  - केवल Discord: `--around`

- `edit`
  - चैनल: Discord/Slack
  - आवश्यक: `--message-id`, `--message`, `--target`

- `delete`
  - चैनल: Discord/Slack/Telegram
  - आवश्यक: `--message-id`, `--target`

- `pin` / `unpin`
  - चैनल: Discord/Slack
  - आवश्यक: `--message-id`, `--target`

- `pins` (सूची)
  - चैनल: Discord/Slack
  - आवश्यक: `--target`

- `permissions`
  - चैनल: Discord
  - आवश्यक: `--target`

- `search`
  - चैनल: Discord
  - आवश्यक: `--guild-id`, `--query`
  - वैकल्पिक: `--channel-id`, `--channel-ids` (दोहराएँ), `--author-id`, `--author-ids` (दोहराएँ), `--limit`

### थ्रेड्स

- `thread create`
  - चैनल: Discord
  - आवश्यक: `--thread-name`, `--target` (चैनल आईडी)
  - वैकल्पिक: `--message-id`, `--message`, `--auto-archive-min`

- `thread list`
  - चैनल: Discord
  - आवश्यक: `--guild-id`
  - वैकल्पिक: `--channel-id`, `--include-archived`, `--before`, `--limit`

- `thread reply`
  - चैनल: Discord
  - आवश्यक: `--target` (थ्रेड आईडी), `--message`
  - वैकल्पिक: `--media`, `--reply-to`

### इमोजी

- `emoji list`
  - Discord: `--guild-id`
  - Slack: कोई अतिरिक्त फ़्लैग नहीं

- `emoji upload`
  - चैनल: Discord
  - आवश्यक: `--guild-id`, `--emoji-name`, `--media`
  - वैकल्पिक: `--role-ids` (दोहराएँ)

### स्टिकर्स

- `sticker send`
  - चैनल: Discord
  - आवश्यक: `--target`, `--sticker-id` (दोहराएँ)
  - वैकल्पिक: `--message`

- `sticker upload`
  - चैनल: Discord
  - आवश्यक: `--guild-id`, `--sticker-name`, `--sticker-desc`, `--sticker-tags`, `--media`

### भूमिकाएँ / चैनल / सदस्य / वॉइस

- `role info` (Discord): `--guild-id`
- `role add` / `role remove` (Discord): `--guild-id`, `--user-id`, `--role-id`
- `channel info` (Discord): `--target`
- `channel list` (Discord): `--guild-id`
- `member info` (Discord/Slack): `--user-id` (+ Discord के लिए `--guild-id`)
- `voice status` (Discord): `--guild-id`, `--user-id`

### घटनाएँ

- `event list` (Discord): `--guild-id`
- `event create` (Discord): `--guild-id`, `--event-name`, `--start-time`
  - वैकल्पिक: `--end-time`, `--desc`, `--channel-id`, `--location`, `--event-type`

### मॉडरेशन (Discord)

- `timeout`: `--guild-id`, `--user-id` (वैकल्पिक `--duration-min` या `--until`; टाइमआउट साफ़ करने के लिए दोनों छोड़ दें)
- `kick`: `--guild-id`, `--user-id` (+ `--reason`)
- `ban`: `--guild-id`, `--user-id` (+ `--delete-days`, `--reason`)
  - `timeout` भी `--reason` का समर्थन करता है

### ब्रॉडकास्ट

- `broadcast`
  - चैनल: कोई भी विन्यस्त चैनल; सभी प्रदाताओं को लक्ष्य करने के लिए `--channel all` का उपयोग करें
  - आवश्यक: `--targets` (दोहराएँ)
  - वैकल्पिक: `--message`, `--media`, `--dry-run`

## उदाहरण

Discord में उत्तर भेजें:

```
openclaw message send --channel discord \
  --target channel:123 --message "hi" --reply-to 456
```

Discord पोल बनाएँ:

```
openclaw message poll --channel discord \
  --target channel:123 \
  --poll-question "Snack?" \
  --poll-option Pizza --poll-option Sushi \
  --poll-multi --poll-duration-hours 48
```

Teams में प्रोएक्टिव संदेश भेजें:

```
openclaw message send --channel msteams \
  --target conversation:19:abc@thread.tacv2 --message "hi"
```

Teams पोल बनाएँ:

```
openclaw message poll --channel msteams \
  --target conversation:19:abc@thread.tacv2 \
  --poll-question "Lunch?" \
  --poll-option Pizza --poll-option Sushi
```

Slack में प्रतिक्रिया दें:

```
openclaw message react --channel slack \
  --target C123 --message-id 456 --emoji "✅"
```

Signal समूह में प्रतिक्रिया दें:

```
openclaw message react --channel signal \
  --target signal:group:abc123 --message-id 1737630212345 \
  --emoji "✅" --target-author-uuid 123e4567-e89b-12d3-a456-426614174000
```

Telegram इनलाइन बटन भेजें:

```
openclaw message send --channel telegram --target @mychat --message "Choose:" \
  --buttons '[ [{"text":"Yes","callback_data":"cmd:yes"}], [{"text":"No","callback_data":"cmd:no"}] ]'
```
