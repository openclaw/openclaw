# Late API Skill

[![skills.sh](https://img.shields.io/badge/skills.sh-late--api-blue)](https://skills.sh)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Official Claude Code skill for the [Late](https://getlate.dev) Social Media Scheduling API.

## Installation

```bash
npx skills add mikipalet/skills/late-api
```

## What's Included

- **Authentication** - API key setup and usage
- **Quick Start** - Get posting in 4 steps
- **All Endpoints** - Posts, accounts, profiles, webhooks, media
- **Platform-Specific** - Features for all 13 platforms
- **Webhooks** - Setup and signature verification
- **Error Handling** - Common errors and solutions
- **Code Examples** - curl, TypeScript, Python

## 13 Platforms Supported

Twitter/X, Instagram, Facebook, LinkedIn, TikTok, YouTube, Pinterest, Reddit, Bluesky, Threads, Google Business, Telegram, Snapchat

## Usage

Once installed, Claude Code will help you with Late API integration:

```
/late-api
```

## Example Prompts

- "How do I create a post with the Late API?"
- "Show me how to set up webhooks"
- "What's the endpoint for connecting a Twitter account?"
- "How do I upload media to Late?"

## Quick Example

```typescript
const response = await fetch("https://getlate.dev/api/v1/posts", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${process.env.LATE_API_KEY}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    content: "Hello from Late API!",
    platforms: [{ platform: "twitter", accountId: "acc_123" }],
    publishNow: true,
  }),
});
```

## Resources

- **Docs:** [getlate.dev/docs](https://getlate.dev/docs)
- **Dashboard:** [getlate.dev/dashboard](https://getlate.dev/dashboard)
- **API Keys:** [getlate.dev/dashboard/api-keys](https://getlate.dev/dashboard/api-keys)

## License

MIT

---

_[Late](https://getlate.dev) - Social Media Scheduling API for Developers_
