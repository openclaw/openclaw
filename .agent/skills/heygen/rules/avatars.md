---
name: avatars
description: Listing avatars, avatar styles, and avatar_id selection for HeyGen
metadata:
  tags: avatars, avatar-id, styles, listing, selection
---

# HeyGen Avatars

Avatars are the AI-generated presenters in HeyGen videos. You can use public avatars provided by HeyGen or create custom avatars.

## Previewing Avatars Before Generation

Always preview avatars before generating a video to ensure they match user preferences. Each avatar has preview URLs that can be opened directly in the browser - no downloading required.

### Quick Preview: Open URL in Browser (Recommended)

The fastest way to preview avatars is to open the URL directly in the default browser. **Do not download the image first** - just pass the URL to `open`:

```bash
# macOS: Open URL directly in default browser (no download)
open "https://files.heygen.ai/avatar/preview/josh.jpg"

# Open preview video to see animation
open "https://files.heygen.ai/avatar/preview/josh.mp4"

# Linux: Use xdg-open
xdg-open "https://files.heygen.ai/avatar/preview/josh.jpg"

# Windows: Use start
start "https://files.heygen.ai/avatar/preview/josh.jpg"
```

The `open` command on macOS opens URLs directly in the default browser - it does not download the file. This is the quickest way to let users see avatar previews.

### List Avatars and Open Previews

```typescript
async function listAndPreviewAvatars(openInBrowser = true): Promise<void> {
  const response = await fetch("https://api.heygen.com/v2/avatars", {
    headers: { "X-Api-Key": process.env.HEYGEN_API_KEY! },
  });
  const { data } = await response.json();

  for (const avatar of data.avatars.slice(0, 5)) {
    console.log(`\n${avatar.avatar_name} (${avatar.gender})`);
    console.log(`  ID: ${avatar.avatar_id}`);
    console.log(`  Preview: ${avatar.preview_image_url}`);
  }

  // Open preview URLs directly in browser (no download needed)
  if (openInBrowser) {
    const { execSync } = require("child_process");
    for (const avatar of data.avatars.slice(0, 3)) {
      // 'open' on macOS opens the URL in default browser - doesn't download
      execSync(`open "${avatar.preview_image_url}"`);
    }
  }
}
```

**Note:** The `open` command passes the URL to the browser - it does not download. The browser fetches and displays the image directly.

### Workflow: Preview Before Generate

1. **List available avatars** - get names, genders, and preview URLs
2. **Open previews in browser** - `open <preview_image_url>` for quick visual check
3. **User selects** preferred avatar by name or ID
4. **Get avatar details** for `default_voice_id`
5. **Generate video** with selected avatar

```bash
# Example workflow in terminal
# 1. List avatars (agent shows options)
# 2. Open preview for candidate
open "https://files.heygen.ai/avatar/preview/josh.jpg"
# 3. User says "use Josh"
# 4. Agent gets details and generates
```

### Preview Fields in API Response

| Field | Description |
|-------|-------------|
| `preview_image_url` | Static image of the avatar (JPG) - open in browser |
| `preview_video_url` | Short video clip showing avatar animation |

Both URLs are publicly accessible - no authentication needed to view.

## Listing Available Avatars

### curl

```bash
curl -X GET "https://api.heygen.com/v2/avatars" \
  -H "X-Api-Key: $HEYGEN_API_KEY"
```

### TypeScript

```typescript
interface Avatar {
  avatar_id: string;
  avatar_name: string;
  gender: "male" | "female";
  preview_image_url: string;
  preview_video_url: string;
}

interface AvatarsResponse {
  error: null | string;
  data: {
    avatars: Avatar[];
    talking_photos: TalkingPhoto[];
  };
}

async function listAvatars(): Promise<Avatar[]> {
  const response = await fetch("https://api.heygen.com/v2/avatars", {
    headers: { "X-Api-Key": process.env.HEYGEN_API_KEY! },
  });

  const json: AvatarsResponse = await response.json();

  if (json.error) {
    throw new Error(json.error);
  }

  return json.data.avatars;
}
```

### Python

```python
import requests
import os

def list_avatars() -> list:
    response = requests.get(
        "https://api.heygen.com/v2/avatars",
        headers={"X-Api-Key": os.environ["HEYGEN_API_KEY"]}
    )

    data = response.json()
    if data.get("error"):
        raise Exception(data["error"])

    return data["data"]["avatars"]
```

## Response Format

```json
{
  "error": null,
  "data": {
    "avatars": [
      {
        "avatar_id": "josh_lite3_20230714",
        "avatar_name": "Josh",
        "gender": "male",
        "preview_image_url": "https://files.heygen.ai/...",
        "preview_video_url": "https://files.heygen.ai/..."
      },
      {
        "avatar_id": "angela_expressive_20231010",
        "avatar_name": "Angela",
        "gender": "female",
        "preview_image_url": "https://files.heygen.ai/...",
        "preview_video_url": "https://files.heygen.ai/..."
      }
    ],
    "talking_photos": []
  }
}
```

