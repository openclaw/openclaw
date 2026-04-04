---
name: authentication
description: How to configure API authentication for Flyworks/HiFly
---

# Authentication

## API Token

Flyworks uses bearer token authentication for all API requests.

### Getting Your Token

1. Register at [flyworks.ai](https://flyworks.ai) or [hifly.cc](https://hifly.cc)
2. Navigate to [User Settings](https://hifly.cc/setting)
3. Copy your API key

### Configuration

Set the environment variable:

```bash
export HIFLY_API_TOKEN="your_token_here"
```

### Demo Token

For testing, the skill includes a demo token with limitations:

- **30 second** maximum video duration
- **Watermark** on all videos

The demo token is automatically used if `HIFLY_API_TOKEN` is not set.

### API Request Format

All requests use the Authorization header:

```bash
curl -X GET "https://hfw-api.hifly.cc/api/v2/hifly/avatar/list" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json"
```
