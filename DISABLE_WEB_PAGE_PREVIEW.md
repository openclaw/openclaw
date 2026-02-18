# disableWebPagePreview Feature

## Overview

Added support for disabling web page previews in Telegram messages via the `disableWebPagePreview` parameter.

## Usage

### Using message tool
```javascript
message({
  action: 'send',
  target: '@username',
  message: 'Check out https://example.com - no preview!',
  disableWebPagePreview: true
})
```

### Using telegram actions directly
```javascript
await sendMessageTelegram('chat_id', 'Text with https://link.com', {
  disableWebPagePreview: true
})
```

## Implementation Details

- **TelegramSendOpts**: Added `disableWebPagePreview?: boolean` parameter
- **Send Logic**: Support `disable_web_page_preview` in text, media, and poll messages
- **Message Tool**: Added TypeBox validation for the new parameter  
- **Telegram Actions**: Wire parameter through to `sendMessageTelegram`

## Files Modified

- `src/telegram/send.ts` - Core implementation
- `src/agents/tools/message-tool.ts` - Schema validation  
- `src/agents/tools/telegram-actions.ts` - Integration

## Testing

All modified files pass syntax validation:
- ✅ `node --check src/telegram/send.ts`
- ✅ `node --check src/agents/tools/telegram-actions.ts` 
- ✅ `node --check src/agents/tools/message-tool.ts`

Perfect for weekly digest messages where link previews would clutter the chat! 📰