## Avatar Types

### Public Avatars

HeyGen provides a library of public avatars that anyone can use:

```typescript
// List only public avatars
const avatars = await listAvatars();
const publicAvatars = avatars.filter((a) => !a.avatar_id.startsWith("custom_"));
```

### Private/Custom Avatars

Custom avatars created from your own training footage:

```typescript
const customAvatars = avatars.filter((a) => a.avatar_id.startsWith("custom_"));
```

### Instant Avatars

Quick avatars created from a single photo or short video:

```typescript
// List instant avatars
const response = await fetch("https://api.heygen.com/v1/instant_avatar.list", {
  headers: { "X-Api-Key": process.env.HEYGEN_API_KEY! },
});

const { data } = await response.json();
console.log(data.avatars);
```

## Avatar Styles

Avatars support different rendering styles:

| Style | Description |
|-------|-------------|
| `normal` | Full body shot, standard framing |
| `closeUp` | Close-up on face, more expressive |
| `circle` | Avatar in circular frame (talking head) |
| `voice_only` | Audio only, no video rendering |

### When to Use Each Style

| Use Case | Recommended Style |
|----------|-------------------|
| Full-screen presenter video | `normal` |
| Personal/intimate content | `closeUp` |
| Picture-in-picture overlay | `circle` |
| Small corner widget | `circle` |
| Podcast/audio content | `voice_only` |
| Motion graphics with avatar overlay | `normal` or `closeUp` + transparent bg |

### Using Avatar Styles

```typescript
const videoConfig = {
  video_inputs: [
    {
      character: {
        type: "avatar",
        avatar_id: "josh_lite3_20230714",
        avatar_style: "normal", // "normal" | "closeUp" | "circle" | "voice_only"
      },
      voice: {
        type: "text",
        input_text: "Hello, world!",
        voice_id: "1bd001e7e50f421d891986aad5158bc8",
      },
    },
  ],
};
```

### Circle Style for Talking Heads

Circle style is ideal for overlay compositions:

```typescript
// Circle avatar for picture-in-picture
{
  character: {
    type: "avatar",
    avatar_id: "josh_lite3_20230714",
    avatar_style: "circle",
  },
  voice: { ... },
  background: {
    type: "color",
    value: "#00FF00", // Green for chroma key, or use webm endpoint
  },
}
```

## Searching and Filtering Avatars

### By Gender

```typescript
function filterByGender(avatars: Avatar[], gender: "male" | "female"): Avatar[] {
  return avatars.filter((a) => a.gender === gender);
}

const maleAvatars = filterByGender(avatars, "male");
const femaleAvatars = filterByGender(avatars, "female");
```

### By Name

```typescript
function searchByName(avatars: Avatar[], query: string): Avatar[] {
  const lowerQuery = query.toLowerCase();
  return avatars.filter((a) =>
    a.avatar_name.toLowerCase().includes(lowerQuery)
  );
}

const results = searchByName(avatars, "josh");
```

## Avatar Groups

Avatars are organized into groups for better management. Use the v3 APIs for paginated listing with search capabilities.

### List Avatar Groups (v3 - Recommended)

The v3 API provides pagination and search capabilities:

```bash
curl -X GET "https://api.heygen.com/v3/avatar_group.list?page=1&page_size=20&include_public=true" \
  -H "X-Api-Key: $HEYGEN_API_KEY"
```

#### Query Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `page` | int | 1 | Page number (1-10000) |
| `page_size` | int | 20 | Items per page (1-1000) |
| `query` | string | null | Search query for filtering |
| `include_public` | bool | false | Include public avatars in results |

#### TypeScript

```typescript
interface AvatarGroupItem {
  id: string;
  name: string;
  created_at: number;
  num_looks: number;
  preview_image: string;
  group_type: string;
  train_status: string;
  default_voice_id: string | null;
}

interface AvatarGroupListResponse {
  error: null | string;
  data: {
    avatar_group_list: AvatarGroupItem[];
    total_count: number;
    current_page: number;
    page_size: number;
  };
}

async function listAvatarGroups(
  page = 1,
  pageSize = 20,
  includePublic = true,
  query?: string
): Promise<AvatarGroupListResponse["data"]> {
  const params = new URLSearchParams({
    page: page.toString(),
    page_size: pageSize.toString(),
    include_public: includePublic.toString(),
  });

  if (query) {
    params.set("query", query);
  }

  const response = await fetch(
    `https://api.heygen.com/v3/avatar_group.list?${params}`,
    { headers: { "X-Api-Key": process.env.HEYGEN_API_KEY! } }
  );

  const json: AvatarGroupListResponse = await response.json();

  if (json.error) {
    throw new Error(json.error);
  }

  return json.data;
}
```

### Search Public Avatars (v3)

Search and filter public avatars with pagination:

```bash
curl -X GET "https://api.heygen.com/v3/avatar_groups/search?page=1&page_size=20&query=professional" \
  -H "X-Api-Key: $HEYGEN_API_KEY"
