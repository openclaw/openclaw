---
summary: "`openclaw message` အတွက် CLI ကိုးကားချက် (ပို့ခြင်း + ချန်နယ် လုပ်ဆောင်ချက်များ)"
read_when:
  - မက်ဆေ့ချ် CLI လုပ်ဆောင်ချက်များကို ထည့်သွင်းခြင်း သို့မဟုတ် ပြင်ဆင်ခြင်း ပြုလုပ်သောအခါ
  - ထွက်ပေါ်သည့် ချန်နယ် အပြုအမူများကို ပြောင်းလဲသောအခါ
title: "message"
---

# `openclaw message`

မက်ဆေ့ချ်များ ပို့ခြင်းနှင့် ချန်နယ် လုပ်ဆောင်ချက်များအတွက် တစ်ခုတည်းသော ထွက်ပေါ်သည့် အမိန့်
(Discord/Google Chat/Slack/Mattermost (plugin)/Telegram/WhatsApp/Signal/iMessage/MS Teams)။

## Usage

```
openclaw message <subcommand> [flags]
```

ချန်နယ် ရွေးချယ်ခြင်း:

- ချန်နယ် တစ်ခုထက်ပိုပြီး ဖွဲ့စည်းထားပါက `--channel` လိုအပ်သည်။
- ချန်နယ် တစ်ခုတည်းသာ ဖွဲ့စည်းထားပါက ၎င်းသည် မူလအဖြစ် သတ်မှတ်သွားမည်ဖြစ်သည်။
- တန်ဖိုးများ: `whatsapp|telegram|discord|googlechat|slack|mattermost|signal|imessage|msteams` (Mattermost သည် plugin လိုအပ်သည်)

Target ဖော်မတ်များ (`--target`):

- WhatsApp: E.164 သို့မဟုတ် အုပ်စု JID
- Telegram: chat id သို့မဟုတ် `@username`
- Discord: `channel:<id>` သို့မဟုတ် `user:<id>` (သို့မဟုတ် `<@id>` mention; raw numeric ids များကို ချန်နယ်များအဖြစ် သတ်မှတ်သည်)
- Google Chat: `spaces/<spaceId>` သို့မဟုတ် `users/<userId>`
- Slack: `channel:<id>` သို့မဟုတ် `user:<id>` (raw channel id ကို လက်ခံသည်)
- Mattermost (plugin): `channel:<id>`, `user:<id>`, သို့မဟုတ် `@username` (bare ids များကို ချန်နယ်များအဖြစ် သတ်မှတ်သည်)
- Signal: `+E.164`, `group:<id>`, `signal:+E.164`, `signal:group:<id>`, သို့မဟုတ် `username:<name>`/`u:<name>`
- iMessage: handle, `chat_id:<id>`, `chat_guid:<guid>`, သို့မဟုတ် `chat_identifier:<id>`
- MS Teams: conversation id (`19:...@thread.tacv2`) သို့မဟုတ် `conversation:<id>` သို့မဟုတ် `user:<aad-object-id>`

အမည်ဖြင့် ရှာဖွေခြင်း:

- ပံ့ပိုးထားသော provider များ (Discord/Slack/စသည်) အတွက် `Help` သို့မဟုတ် `#help` ကဲ့သို့ ချန်နယ် အမည်များကို directory cache မှတစ်ဆင့် ဖြေရှင်းပေးသည်။
- cache မတွေ့ပါက provider မှ ပံ့ပိုးထားသည့် အခါ OpenClaw သည် live directory lookup ကို ကြိုးစားလုပ်ဆောင်မည်ဖြစ်သည်။

## Common flags

- `--channel <name>`
- `--account <id>`
- `--target <dest>` (send/poll/read စသည်တို့အတွက် ပစ်မှတ် ချန်နယ် သို့မဟုတ် အသုံးပြုသူ)
- `--targets <name>` (ထပ်ခါတလဲလဲ; broadcast အတွက်သာ)
- `--json`
- `--dry-run`
- `--verbose`

## Actions

### Core

- `send`
  - Channels: WhatsApp/Telegram/Discord/Google Chat/Slack/Mattermost (plugin)/Signal/iMessage/MS Teams
  - Required: `--target`, ထို့အပြင် `--message` သို့မဟုတ် `--media`
  - Optional: `--media`, `--reply-to`, `--thread-id`, `--gif-playback`
  - Telegram only: `--buttons` (`channels.telegram.capabilities.inlineButtons` ကို ခွင့်ပြုထားရန် လိုအပ်သည်)
  - Telegram only: `--thread-id` (forum topic id)
  - Slack only: `--thread-id` (thread timestamp; `--reply-to` သည် အတူတူသော field ကို အသုံးပြုသည်)
  - WhatsApp only: `--gif-playback`

- `poll`
  - Channels: WhatsApp/Discord/MS Teams
  - Required: `--target`, `--poll-question`, `--poll-option` (repeat)
  - Optional: `--poll-multi`
  - Discord only: `--poll-duration-hours`, `--message`

- `react`
  - Channels: Discord/Google Chat/Slack/Telegram/WhatsApp/Signal
  - Required: `--message-id`, `--target`
  - Optional: `--emoji`, `--remove`, `--participant`, `--from-me`, `--target-author`, `--target-author-uuid`
  - Note: `--remove` သည် `--emoji` လိုအပ်သည် (`--emoji` ကို ဖယ်ထားပါက ပံ့ပိုးထားသည့် အခါ ကိုယ်ပိုင် reactions များကို ဖယ်ရှားရန် အသုံးပြုနိုင်သည်; /tools/reactions ကို ကြည့်ပါ)
  - WhatsApp only: `--participant`, `--from-me`
  - Signal အုပ်စု reactions: `--target-author` သို့မဟုတ် `--target-author-uuid` လိုအပ်သည်

