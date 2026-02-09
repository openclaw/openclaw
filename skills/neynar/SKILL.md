---
name: neynar
description: Interact with Farcaster via Neynar API. Use when the user wants to read Farcaster feeds, look up users, post casts, search content, or interact with the Farcaster social protocol. Requires NEYNAR_API_KEY.
metadata: {"openclaw":{"emoji":"🟪","homepage":"https://neynar.com","requires":{"bins":["curl","jq"]}}}
---

# Neynar (Farcaster API)

Interact with the Farcaster decentralized social protocol via Neynar's API.

## Quick Start

### Setup

1. Get an API key from [dev.neynar.com](https://dev.neynar.com)
2. Create config:

```bash
mkdir -p ~/.clawdbot/skills/neynar
cat > ~/.clawdbot/skills/neynar/config.json << 'EOF'
{
  "apiKey": "YOUR_NEYNAR_API_KEY",
  "signerUuid": "YOUR_SIGNER_UUID"
}
EOF
```

**Note**: `signerUuid` is only required for posting casts. Get one via Neynar's signer management.

### Verify Setup

```bash
scripts/neynar.sh user dwr.eth
```

## Core Concepts

- **FID** — Farcaster ID, a permanent numeric identifier for each user
- **Cast** — A post on Farcaster (like a tweet)
- **Channel** — Topic-based feeds (like subreddits)
- **Frame** — Interactive mini-apps embedded in casts

## Usage

### User Lookup

```bash
# By username
scripts/neynar.sh user vitalik.eth

# By FID
scripts/neynar.sh user --fid 5650

# Multiple users
scripts/neynar.sh users dwr.eth,v,jessepollak
```

### Read Feed

```bash
# User's casts
scripts/neynar.sh feed --user dwr.eth

# Channel feed
scripts/neynar.sh feed --channel base

# Trending feed
scripts/neynar.sh feed --trending

# Following feed (requires signer)
scripts/neynar.sh feed --following
```

### Search

```bash
# Search casts
scripts/neynar.sh search "ethereum"

# Search users
scripts/neynar.sh search-users "vitalik"

# Search in channel
scripts/neynar.sh search "onchain summer" --channel base
```

### Get Cast

```bash
# By hash
scripts/neynar.sh cast 0x1234abcd...

# By URL
scripts/neynar.sh cast "https://warpcast.com/dwr.eth/0x1234"
```

### Post Cast (requires signer)

```bash
# Simple cast
scripts/neynar.sh post "gm farcaster"

# Reply to cast
scripts/neynar.sh post "great point!" --reply-to 0x1234abcd

# Cast in channel
scripts/neynar.sh post "hello base" --channel base

# Cast with embed
scripts/neynar.sh post "check this out" --embed "https://example.com"
```

### Reactions

```bash
# Like a cast
scripts/neynar.sh like 0x1234abcd

# Recast
scripts/neynar.sh recast 0x1234abcd
```

### Follow/Unfollow

```bash
scripts/neynar.sh follow dwr.eth
scripts/neynar.sh unfollow dwr.eth
```

## API Reference

### Endpoints Used

| Action | Endpoint | Auth |
|--------|----------|------|
| User lookup | `GET /v2/farcaster/user/by_username` | API key |
| User by FID | `GET /v2/farcaster/user/bulk` | API key |
| User feed | `GET /v2/farcaster/feed/user/casts` | API key |
| Channel feed | `GET /v2/farcaster/feed/channels` | API key |
| Trending | `GET /v2/farcaster/feed/trending` | API key |
| Search casts | `GET /v2/farcaster/cast/search` | API key |
| Get cast | `GET /v2/farcaster/cast` | API key |
| Post cast | `POST /v2/farcaster/cast` | API key + Signer |
| React | `POST /v2/farcaster/reaction` | API key + Signer |
| Follow | `POST /v2/farcaster/user/follow` | API key + Signer |

### Response Format

All responses are JSON. The script extracts key fields for readability:

```json
{
  "user": {
    "fid": 3,
    "username": "dwr.eth",
    "display_name": "Dan Romero",
    "follower_count": 450000,
    "following_count": 2800,
    "verified_addresses": ["0x..."]
  }
}
```

## Common Patterns

### Monitor a Channel

```bash
# Get latest casts from /base channel
scripts/neynar.sh feed --channel base --limit 20
```

### Find Active Users

```bash
# Search for users by keyword
scripts/neynar.sh search-users "ethereum developer"
```

### Cross-Post from Twitter

```bash
# Post same content to Farcaster
scripts/neynar.sh post "gm, just shipped a new feature 🚀"
```

### Reply to Mentions

```bash
# Get your notifications (requires signer)
scripts/neynar.sh notifications

# Reply to specific cast
scripts/neynar.sh post "thanks!" --reply-to 0xabc123
```

## Error Handling

| Error | Cause | Fix |
|-------|-------|-----|
| 401 Unauthorized | Invalid API key | Check `config.json` |
| 403 Forbidden | Signer required | Set up signer for write operations |
| 404 Not Found | User/cast doesn't exist | Verify username/hash |
| 429 Rate Limited | Too many requests | Wait and retry |

## Signer Setup

For write operations (posting, liking, following), you need a signer:

1. Go to [dev.neynar.com](https://dev.neynar.com)
2. Create a new signer or use managed signer
3. Add `signerUuid` to your config

**Managed signers** are easiest — Neynar handles the key custody.

## Rate Limits

- Free tier: 300 requests/minute
- Paid tiers: Higher limits available
- Check `X-RateLimit-Remaining` header

## Best Practices

1. **Cache user lookups** — FIDs don't change, usernames rarely do
2. **Use channels** — Better reach than random posting
3. **Engage genuinely** — Farcaster culture values authenticity
4. **Batch requests** — Use bulk endpoints when possible
5. **Handle rate limits** — Implement backoff

## Resources

- **Neynar Docs**: https://docs.neynar.com
- **API Reference**: https://docs.neynar.com/reference
- **Developer Portal**: https://dev.neynar.com
- **Farcaster Docs**: https://docs.farcaster.xyz

## Troubleshooting

### API Key Not Working

```bash
# Verify key works
curl -H "x-api-key: YOUR_KEY" \
  "https://api.neynar.com/v2/farcaster/user/bulk?fids=1"
```

### Signer Issues

- Ensure signer is approved and active
- Check signer permissions match your FID
- Managed signers are simpler than self-hosted

### Cast Not Appearing

- Casts propagate in seconds, but indexing may take longer
- Check the cast hash in the response
- Verify on warpcast.com directly