```

#### Query Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `page` | int | 1 | Page number (1-1000) |
| `page_size` | int | 20 | Items per page (1-1000) |
| `search_tags` | string[] | null | Filter by tags (comma-separated) |
| `query` | string | null | Text search query |
| `list_filter` | string | null | Additional filter criteria |

#### TypeScript

```typescript
async function searchPublicAvatars(
  page = 1,
  pageSize = 20,
  query?: string,
  searchTags?: string[]
): Promise<AvatarGroupListResponse["data"]> {
  const params = new URLSearchParams({
    page: page.toString(),
    page_size: pageSize.toString(),
  });

  if (query) {
    params.set("query", query);
  }

  if (searchTags?.length) {
    params.set("search_tags", searchTags.join(","));
  }

  const response = await fetch(
    `https://api.heygen.com/v3/avatar_groups/search?${params}`,
    { headers: { "X-Api-Key": process.env.HEYGEN_API_KEY! } }
  );

  const json: AvatarGroupListResponse = await response.json();

  if (json.error) {
    throw new Error(json.error);
  }

  return json.data;
}

// Usage examples
const businessAvatars = await searchPublicAvatars(1, 20, "business");
const femaleAvatars = await searchPublicAvatars(1, 20, undefined, ["female"]);
```

### List Avatar Groups (v2 - Legacy)

```bash
curl -X GET "https://api.heygen.com/v2/avatar_group.list" \
  -H "X-Api-Key: $HEYGEN_API_KEY"
```

### Get Avatars in a Group

```bash
curl -X GET "https://api.heygen.com/v2/avatar_group/{group_id}/avatars" \
  -H "X-Api-Key: $HEYGEN_API_KEY"
```

## Using Avatars in Video Generation

### Basic Avatar Usage

```typescript
const videoConfig = {
  video_inputs: [
    {
      character: {
        type: "avatar",
        avatar_id: "josh_lite3_20230714",
        avatar_style: "normal",
      },
      voice: {
        type: "text",
        input_text: "Welcome to our product demo!",
        voice_id: "1bd001e7e50f421d891986aad5158bc8",
      },
    },
  ],
  dimension: { width: 1920, height: 1080 },
};
```

### Multiple Scenes with Different Avatars

```typescript
const multiSceneConfig = {
  video_inputs: [
    {
      character: {
        type: "avatar",
        avatar_id: "josh_lite3_20230714",
        avatar_style: "normal",
      },
      voice: {
        type: "text",
        input_text: "Hi, I'm Josh. Let me introduce my colleague.",
        voice_id: "1bd001e7e50f421d891986aad5158bc8",
      },
    },
    {
      character: {
        type: "avatar",
        avatar_id: "angela_expressive_20231010",
        avatar_style: "normal",
      },
      voice: {
        type: "text",
        input_text: "Hello! I'm Angela. Nice to meet you!",
        voice_id: "2d5b0e6a8c3f47d9a1b2c3d4e5f60718",
      },
    },
  ],
};
```

## Using Avatar's Default Voice

Many avatars have a `default_voice_id` that's pre-matched for natural results. **This is the recommended approach** rather than manually selecting voices.

### Recommended Flow

```
1. GET /v2/avatars           → Get list of avatar_ids
2. GET /v2/avatar/{id}/details → Get default_voice_id for chosen avatar
3. POST /v2/video/generate   → Use avatar_id + default_voice_id
```

### Get Avatar Details (v2 API)

Given an `avatar_id`, fetch its details including the default voice:

```bash
curl -X GET "https://api.heygen.com/v2/avatar/{avatar_id}/details" \
  -H "X-Api-Key: $HEYGEN_API_KEY"
```

#### Response Format

```json
{
  "error": null,
  "data": {
    "type": "avatar",
    "id": "josh_lite3_20230714",
    "name": "Josh",
    "gender": "male",
    "preview_image_url": "https://files.heygen.ai/...",
    "preview_video_url": "https://files.heygen.ai/...",
    "premium": false,
    "is_public": true,
    "default_voice_id": "1bd001e7e50f421d891986aad5158bc8",
    "tags": ["AVATAR_IV"]
  }
}
```

#### TypeScript

```typescript
interface AvatarDetails {
  type: "avatar";
  id: string;
  name: string;
  gender: "male" | "female";
  preview_image_url: string;
  preview_video_url: string;
  premium: boolean;
  is_public: boolean;
  default_voice_id: string | null;
  tags: string[];
}

