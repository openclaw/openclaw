# Telegram Routing Reference

**App name:** `telegram`
**Base URL proxied:** `api.telegram.org`

## API Path Pattern

```
/telegram/:token/{method}
```

The `:token` placeholder is automatically replaced with the bot token from the connection configuration.

## Common Endpoints

### Get Bot Info

```bash
GET /telegram/:token/getMe
```

### Get Updates

```bash
POST /telegram/:token/getUpdates
Content-Type: application/json

{
  "limit": 100,
  "timeout": 30
}
```

### Send Message

```bash
POST /telegram/:token/sendMessage
Content-Type: application/json

{
  "chat_id": 123456789,
  "text": "Hello!",
  "parse_mode": "HTML"
}
```

### Send Photo

```bash
POST /telegram/:token/sendPhoto
Content-Type: application/json

{
  "chat_id": 123456789,
  "photo": "https://example.com/image.jpg",
  "caption": "Photo caption"
}
```

### Send Document

```bash
POST /telegram/:token/sendDocument
Content-Type: application/json

{
  "chat_id": 123456789,
  "document": "https://example.com/file.pdf"
}
```

### Send Location

```bash
POST /telegram/:token/sendLocation
Content-Type: application/json

{
  "chat_id": 123456789,
  "latitude": 37.7749,
  "longitude": -122.4194
}
```

### Send Poll

```bash
POST /telegram/:token/sendPoll
Content-Type: application/json

{
  "chat_id": 123456789,
  "question": "What is your favorite?",
  "options": [{"text": "Option 1"}, {"text": "Option 2"}]
}
```

### Edit Message

```bash
POST /telegram/:token/editMessageText
Content-Type: application/json

{
  "chat_id": 123456789,
  "message_id": 123,
  "text": "Updated text"
}
```

### Delete Message

```bash
POST /telegram/:token/deleteMessage
Content-Type: application/json

{
  "chat_id": 123456789,
  "message_id": 123
}
```

### Forward Message

```bash
POST /telegram/:token/forwardMessage
Content-Type: application/json

{
  "chat_id": 123456789,
  "from_chat_id": 123456789,
  "message_id": 123
}
```

### Get Chat

```bash
POST /telegram/:token/getChat
Content-Type: application/json

{
  "chat_id": 123456789
}
```

### Set Bot Commands

```bash
POST /telegram/:token/setMyCommands
Content-Type: application/json

{
  "commands": [
    {"command": "start", "description": "Start the bot"},
    {"command": "help", "description": "Get help"}
  ]
}
```

### Get File

```bash
POST /telegram/:token/getFile
Content-Type: application/json

{
  "file_id": "AgACAgQAAxkDAAM..."
}
```

### Set Webhook

```bash
POST /telegram/:token/setWebhook
Content-Type: application/json

{
  "url": "https://example.com/webhook",
  "allowed_updates": ["message", "callback_query"]
}
```

### Answer Callback Query

```bash
POST /telegram/:token/answerCallbackQuery
Content-Type: application/json

{
  "callback_query_id": "12345678901234567",
  "text": "Button clicked!"
}
```

## Notes

- The `:token` placeholder is automatically replaced with the bot token
- Chat IDs are positive integers for private chats, negative for groups
- All methods support both GET and POST, but POST is recommended
- Text messages have a 4096 character limit
- Captions have a 1024 character limit
- Polls support 2-10 options
- Files can be sent via URL or file_id from previously uploaded files

## Resources

- [Telegram Bot API Documentation](https://core.telegram.org/bots/api)
- [Available Methods](https://core.telegram.org/bots/api#available-methods)
- [Formatting Options](https://core.telegram.org/bots/api#formatting-options)
