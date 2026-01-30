---
name: assets
description: Uploading images, videos, and audio for use in HeyGen video generation
metadata:
  tags: assets, upload, images, audio, video, s3
---

# Asset Upload and Management

HeyGen allows you to upload custom assets (images, videos, audio) for use in video generation, such as backgrounds, talking photo sources, and custom audio.

## Upload Flow

Asset uploads use a two-step process:
1. Get a presigned upload URL from HeyGen
2. Upload the file to the presigned URL

## Getting an Upload URL

### Request Fields

| Field | Type | Req | Description |
|-------|------|:---:|-------------|
| `content_type` | string | ✓ | MIME type of file to upload |

### curl

```bash
curl -X POST "https://api.heygen.com/v1/asset" \
  -H "X-Api-Key: $HEYGEN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"content_type": "image/jpeg"}'
```

### TypeScript

```typescript
interface AssetUploadRequest {
  content_type: string;                        // Required
}

interface AssetUploadResponse {
  error: null | string;
  data: {
    url: string;
    asset_id: string;
  };
}

async function getUploadUrl(contentType: string): Promise<AssetUploadResponse["data"]> {
  const response = await fetch("https://api.heygen.com/v1/asset", {
    method: "POST",
    headers: {
      "X-Api-Key": process.env.HEYGEN_API_KEY!,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ content_type: contentType }),
  });

  const json: AssetUploadResponse = await response.json();

  if (json.error) {
    throw new Error(json.error);
  }

  return json.data;
}
```

### Python

```python
import requests
import os

def get_upload_url(content_type: str) -> dict:
    response = requests.post(
        "https://api.heygen.com/v1/asset",
        headers={
            "X-Api-Key": os.environ["HEYGEN_API_KEY"],
            "Content-Type": "application/json"
        },
        json={"content_type": content_type}
    )

    data = response.json()
    if data.get("error"):
        raise Exception(data["error"])

    return data["data"]
```

## Supported Content Types

| Type | Content-Type | Use Case |
|------|--------------|----------|
| JPEG | `image/jpeg` | Backgrounds, talking photos |
| PNG | `image/png` | Backgrounds, overlays |
| MP4 | `video/mp4` | Video backgrounds |
| MP3 | `audio/mpeg` | Custom audio input |
| WAV | `audio/wav` | Custom audio input |

## Uploading Files

### TypeScript

```typescript
import fs from "fs";

async function uploadFile(filePath: string, contentType: string): Promise<string> {
  // 1. Get upload URL
  const { url, asset_id } = await getUploadUrl(contentType);

  // 2. Read file
  const fileBuffer = fs.readFileSync(filePath);

  // 3. Upload to presigned URL
  const uploadResponse = await fetch(url, {
    method: "PUT",
    headers: {
      "Content-Type": contentType,
    },
    body: fileBuffer,
  });

  if (!uploadResponse.ok) {
    throw new Error(`Upload failed: ${uploadResponse.status}`);
  }

  return asset_id;
}

// Usage
const imageAssetId = await uploadFile("./background.jpg", "image/jpeg");
console.log(`Uploaded image asset: ${imageAssetId}`);
```

### TypeScript (with streams for large files)

```typescript
import fs from "fs";
import { stat } from "fs/promises";

async function uploadLargeFile(filePath: string, contentType: string): Promise<string> {
  const { url, asset_id } = await getUploadUrl(contentType);

  const fileStats = await stat(filePath);
  const fileStream = fs.createReadStream(filePath);

  const uploadResponse = await fetch(url, {
    method: "PUT",
    headers: {
      "Content-Type": contentType,
      "Content-Length": fileStats.size.toString(),
    },
    body: fileStream as any,
    // @ts-ignore - duplex is needed for streaming
    duplex: "half",
  });

  if (!uploadResponse.ok) {
    throw new Error(`Upload failed: ${uploadResponse.status}`);
  }

  return asset_id;
}
```

### Python

