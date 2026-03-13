# Connect (OAuth) API

## Endpoints

| Method  | Endpoint                          | Description                    |
| ------- | --------------------------------- | ------------------------------ |
| `GET`   | `/v1/connect/{platform}`          | Start OAuth flow               |
| `POST`  | `/v1/connect/bluesky/credentials` | Connect Bluesky (app password) |
| `GET`   | `/v1/connect/telegram`            | Generate Telegram access code  |
| `POST`  | `/v1/connect/telegram`            | Direct connect via chat ID     |
| `PATCH` | `/v1/connect/telegram`            | Poll connection status         |

## Platform Selection Endpoints

Some platforms require selecting a page/location after OAuth:

| Method | Endpoint                                     | Description                  |
| ------ | -------------------------------------------- | ---------------------------- |
| `GET`  | `/v1/connect/facebook/select-page`           | List Facebook pages          |
| `POST` | `/v1/connect/facebook/select-page`           | Select Facebook page         |
| `GET`  | `/v1/connect/linkedin/organizations`         | List available LinkedIn orgs |
| `POST` | `/v1/connect/linkedin/select-organization`   | Select LinkedIn org          |
| `GET`  | `/v1/connect/googlebusiness/locations`       | List GMB locations           |
| `POST` | `/v1/connect/googlebusiness/select-location` | Select GMB location          |
| `GET`  | `/v1/connect/pinterest/select-board`         | List Pinterest boards        |
| `POST` | `/v1/connect/pinterest/select-board`         | Select Pinterest board       |
| `GET`  | `/v1/connect/snapchat/select-profile`        | List Snapchat profiles       |
| `POST` | `/v1/connect/snapchat/select-profile`        | Select Snapchat profile      |

## OAuth Flow

### Standard OAuth (most platforms)

```bash
# Get OAuth URL
curl "https://getlate.dev/api/v1/connect/twitter?profileId=PROFILE_ID&callbackUrl=https://yourapp.com/callback" \
  -H "Authorization: Bearer YOUR_API_KEY"
```

Returns `{ "url": "https://twitter.com/oauth/..." }` - redirect user there.

### Bluesky (App Password)

```bash
curl -X POST https://getlate.dev/api/v1/connect/bluesky/credentials \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "profileId": "PROFILE_ID",
    "identifier": "user.bsky.social",
    "appPassword": "xxxx-xxxx-xxxx-xxxx"
  }'
```

### Telegram

**Option 1: Access Code Flow (recommended)**

```bash
# 1. Generate access code
curl "https://getlate.dev/api/v1/connect/telegram?profileId=PROFILE_ID" \
  -H "Authorization: Bearer YOUR_API_KEY"

# Returns: { "code": "LATE-ABC123", "botUsername": "LateScheduleBot", ... }

# 2. User adds bot to channel and sends code to bot
# 3. Poll for connection status
curl -X PATCH "https://getlate.dev/api/v1/connect/telegram?code=LATE-ABC123" \
  -H "Authorization: Bearer YOUR_API_KEY"

# Returns: { "status": "pending" } or { "status": "connected", "account": {...} }
```

**Option 2: Direct Chat ID (power users)**

```bash
curl -X POST https://getlate.dev/api/v1/connect/telegram \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "profileId": "PROFILE_ID",
    "chatId": "-1001234567890"
  }'
```

The Late bot must already be added as admin in your channel/group.

## Supported Platforms

| Platform        | Auth Method    | Notes                       |
| --------------- | -------------- | --------------------------- |
| Twitter/X       | OAuth 2.0 PKCE | Requires code verifier      |
| Instagram       | OAuth 2.0      | 2-step token exchange       |
| Facebook        | OAuth 2.0      | Requires page selection     |
| LinkedIn        | OAuth 2.0      | Optional org selection      |
| TikTok          | OAuth 2.0      | UX compliance required      |
| YouTube         | Google OAuth   | access_type=offline         |
| Pinterest       | OAuth 2.0      | Requires board selection    |
| Reddit          | OAuth 2.0      | Strict user-agent           |
| Bluesky         | App password   | No OAuth, uses AT Protocol  |
| Threads         | OAuth 2.0      | Similar to Instagram        |
| Google Business | Google OAuth   | Requires location selection |
| Telegram        | Chat ID        | Uses Late's bot             |
| Snapchat        | OAuth 2.0      | Allowlist-only              |
