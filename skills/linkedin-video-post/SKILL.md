---
name: linkedin-video-post
description: |
  Post videos to LinkedIn personal profiles and company/organization pages via the Maton-proxied LinkedIn API.
  Use when asked to post, share, or publish a video on LinkedIn. Handles video upload (chunked via legacy v2 assets API) and UGC post creation.
  Supports posting to personal profile, organization page, or both simultaneously.
  Requires MATON_API_KEY environment variable.
---

# LinkedIn Video Post

Post videos to LinkedIn profiles and company pages.

## Quick Start

```bash
export MATON_API_KEY="your-key"

# Post to personal profile only
python3 scripts/post_video.py \
  --video clip.mp4 \
  --text "Check this out!" \
  --title "My Video" \
  --person-id 2XpTlNwzaO

# Post to company page only
python3 scripts/post_video.py \
  --video clip.mp4 \
  --text "Company update" \
  --org-id 74357995

# Post to both
python3 scripts/post_video.py \
  --video clip.mp4 \
  --text "Personal version" \
  --person-id 2XpTlNwzaO \
  --org-id 74357995
```

## How It Works

1. **Register upload** via legacy v2 `assets?action=registerUpload` with `feedshare-video` recipe
2. **Upload binary** via PUT to the returned upload URL
3. **Create UGC post** referencing the uploaded asset

## Critical: Use Legacy v2 Upload

Do NOT use the REST `/videos?action=initializeUpload` endpoint. Those return chunked upload URLs pointing directly to `linkedin.com` which require LinkedIn OAuth tokens — the Maton proxy can't authenticate those requests (401 Unauthorized).

The legacy v2 `assets?action=registerUpload` returns a single upload URL that works with the Maton API key auth.

## Critical: Reshare via responseContext.parent

To reshare an org post from a personal profile, use `responseContext.parent` in the ugcPosts body — NOT `resharedShare` or `shareMediaCategory: "RESHARE"`. Those either silently fail (creating a text-only post without the embedded original) or return 422 errors.

Correct reshare body:

```json
{
  "author": "urn:li:person:ID",
  "lifecycleState": "PUBLISHED",
  "specificContent": {
    "com.linkedin.ugc.ShareContent": {
      "shareCommentary": { "text": "Your comment" },
      "shareMediaCategory": "NONE",
      "media": []
    }
  },
  "visibility": { "com.linkedin.ugc.MemberNetworkVisibility": "PUBLIC" },
  "responseContext": {
    "parent": "urn:li:ugcPost:ORIGINAL_POST_ID"
  }
}
```

## Known IDs

- **Nate's person ID**: `2XpTlNwzaO`
- **Deep MM org ID**: `74357995`
- **Maton connection ID**: `895a5d2d-5707-4796-bd48-94fa2678142a`

## Recommended Flow

1. **Post video as the company page** (org author) with company-voice copy
2. **Reshare from personal profile** with a personal comment — this drives more reach via personal feed algorithm while funneling followers to the company page

Use `--reshare` mode for step 2 (shares the org post rather than uploading a second copy).

## Copy Guidelines

- **Organization post**: Third person ("Our founder built...", "The team at Deep MM...")
- **Personal reshare**: First person, conversational ("I built...", "Excited to share...")

## Limits

- LinkedIn daily API limit: 150 requests/member
- Video file size: LinkedIn supports up to 200MB for feed videos
- Video duration: up to 10 minutes for feed, 60 seconds for Shorts