- `reactions`
  - Channels: Discord/Google Chat/Slack
  - Required: `--message-id`, `--target`
  - Optional: `--limit`

- `read`
  - Channels: Discord/Slack
  - Required: `--target`
  - Optional: `--limit`, `--before`, `--after`
  - Discord only: `--around`

- `edit`
  - Channels: Discord/Slack
  - Required: `--message-id`, `--message`, `--target`

- `delete`
  - Channels: Discord/Slack/Telegram
  - Required: `--message-id`, `--target`

- `pin` / `unpin`
  - Channels: Discord/Slack
  - Required: `--message-id`, `--target`

- `pins` (list)
  - Channels: Discord/Slack
  - Required: `--target`

- `permissions`
  - Channels: Discord
  - Required: `--target`

- `search`
  - Channels: Discord
  - Required: `--guild-id`, `--query`
  - Optional: `--channel-id`, `--channel-ids` (repeat), `--author-id`, `--author-ids` (repeat), `--limit`

### Threads

- `thread create`
  - Channels: Discord
  - Required: `--thread-name`, `--target` (channel id)
  - Optional: `--message-id`, `--message`, `--auto-archive-min`

- `thread list`
  - Channels: Discord
  - Required: `--guild-id`
  - Optional: `--channel-id`, `--include-archived`, `--before`, `--limit`

- `thread reply`
  - Channels: Discord
  - Required: `--target` (thread id), `--message`
  - Optional: `--media`, `--reply-to`

### Emojis

- `emoji list`
  - Discord: `--guild-id`
  - Slack: အပို flags မရှိပါ

- `emoji upload`
  - Channels: Discord
  - Required: `--guild-id`, `--emoji-name`, `--media`
  - Optional: `--role-ids` (repeat)

### Stickers

- `sticker send`
  - Channels: Discord
  - Required: `--target`, `--sticker-id` (repeat)
  - Optional: `--message`

- `sticker upload`
  - Channels: Discord
  - Required: `--guild-id`, `--sticker-name`, `--sticker-desc`, `--sticker-tags`, `--media`

### Roles / Channels / Members / Voice

- `role info` (Discord): `--guild-id`
- `role add` / `role remove` (Discord): `--guild-id`, `--user-id`, `--role-id`
- `channel info` (Discord): `--target`
- `channel list` (Discord): `--guild-id`
- `member info` (Discord/Slack): `--user-id` (+ Discord အတွက် `--guild-id`)
- `voice status` (Discord): `--guild-id`, `--user-id`

### Events

- `event list` (Discord): `--guild-id`
- `event create` (Discord): `--guild-id`, `--event-name`, `--start-time`
  - Optional: `--end-time`, `--desc`, `--channel-id`, `--location`, `--event-type`

### Moderation (Discord)

- `timeout`: `--guild-id`, `--user-id` (optional `--duration-min` သို့မဟုတ် `--until`; နှစ်ခုစလုံးကို မသုံးပါက timeout ကို ဖယ်ရှားမည်)
- `kick`: `--guild-id`, `--user-id` (+ `--reason`)
- `ban`: `--guild-id`, `--user-id` (+ `--delete-days`, `--reason`)
  - `timeout` သည် `--reason` ကိုလည်း ပံ့ပိုးထားသည်

### Broadcast

- `broadcast`
  - Channels: ဖွဲ့စည်းထားသော ချန်နယ် မည်သည့်တစ်ခုမဆို; provider အားလုံးကို ပစ်မှတ်ထားရန် `--channel all` ကို အသုံးပြုပါ
  - Required: `--targets` (repeat)
  - Optional: `--message`, `--media`, `--dry-run`

## Examples

Discord တွင် reply ပို့ခြင်း:

```
openclaw message send --channel discord \
  --target channel:123 --message "hi" --reply-to 456
```

Discord poll တစ်ခု ဖန်တီးခြင်း:

```
openclaw message poll --channel discord \
  --target channel:123 \
  --poll-question "Snack?" \
  --poll-option Pizza --poll-option Sushi \
  --poll-multi --poll-duration-hours 48
```

Teams proactive မက်ဆေ့ချ် ပို့ခြင်း:

```
openclaw message send --channel msteams \
  --target conversation:19:abc@thread.tacv2 --message "hi"
```

Teams poll တစ်ခု ဖန်တီးခြင်း:

```
openclaw message poll --channel msteams \
  --target conversation:19:abc@thread.tacv2 \
  --poll-question "Lunch?" \
  --poll-option Pizza --poll-option Sushi
```

Slack တွင် reaction ထည့်ခြင်း:

```
openclaw message react --channel slack \
  --target C123 --message-id 456 --emoji "✅"
```

Signal အုပ်စုတွင် reaction ထည့်ခြင်း:

```
openclaw message react --channel signal \
  --target signal:group:abc123 --message-id 1737630212345 \
  --emoji "✅" --target-author-uuid 123e4567-e89b-12d3-a456-426614174000
```

Telegram inline buttons ပို့ခြင်း:

```
openclaw message send --channel telegram --target @mychat --message "Choose:" \
  --buttons '[ [{"text":"Yes","callback_data":"cmd:yes"}], [{"text":"No","callback_data":"cmd:no"}] ]'
```