async function getAvatarDetails(avatarId: string): Promise<AvatarDetails> {
  const response = await fetch(
    `https://api.heygen.com/v2/avatar/${avatarId}/details`,
    { headers: { "X-Api-Key": process.env.HEYGEN_API_KEY! } }
  );

  const json = await response.json();

  if (json.error) {
    throw new Error(json.error);
  }

  return json.data;
}

// Usage: Get default voice for a known avatar
const details = await getAvatarDetails("josh_lite3_20230714");
if (details.default_voice_id) {
  console.log(`Using ${details.name} with default voice: ${details.default_voice_id}`);
} else {
  console.log(`${details.name} has no default voice, select manually`);
}
```

#### Complete Example: Generate Video with Any Avatar's Default Voice

```typescript
async function generateWithAvatarDefaultVoice(
  avatarId: string,
  script: string
): Promise<string> {
  // 1. Get avatar details to find default voice
  const avatar = await getAvatarDetails(avatarId);

  if (!avatar.default_voice_id) {
    throw new Error(`Avatar ${avatar.name} has no default voice`);
  }

  // 2. Generate video with the avatar's default voice
  const videoId = await generateVideo({
    video_inputs: [{
      character: {
        type: "avatar",
        avatar_id: avatar.id,
        avatar_style: "normal",
      },
      voice: {
        type: "text",
        input_text: script,
        voice_id: avatar.default_voice_id,
      },
    }],
    dimension: { width: 1920, height: 1080 },
  });

  return videoId;
}
```

### Why Use Default Voice?

1. **Guaranteed gender match** - Avatar and voice are pre-paired
2. **Natural lip sync** - Default voices are optimized for the avatar
3. **Simpler code** - No need to fetch and match voices separately
4. **Better quality** - HeyGen has tested this combination

## Selecting the Right Avatar

### Avatar Categories

HeyGen avatars fall into distinct categories. Match the category to your use case:

| Category | Examples | Best For |
|----------|----------|----------|
| **Business/Professional** | Josh, Angela, Wayne | Corporate videos, product demos, training |
| **Casual/Friendly** | Lily, various lifestyle avatars | Social media, informal content |
| **Themed/Seasonal** | Holiday-themed, costume avatars | Specific campaigns, seasonal content |
| **Expressive** | Avatars with "expressive" in name | Engaging storytelling, dynamic content |

### Selection Guidelines

**For business/professional content:**
- Choose avatars with neutral attire (business casual or formal)
- Avoid themed or seasonal avatars (holiday costumes, casual clothing)
- Preview the avatar to verify professional appearance
- Consider your audience demographics when selecting gender and appearance

**For casual/social content:**
- More flexibility in avatar choice
- Themed avatars can work for specific campaigns
- Match avatar energy to content tone

### Common Mistakes to Avoid

1. **Using themed avatars for business content** - A holiday-themed avatar looks unprofessional in a product demo
2. **Not previewing before generation** - Always `open <preview_url>` to verify appearance
3. **Ignoring avatar style** - A `circle` style avatar may not work for full-screen presentations
4. **Mismatched voice gender** - Always use the avatar's `default_voice_id` or match genders manually

### Selection Checklist

Before generating a video:
- [ ] Previewed avatar image/video in browser
- [ ] Avatar appearance matches content tone (professional vs casual)
- [ ] Avatar style (`normal`, `closeUp`, `circle`) fits the video format
- [ ] Voice gender matches avatar gender
- [ ] Using `default_voice_id` when available

## Helper Functions

### Get Avatar by ID

```typescript
async function getAvatarById(avatarId: string): Promise<Avatar | null> {
  const avatars = await listAvatars();
  return avatars.find((a) => a.avatar_id === avatarId) || null;
}
```

### Validate Avatar ID

```typescript
async function isValidAvatarId(avatarId: string): Promise<boolean> {
  const avatar = await getAvatarById(avatarId);
  return avatar !== null;
}
```

### Get Random Avatar

```typescript
async function getRandomAvatar(gender?: "male" | "female"): Promise<Avatar> {
  let avatars = await listAvatars();

  if (gender) {
    avatars = avatars.filter((a) => a.gender === gender);
  }

  const randomIndex = Math.floor(Math.random() * avatars.length);
  return avatars[randomIndex];
}
```

## Common Avatar IDs

Some commonly used public avatar IDs (availability may vary):

| Avatar ID | Name | Gender |
|-----------|------|--------|
| `josh_lite3_20230714` | Josh | Male |
| `angela_expressive_20231010` | Angela | Female |
| `wayne_20240422` | Wayne | Male |
| `lily_20230614` | Lily | Female |

Always verify avatar availability by calling the list endpoint before using.
