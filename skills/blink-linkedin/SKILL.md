---
name: blink-linkedin
description: >
  Access LinkedIn profile, share posts, and view professional information.
  Use when asked to post on LinkedIn, check profile details, or share
  professional updates. Requires a linked LinkedIn connection.
metadata:
  { "blink": { "requires_env": ["BLINK_API_KEY", "BLINK_AGENT_ID"], "connector": "linkedin" } }
---

# Blink LinkedIn

Access the user's LinkedIn account. Provider key: `linkedin`.

## Get your profile
```bash
bash scripts/call.sh linkedin /me GET
```

## Get profile with specific fields
```bash
bash scripts/call.sh linkedin /me GET \
  '{"fields": "id,localizedFirstName,localizedLastName,profilePicture"}'
```

## Get user info (OpenID Connect)
```bash
bash scripts/call.sh linkedin /userinfo GET
```

## Create a text post (share)
```bash
bash scripts/call.sh linkedin /ugcPosts POST '{
  "author": "urn:li:person:PERSON_ID",
  "lifecycleState": "PUBLISHED",
  "specificContent": {
    "com.linkedin.ugc.ShareContent": {
      "shareCommentary": {
        "text": "Excited to share our latest update! #Innovation #AI"
      },
      "shareMediaCategory": "NONE"
    }
  },
  "visibility": {
    "com.linkedin.ugc.MemberNetworkVisibility": "PUBLIC"
  }
}'
```

## Notes on LinkedIn API
- Get your person URN from `/me` response (the `id` field) to use as author
- Posts are visible to your network by default
- LinkedIn API has rate limits — avoid posting more than a few times per day

## Common use cases
- "Post an update on LinkedIn about our product launch" → create ugcPost
- "What's my LinkedIn profile info?" → get /me
- "Share our latest blog post on LinkedIn" → create ugcPost with article share
