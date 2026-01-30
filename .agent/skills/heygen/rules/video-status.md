---
name: video-status
description: Polling patterns, status types, and retrieving download URLs for HeyGen videos
metadata:
  tags: video, status, polling, download, webhook
---

# Video Status and Polling

After generating a video, you need to poll for status until the video is complete. HeyGen processes videos asynchronously.

## Checking Video Status

### curl

```bash
curl -X GET "https://api.heygen.com/v1/video_status.get?video_id=YOUR_VIDEO_ID" \
  -H "X-Api-Key: $HEYGEN_API_KEY"
```

### TypeScript

```typescript
interface VideoStatusResponse {
  error: null | string;
  data: {
    video_id: string;
    status: "pending" | "processing" | "completed" | "failed";
    video_url?: string;
    thumbnail_url?: string;
    duration?: number;
    error?: string;
  };
}

async function getVideoStatus(videoId: string): Promise<VideoStatusResponse["data"]> {
  const response = await fetch(
    `https://api.heygen.com/v1/video_status.get?video_id=${videoId}`,
    { headers: { "X-Api-Key": process.env.HEYGEN_API_KEY! } }
  );

  const json: VideoStatusResponse = await response.json();

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

def get_video_status(video_id: str) -> dict:
    response = requests.get(
        f"https://api.heygen.com/v1/video_status.get",
        params={"video_id": video_id},
        headers={"X-Api-Key": os.environ["HEYGEN_API_KEY"]}
    )

    data = response.json()
    if data.get("error"):
        raise Exception(data["error"])

    return data["data"]
```

## Video Status Types

| Status | Description |
|--------|-------------|
| `pending` | Video is queued for processing |
| `processing` | Video is being generated |
| `completed` | Video is ready for download |
| `failed` | Video generation failed |

## Expected Generation Times

Video generation typically takes **5-15 minutes**, but can exceed 20 minutes during peak load or for longer scripts.

| Factor | Impact |
|--------|--------|
| Script length | Longer scripts = significantly longer processing |
| Resolution | 1080p takes longer than 720p |
| Avatar complexity | Some avatars render faster |
| Queue load | Peak hours may cause 15-20+ minute waits |
| Multiple scenes | Each scene adds processing time |

**Recommendations**:
- Set timeout to **15-20 minutes** (900,000-1,200,000 ms) for safety
- For scripts > 2 minutes of speech, expect 15+ minutes
- Consider async patterns (save video_id, check later) for long videos

## Response Format

### Completed Video

```json
{
  "error": null,
  "data": {
    "video_id": "abc123",
    "status": "completed",
    "video_url": "https://files.heygen.ai/video/abc123.mp4",
    "thumbnail_url": "https://files.heygen.ai/thumbnail/abc123.jpg",
    "duration": 45.2
  }
}
```

### Failed Video

```json
{
  "error": null,
  "data": {
    "video_id": "abc123",
    "status": "failed",
    "error": "Script too long for selected avatar"
  }
}
```

## Polling Implementation

### Basic Polling

```typescript
async function waitForVideo(
  videoId: string,
  maxWaitMs = 600000, // 10 minutes
  pollIntervalMs = 5000 // 5 seconds
): Promise<string> {
  const startTime = Date.now();

  while (Date.now() - startTime < maxWaitMs) {
    const status = await getVideoStatus(videoId);

    switch (status.status) {
      case "completed":
        return status.video_url!;
      case "failed":
        throw new Error(status.error || "Video generation failed");
      case "pending":
      case "processing":
        await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
        break;
    }
  }

  throw new Error("Video generation timed out");
}
```

### Polling with Progress Callback

```typescript
type ProgressCallback = (status: string, elapsed: number) => void;