```python
import requests

def upload_file(file_path: str, content_type: str) -> str:
    # 1. Get upload URL
    upload_data = get_upload_url(content_type)
    url = upload_data["url"]
    asset_id = upload_data["asset_id"]

    # 2. Upload file
    with open(file_path, "rb") as f:
        response = requests.put(
            url,
            headers={"Content-Type": content_type},
            data=f
        )

    if not response.ok:
        raise Exception(f"Upload failed: {response.status_code}")

    return asset_id


# Usage
image_asset_id = upload_file("./background.jpg", "image/jpeg")
print(f"Uploaded image asset: {image_asset_id}")
```

## Uploading from URL

If your asset is already hosted online:

```typescript
async function uploadFromUrl(sourceUrl: string, contentType: string): Promise<string> {
  // 1. Download the file
  const sourceResponse = await fetch(sourceUrl);
  const buffer = await sourceResponse.arrayBuffer();

  // 2. Get HeyGen upload URL
  const { url, asset_id } = await getUploadUrl(contentType);

  // 3. Upload to HeyGen
  await fetch(url, {
    method: "PUT",
    headers: { "Content-Type": contentType },
    body: buffer,
  });

  return asset_id;
}
```

## Using Uploaded Assets

### As Background Image

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
        input_text: "Hello, this is a video with a custom background!",
        voice_id: "1bd001e7e50f421d891986aad5158bc8",
      },
      background: {
        type: "image",
        url: `https://files.heygen.ai/asset/${imageAssetId}`,
      },
    },
  ],
};
```

### As Talking Photo Source

```typescript
const talkingPhotoConfig = {
  video_inputs: [
    {
      character: {
        type: "talking_photo",
        talking_photo_id: photoAssetId,
      },
      voice: {
        type: "text",
        input_text: "Hello from my talking photo!",
        voice_id: "1bd001e7e50f421d891986aad5158bc8",
      },
    },
  ],
};
```

### As Audio Input

```typescript
const audioConfig = {
  video_inputs: [
    {
      character: {
        type: "avatar",
        avatar_id: "josh_lite3_20230714",
        avatar_style: "normal",
      },
      voice: {
        type: "audio",
        audio_url: `https://files.heygen.ai/asset/${audioAssetId}`,
      },
    },
  ],
};
```

## Complete Upload Workflow

```typescript
async function createVideoWithCustomBackground(
  backgroundPath: string,
  script: string
): Promise<string> {
  // 1. Upload background
  console.log("Uploading background...");
  const backgroundId = await uploadFile(backgroundPath, "image/jpeg");

  // 2. Create video config
  const config = {
    video_inputs: [
      {
        character: {
          type: "avatar",
          avatar_id: "josh_lite3_20230714",
          avatar_style: "normal",
        },
        voice: {
          type: "text",
          input_text: script,
          voice_id: "1bd001e7e50f421d891986aad5158bc8",
        },
        background: {
          type: "image",
          url: `https://files.heygen.ai/asset/${backgroundId}`,
        },
      },
    ],
    dimension: { width: 1920, height: 1080 },
  };

  // 3. Generate video
  console.log("Generating video...");
  const response = await fetch("https://api.heygen.com/v2/video/generate", {
    method: "POST",
    headers: {
      "X-Api-Key": process.env.HEYGEN_API_KEY!,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(config),
  });

  const { data } = await response.json();
  return data.video_id;
}
```

## Asset Limitations

- **File size**: Varies by asset type (typically 10-100MB max)
- **Image dimensions**: Recommended to match video dimensions
- **Audio duration**: Should match expected video length
- **Retention**: Assets may be deleted after a period of inactivity

## Best Practices

1. **Optimize images** - Resize to match video dimensions before uploading
2. **Use appropriate formats** - JPEG for photos, PNG for graphics with transparency
3. **Validate before upload** - Check file type and size locally first
4. **Handle upload errors** - Implement retry logic for failed uploads
5. **Cache asset IDs** - Reuse assets across multiple video generations
