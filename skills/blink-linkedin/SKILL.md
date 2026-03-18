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
bash scripts/call.sh /me GET
```

## Get profile with specific fields
```bash
bash scripts/call.sh /me GET \
  '{"fields": "id,localizedFirstName,localizedLastName,profilePicture"}'
```

## Get user info (OpenID Connect)
```bash
bash scripts/call.sh /userinfo GET
```

## Create a text post (share)
```bash
bash scripts/call.sh /ugcPosts POST '{
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

## Post with an image
```bash
# Step 1: Upload image, get asset URN
UPLOAD=$(bash scripts/upload-image.sh "https://example.com/photo.jpg")
ASSET_URN=$(echo "$UPLOAD" | python3 -c "import json,sys; print(json.loads(sys.stdin.read())['data']['asset_urn'])")

# Step 2: Get your person ID
bash scripts/call.sh /userinfo GET

# Step 3: Create post with image
bash scripts/call.sh /ugcPosts POST '{
  "author": "urn:li:person:PERSON_ID",
  "lifecycleState": "PUBLISHED",
  "specificContent": {
    "com.linkedin.ugc.ShareContent": {
      "shareCommentary": {"text": "Check out this image!"},
      "shareMediaCategory": "IMAGE",
      "media": [{"status": "READY", "media": "ASSET_URN"}]
    }
  },
  "visibility": {"com.linkedin.ugc.MemberNetworkVisibility": "PUBLIC"}
}'
```

Or use the convenience script (one command):
```bash
bash scripts/post-with-image.sh "Check out this image!" "https://example.com/photo.jpg"
```

## Post a LOCAL photo to LinkedIn (user uploaded via Telegram/Discord/Slack)
```bash
# Step 1: Upload local file to get a URL (requires blink-image skill)
UPLOAD=$(bash /path/to/blink-image/scripts/upload-file.sh "/data/agents/default/agent/photo.jpg")
URL=$(echo "$UPLOAD" | python3 -c "import json,sys; print(json.loads(sys.stdin.read())['url'])")

# Optional Step 2: Edit the photo (e.g. make it a professional headshot)
EDITED=$(bash /path/to/blink-image/scripts/edit.sh "Professional studio headshot, dark background, clean look" "$URL")
FINAL_URL=$(echo "$EDITED" | python3 -c "import json,sys; d=json.loads(sys.stdin.read()); print(d['result']['data'][0]['url'])")

# Step 3: Post to LinkedIn
bash scripts/post-with-image.sh "Excited to share my new professional photo!" "$FINAL_URL"
```

## Generate an image with blink-image and post to LinkedIn
```bash
# Generate image
IMG=$(bash /path/to/blink-image/scripts/generate.sh "A futuristic cityscape at night")
URL=$(echo "$IMG" | python3 -c "import json,sys; d=json.loads(sys.stdin.read()); print(d['result']['data'][0]['url'])")

# Post it
bash scripts/post-with-image.sh "Excited to share this AI-generated artwork!" "$URL"
```

## Post with a video
```bash
# Step 1: Upload video
UPLOAD=$(bash scripts/upload-video.sh "https://example.com/demo.mp4")
VIDEO_URN=$(echo "$UPLOAD" | python3 -c "import json,sys; print(json.loads(sys.stdin.read())['data']['asset_urn'])")

# Use convenience script
bash scripts/post-with-video.sh "Watch our latest demo!" "https://example.com/demo.mp4"
```

## Media upload notes
- Image formats supported: JPEG, PNG, GIF (max 5MB for optimal results)
- Video formats supported: MP4 (max 200MB, H.264 encoded)
- `w_member_social` scope (already included) covers both image and video posts
- Videos may take a few seconds to process on LinkedIn before the post appears