async function waitForVideoWithProgress(
  videoId: string,
  onProgress?: ProgressCallback,
  maxWaitMs = 600000,
  pollIntervalMs = 5000
): Promise<string> {
  const startTime = Date.now();

  while (Date.now() - startTime < maxWaitMs) {
    const elapsed = Date.now() - startTime;
    const status = await getVideoStatus(videoId);

    onProgress?.(status.status, elapsed);

    switch (status.status) {
      case "completed":
        return status.video_url!;
      case "failed":
        throw new Error(status.error || "Video generation failed");
      default:
        await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
  }

  throw new Error("Video generation timed out");
}

// Usage
const videoUrl = await waitForVideoWithProgress(
  videoId,
  (status, elapsed) => {
    console.log(`Status: ${status}, Elapsed: ${Math.round(elapsed / 1000)}s`);
  }
);
```

### Python Polling

```python
import time
from typing import Optional, Callable

def wait_for_video(
    video_id: str,
    max_wait_seconds: int = 600,
    poll_interval: int = 5,
    on_progress: Optional[Callable[[str, int], None]] = None
) -> str:
    start_time = time.time()

    while time.time() - start_time < max_wait_seconds:
        elapsed = int(time.time() - start_time)
        status_data = get_video_status(video_id)
        status = status_data["status"]

        if on_progress:
            on_progress(status, elapsed)

        if status == "completed":
            return status_data["video_url"]
        elif status == "failed":
            raise Exception(status_data.get("error", "Video generation failed"))

        time.sleep(poll_interval)

    raise Exception("Video generation timed out")


# Usage
def progress_callback(status: str, elapsed: int):
    print(f"Status: {status}, Elapsed: {elapsed}s")

video_url = wait_for_video(video_id, on_progress=progress_callback)
```

## Downloading the Video

Once the video is complete, download it. **Important**: The video URL may not be immediately available after status shows "completed". Use retry logic with backoff.

### TypeScript (with retry)

```typescript
import fs from "fs";

async function downloadVideoWithRetry(
  videoUrl: string,
  outputPath: string,
  maxRetries = 5,
  initialDelayMs = 2000
): Promise<void> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const response = await fetch(videoUrl);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const arrayBuffer = await response.arrayBuffer();
      fs.writeFileSync(outputPath, Buffer.from(arrayBuffer));
      console.log(`Video downloaded to ${outputPath}`);
      return;
    } catch (error) {
      lastError = error as Error;
      const delay = initialDelayMs * Math.pow(2, attempt); // Exponential backoff
      console.log(`Download attempt ${attempt + 1} failed, retrying in ${delay}ms...`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw new Error(`Failed to download after ${maxRetries} attempts: ${lastError?.message}`);
}
```

### Python (with retry)

```python
import requests
import time

def download_video_with_retry(
    video_url: str,
    output_path: str,
    max_retries: int = 5,
    initial_delay: float = 2.0
) -> None:
    last_error = None

    for attempt in range(max_retries):
        try:
            response = requests.get(video_url, stream=True, timeout=60)
            response.raise_for_status()

            with open(output_path, "wb") as f:
                for chunk in response.iter_content(chunk_size=8192):
                    f.write(chunk)

            print(f"Video downloaded to {output_path}")
            return
        except Exception as e:
            last_error = e
            delay = initial_delay * (2 ** attempt)  # Exponential backoff
            print(f"Download attempt {attempt + 1} failed, retrying in {delay}s...")
            time.sleep(delay)

    raise Exception(f"Failed to download after {max_retries} attempts: {last_error}")
```

### Simple Download (no retry)

For quick scripts where you'll retry manually:

```typescript
async function downloadVideo(videoUrl: string, outputPath: string) {
  const response = await fetch(videoUrl);
  if (!response.ok) {
    throw new Error(`Failed to download: ${response.status}`);
  }
  const arrayBuffer = await response.arrayBuffer();
  fs.writeFileSync(outputPath, Buffer.from(arrayBuffer));
}
```

## Complete Workflow Example

```typescript
async function generateAndDownloadVideo(config: VideoConfig): Promise<string> {
  // 1. Generate video
  const generateResponse = await fetch(
    "https://api.heygen.com/v2/video/generate",
    {
      method: "POST",
      headers: {
        "X-Api-Key": process.env.HEYGEN_API_KEY!,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(config),
    }
  );

  const { data: generateData } = await generateResponse.json();
  const videoId = generateData.video_id;
  console.log(`Video ID: ${videoId}`);

  // 2. Poll for completion
  const videoUrl = await waitForVideoWithProgress(
    videoId,
    (status, elapsed) => {
      console.log(`[${Math.round(elapsed / 1000)}s] Status: ${status}`);
    }
  );

  // 3. Download
  const outputPath = `./output/${videoId}.mp4`;
  await downloadVideo(videoUrl, outputPath);

  return outputPath;
}
```

## Resumable Status Checking

For long-running generations, save the video_id and check status later rather than keeping a process waiting.

### Save State After Generation

```typescript
interface PendingVideo {
  videoId: string;
  createdAt: string;
  script: string;
  avatarId: string;
  voiceId: string;
}

async function startVideoGeneration(config: VideoGenerateRequest): Promise<PendingVideo> {
  const videoId = await generateVideo(config);

  const pending: PendingVideo = {
    videoId,
    createdAt: new Date().toISOString(),
    script: config.video_inputs[0].voice.input_text!,
    avatarId: config.video_inputs[0].character.avatar_id!,
    voiceId: config.video_inputs[0].voice.voice_id!,
  };

  // Save to file for later retrieval
  fs.writeFileSync("pending-video.json", JSON.stringify(pending, null, 2));
  console.log(`Video generation started. ID: ${videoId}`);
  console.log("Check status later with: checkVideoStatus()");

  return pending;
}
```

### Check Status Later

```typescript
async function checkVideoStatus(): Promise<void> {
  if (!fs.existsSync("pending-video.json")) {
    console.log("No pending video found");
    return;
  }

  const pending: PendingVideo = JSON.parse(
    fs.readFileSync("pending-video.json", "utf-8")
  );

  const elapsed = Date.now() - new Date(pending.createdAt).getTime();
  console.log(`Checking video ${pending.videoId} (started ${Math.round(elapsed / 60000)} min ago)...`);

  const status = await getVideoStatus(pending.videoId);

  switch (status.status) {
    case "completed":
      console.log(`Video ready: ${status.video_url}`);
      console.log(`Duration: ${status.duration}s`);
      // Clean up pending file
      fs.unlinkSync("pending-video.json");
      // Save result
      fs.writeFileSync("video-result.json", JSON.stringify({
        ...pending,
        videoUrl: status.video_url,
        thumbnailUrl: status.thumbnail_url,
        duration: status.duration,
        completedAt: new Date().toISOString(),
      }, null, 2));
      break;
    case "failed":
      console.error(`Video failed: ${status.error}`);
      fs.unlinkSync("pending-video.json");
      break;
    default:
      console.log(`Status: ${status.status} - check again in a few minutes`);
  }
}
```

### CLI-Friendly Pattern

```typescript
// generate-video.ts - Start generation and exit
async function main() {
  const pending = await startVideoGeneration(config);
  console.log(`\nVideo ID saved. Run 'npx tsx check-status.ts' to check progress.`);
  process.exit(0); // Exit immediately, don't wait
}

// check-status.ts - Check and optionally wait
async function main() {
  const args = process.argv.slice(2);
  const shouldWait = args.includes("--wait");

  if (shouldWait) {
    // Poll until complete (with 20 min timeout)
    const result = await waitForVideo(pending.videoId, apiKey, onProgress, 1200000);
    console.log(`Done: ${result.video_url}`);
  } else {
    // Just check once and report
    await checkVideoStatus();
  }
}
```

## Alternative: Using Webhooks

Instead of polling, you can use webhooks to receive notifications when videos complete. See [webhooks.md](webhooks.md) for details. Webhooks are ideal for production systems where you don't want to maintain polling connections.

## Best Practices

1. **Use exponential backoff** - Increase poll intervals for long-running jobs
2. **Set reasonable timeouts** - Most videos complete within 10 minutes
3. **Handle failures gracefully** - Check error messages for actionable feedback
4. **Consider webhooks** - For production systems, webhooks are more efficient than polling
5. **Cache video URLs** - Downloaded video URLs are valid for a limited time
