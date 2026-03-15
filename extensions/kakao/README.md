# OpenClaw KakaoTalk Channel Plugin

KakaoTalk channel integration for OpenClaw via **Kakao i Open Builder** skill server.

## Architecture

```
User → KakaoTalk Channel → Kakao i Open Builder → OpenClaw (skill server) → AI Response
                                   ↑                              ↓
                                   └─── Callback URL response ←───┘
```

## Setup

### Prerequisites

1. [Kakao Business](https://business.kakao.com/) account with KakaoTalk Channel
2. [Kakao i Open Builder](https://i.kakao.com/) bot setup
3. OpenClaw Gateway with publicly accessible HTTPS URL

### Configuration

```json5
// ~/.openclaw/config.json5
{
  channels: {
    kakao: {
      enabled: true,
      webhookPath: "/kakao/skill",  // default
      adminKey: "your-admin-key",   // or use KAKAO_ADMIN_KEY env var
      allowFrom: [],                // empty = allow all
    },
  },
}
```

### Kakao i Open Builder Setup

1. **Create Skill**:
   - Name: `OpenClaw`
   - URL: `https://your-openclaw-domain/kakao/skill`
   - Method: POST

2. **Connect to Scenario Block**:
   - Link to fallback block for all messages
   - Or link to specific utterance blocks

3. **Enable Callback** (recommended):
   - Allows async responses for long processing

## Limitations

- **5-second timeout**: Kakao requires skill server response within 5 seconds
  - Solution: Use callback mode (`useCallback: true`)

- **1000-char limit**: simpleText output max is 1000 characters
  - Solution: Auto-split into multiple outputs (max 3)

- **HTTPS required**: Skill server URL must be HTTPS

- **No streaming**: KakaoTalk doesn't support streaming responses

- **No push messages**: Unlike Telegram/LINE, Kakao skill server can only respond to user messages

## Kakao Skill Server API

### Request (Kakao → OpenClaw)

```json
{
  "userRequest": {
    "user": {
      "id": "encrypted_user_id"
    },
    "utterance": "user message",
    "callbackUrl": "https://..."
  }
}
```

### Response (OpenClaw → Kakao)

**Immediate response:**
```json
{
  "version": "2.0",
  "template": {
    "outputs": [
      { "simpleText": { "text": "AI response" } }
    ]
  }
}
```

**Callback mode (for long processing):**
```json
{
  "version": "2.0",
  "useCallback": true,
  "data": {
    "text": "Processing..."
  }
}
```

## License

MIT
