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

---

## Read your own posts

First get your person ID from `/me`, then list your posts:

```bash
# Step 1: Get your person ID
PERSON_INFO=$(bash scripts/call.sh /me GET)
PERSON_ID=$(echo "$PERSON_INFO" | python3 -c "import json,sys; d=json.loads(sys.stdin.read()); print(d['data']['id'])")

# Step 2: List your posts
ENCODED_URN=$(python3 -c "import urllib.parse; print(urllib.parse.quote('urn:li:person:' + '$PERSON_ID', safe=''))")
bash scripts/call.sh "/ugcPosts?q=authors&authors=List($ENCODED_URN)&sortBy=LAST_MODIFIED" GET
```

This returns your recent posts with their URNs (e.g. `urn:li:ugcPost:1234567890`).

---

## Read comments on your post

```bash
# POST_URN format: urn:li:ugcPost:1234567890
ENCODED_URN=$(python3 -c "import urllib.parse; print(urllib.parse.quote('$POST_URN', safe=''))")
bash scripts/call.sh "rest/socialActions/$ENCODED_URN/comments" GET
```

Returns list of comments with `commentUrn`, `actor`, `message.text`, and `likesSummary`.

---

## Comment on a post (yours or anyone's)

```bash
# Get your person ID first
PERSON_INFO=$(bash scripts/call.sh /me GET)
PERSON_ID=$(echo "$PERSON_INFO" | python3 -c "import json,sys; d=json.loads(sys.stdin.read()); print(d['data']['id'])")

# POST_URN: urn:li:ugcPost:1234567890
ENCODED_URN=$(python3 -c "import urllib.parse; print(urllib.parse.quote('$POST_URN', safe=''))")
bash scripts/call.sh "rest/socialActions/$ENCODED_URN/comments" POST '{
  "actor": "urn:li:person:PERSON_ID",
  "object": "POST_URN",
  "message": {"text": "Great post! Really insightful."}
}'
```

Or use the convenience script:
```bash
bash scripts/comment.sh "urn:li:ugcPost:1234567890" "Great post! Really insightful."
```

---

## Reply to a comment (nested comment)

```bash
bash scripts/call.sh "rest/socialActions/$ENCODED_URN/comments" POST '{
  "actor": "urn:li:person:PERSON_ID",
  "object": "POST_URN",
  "message": {"text": "Thanks for your response!"},
  "parentComment": "COMMENT_URN"
}'
```

---

## Like a post

```bash
PERSON_INFO=$(bash scripts/call.sh /me GET)
PERSON_ID=$(echo "$PERSON_INFO" | python3 -c "import json,sys; d=json.loads(sys.stdin.read()); print(d['data']['id'])")
ENCODED_URN=$(python3 -c "import urllib.parse; print(urllib.parse.quote('$POST_URN', safe=''))")
bash scripts/call.sh "rest/socialActions/$ENCODED_URN/likes" POST '{
  "actor": "urn:li:person:PERSON_ID",
  "object": "POST_URN"
}'
```

Or use the convenience script:
```bash
bash scripts/like.sh "urn:li:ugcPost:1234567890"
```

---

## Delete a post (your own only)

```bash
bash scripts/call.sh "/ugcPosts/urn%3Ali%3AugcPost%3A1234567890" DELETE
```

---

## Key notes on URNs
- Post URN: `urn:li:ugcPost:1234567890` — from creating a post or listing own posts
- Activity URN: `urn:li:activity:1234567890` — alternative form LinkedIn sometimes returns
- Comment URN: `urn:li:comment:(urn:li:activity:123456789,9876543210)` — from reading comments
- URNs must be URL-encoded when used in path segments: `urn:li:ugcPost:123` → `urn%3Ali%3AugcPost%3A123`
- For `rest/socialActions` paths: the URI path uses URL-encoded URN
- Reading comments only works on posts you authored (LinkedIn API restriction)
