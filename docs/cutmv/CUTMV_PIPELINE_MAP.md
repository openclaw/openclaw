# CUTMV Pipeline Map

> End-to-end video processing pipeline from upload to download.
> Package location: `packages/cutmv-app/`

---

## Pipeline Overview

```
[Browser]                    [Express Server]                 [Cloudflare R2]
    │                              │                               │
    ├─── Multipart Upload ────────>├─── Presigned URLs ───────────>│
    │    (direct-to-R2)            │                               │
    │                              ├─── Create Video Record ──>  [Neon PG]
    │                              │                               │
    ├─── Submit Processing ───────>├─── Credit Check               │
    │                              ├─── Create Background Job      │
    │                              ├─── Download from R2 ─────────>│
    │                              │    to /tmp/                    │
    │                              │                               │
    │    WebSocket ◄───────────────├─── FFmpeg Processing           │
    │    (progress)                │    (sequential operations)     │
    │                              │                               │
    │                              ├─── ZIP in-memory              │
    │                              ├─── Upload ZIP to R2 ─────────>│
    │                              │                               │
    │                              ├─── Generate Download Token    │
    │                              ├─── Send Email (Resend)        │
    │                              │                               │
    ├─── Download ZIP ◄───────────>├─── Signed URL ◄──────────────>│
    │    (24h expiry)              │                               │
```

---

## Stage 1: Video Upload

Source: `server/routes.ts`

### Multipart Upload (Primary — 50-70% faster)

1. **Initiate**: `POST /api/initiate-multipart-upload`
   - Rate limit: 2 concurrent uploads per user, 10 global max
   - Generate R2 key: `user-{hash}/uploads/{timestamp}-{randomId}-{sanitizedName}`
   - Create multipart upload in R2
   - Generate presigned URLs for each part (12-hour expiry)

2. **Upload parts**: Browser uploads chunks directly to R2 via presigned URLs
   - No server bandwidth consumed
   - Resumable on failure

3. **Complete**: `POST /api/complete-multipart-upload`
   - Finalize R2 multipart upload with ETags
   - Create video record in database
   - Extract metadata via ffprobe on R2 signed URL
   - Update record with duration, dimensions, aspect ratio

### Legacy Chunked Upload (Fallback)

1. `POST /api/initiate-upload` — allocate chunk buffer
2. `POST /api/upload-chunk` — store chunk in memory
3. `POST /api/finalize-upload` — assemble Buffer.concat, upload to R2

### R2 Key Pattern

```
user-{base64(email)[0:8]}/uploads/{timestamp}-{nanoid}-{sanitized-filename}
```

Example: `user-dWplbWFp/uploads/1765842074402-abcd1234-my-video.mp4`

---

## Stage 2: Processing Request

Source: `server/routes.ts` (`POST /api/create-payment-session`)

### Input

```typescript
{
  videoId: number,
  timestampText: "0:10-0:20\n0:30-0:45",
  aspectRatios: ["16:9", "9:16"],
  generateCutdowns: true,
  generateGif: true,
  generateThumbnails: true,
  generateCanvas: true,
  quality: "balanced",          // "high" | "balanced" | "compressed"
  videoFade: true,
  audioFade: true,
  fadeDuration: 0.5,
  discountCode?: "MORE20"
}
```

### Credit Check

1. Calculate cost via `creditService.calculateProcessingCost(options)`
2. Check user balance: `subscriptionCredits + credits >= cost`
3. If sufficient: deduct immediately (subscription credits first)
4. If insufficient: return 402 with shortfall amount

### Job Creation

Source: `server/background-job-manager.ts`

```
backgroundJobs record:
  sessionId: encrypted token
  videoId: reference to video
  status: "pending"
  progress: 0
  processingDetails: JSON(options)
```

Email notification: "processing_started" sent via Resend.

---

## Stage 3: Processing Orchestration

Source: `server/enhanced-process.ts`

### Routing Decision

1. **Try Cloudflare Queues** first (if `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` set)
   - Enqueue job via Cloudflare API
   - Worker processes independently
2. **Fall back to direct processing** if queue not configured or enqueue fails

### Direct Processing Setup

1. Download video from R2 to `/tmp/{videoId}/{filename}`
   - Uses `R2Storage.downloadFile()` (SDK-level, not signed URL)
   - Files over 5GB logged for monitoring
2. Create output directory: `/tmp/processing/{videoId}/`
3. Build operation list from processing options
4. Execute operations sequentially

### Operation Generation

From the user's options, create a list of operations:

| Export Type | Operation Count | Example |
|-------------|----------------|---------|
| Cutdowns | timestamps x aspectRatios | 5 stamps x 2 ratios = 10 ops |
| GIFs | 5 (short video) or 10 (long) | Fixed count based on duration |
| Thumbnails | 5 (short) or 10 (long) | Fixed count based on duration |
| Canvas | 2 (short) or 5 (long) | Fixed count based on duration |

Short video: < 40 seconds. Long video: >= 40 seconds.

---

## Stage 4: FFmpeg Execution

Source: `server/ffmpeg-progress.ts`

### 4a. Cutdown Processing

```bash
ffmpeg \
  -hwaccel auto \
  -ss {startTime} \
  -i {inputPath} \
  -t {duration} \
  -vf '{filterChain}' \
  -c:v libx264 \
  -crf {qualityMap[quality]} \
  -preset veryfast \
  -c:a aac -b:a 128k \
  -r 30 \
  -progress /tmp/ffmpeg-progress-{jobId}.log -nostats \
  {outputPath}
```

**Quality map**: high=18, balanced=20, compressed=23

**Video filter chain** (built dynamically):
1. **Letterbox detection**: `cropdetect` on 2-second sample from mid-clip
   - Requires 3+ frames agreement to apply crop
   - Validates minimum 640x360 output
2. **Aspect ratio transform**:
   - 16:9: `scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720`
   - 9:16: `scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920`
3. **Fade effects** (optional):
   - Video: `fade=t=in:st=0:d={dur},fade=t=out:st={end-dur}:d={dur}`
   - Audio: `afade=t=in:st=0:d={dur}:curve=exp,afade=t=out:st={end-dur}:d={dur}:curve=exp`

### 4b. GIF Generation

```bash
ffmpeg \
  -hwaccel auto \
  -ss {startTime} \
  -i {inputPath} \
  -t 6 \
  -vf 'fps=15,scale=480:-1' \
  -loop 0 \
  -progress /tmp/ffmpeg-progress-{jobId}.log -nostats \
  {outputPath}
```

Segment logic: divide video duration by GIF count, each GIF starts at `i * (duration / count)`.

### 4c. Thumbnail Generation

```bash
ffmpeg \
  -hwaccel auto \
  -ss {timestamp} \
  -i {inputPath} \
  -vframes 1 \
  -vf 'scale=1280:720:force_original_aspect_ratio=increase,pad=1280:720:(ow-iw)/2:(oh-ih)/2' \
  -q:v 2 \
  {outputPath}
```

Timestamp logic: `(index + 1) * (duration / (count + 1))` for even distribution.

### 4d. Canvas Loop (Spotify Canvas)

Two-pass process:

1. **Forward clip** (4 seconds, 9:16):
   ```bash
   ffmpeg -ss {start} -i {input} -t 4 \
     -vf 'scale=1080:1920:...,crop=1080:1920' \
     -c:v libx264 -crf 25 -preset veryfast \
     -pix_fmt yuv420p -r 23.976 -an \
     {tempForward}
   ```

2. **Reverse clip** (same clip, reversed):
   ```bash
   ffmpeg -i {tempForward} -vf 'reverse' {tempReverse}
   ```

3. **Concatenation** (forward + reverse = 8-second seamless loop):
   ```bash
   ffmpeg -f concat -i {concatList} -c copy {output}
   ```

---

## Stage 5: Progress Tracking

Source: `server/ffmpeg-progress.ts`, `server/accurate-progress.ts`

### FFmpeg Progress File

FFmpeg writes progress to `/tmp/ffmpeg-progress-{jobId}.log` every 200ms:

```
frame=1358
fps=30
out_time=00:00:45.267
bitrate=2500kbits/s
total_size=14000000
speed=1.2x
progress=continue
```

### Server-Side Polling

- Poll progress file every 200-500ms
- Parse fields: frame, fps, out_time, bitrate, speed
- Calculate percentage: `(currentTimeSeconds / totalDurationSeconds) * 100`
- Estimate remaining: `(total - current) / processingSpeed`

### WebSocket Broadcasting

```json
{
  "type": "ffmpeg_progress",
  "videoId": 123,
  "jobId": "123_cutdown_1234567890",
  "operation": "Cutdown clip-01",
  "progress": 45.3,
  "frame": 1358,
  "fps": 30,
  "time": "00:00:45.27",
  "speed": "1.2x",
  "estimatedTimeRemaining": 55,
  "timestamp": 1234567890123
}
```

### Client-Side Hook

Source: `client/src/hooks/useWebSocketProgress.ts`

- Connects to `ws://` or `wss://` at `/ws`
- Registers with `{ type: 'register', videoId }`
- Receives progress updates in real-time
- Exposes: `{ isConnected, progressData, connect, disconnect }`

---

## Stage 6: Output Packaging

Source: `server/enhanced-process.ts`

### ZIP Structure

```
{cleanName} - Exports.zip
├── {cleanName} - Clips (16x9)/
│   ├── {name}-clip-01.mp4
│   └── {name}-clip-02.mp4
├── {cleanName} - Clips (9x16)/
│   └── {name}-clip-01.mp4
├── {cleanName} - GIFs/
│   ├── {name}-gif-01.gif
│   └── {name}-gif-02.gif
├── {cleanName} - Thumbnails/
│   ├── {name}-thumbnail-01.jpg
│   └── {name}-thumbnail-02.jpg
└── {cleanName} - Canvas Loops/
    ├── {name}-canvas-01.mp4
    └── {name}-canvas-02.mp4
```

### Clean Name Generation

Priority order:
1. `{artistInfo} - {videoTitle}` (if both provided)
2. `{videoTitle}` (if only title)
3. Strip timestamp prefix from original filename: `1765842074402-bhojbkgd8r4-video.mp4` -> `video`

### ZIP Creation

- Created in-memory via `adm-zip` library
- No local disk staging — reads from `/tmp/` output files
- Uploaded directly to R2 from memory buffer

### R2 Export Key Pattern

```
user-{hash}/exports/{timestamp}-{randomId}-{cleanName}-Exports.zip
```

---

## Stage 7: Job Completion

Source: `server/background-job-manager.ts`

### State Transitions

```
pending ──> processing ──> completed
                      └──> failed
```

### On Completion

1. Update `backgroundJobs` record:
   - `status: "completed"`
   - `progress: 100`
   - `downloadPath: r2Key`
   - `r2DownloadUrl: signedUrl`
2. Analyze ZIP contents: count clips, GIFs, thumbnails, Canvas loops
3. Generate secure download token (24-hour expiry)
4. Send "download_ready" email via Resend with:
   - Download link
   - Export count summary
   - Expiration warning
5. Deduct credits from user wallet
6. Schedule R2 auto-deletion (~24.8 days, capped by setTimeout 32-bit limit)
7. Clean up `/tmp/` files

### On Failure

1. Update `backgroundJobs` record:
   - `status: "failed"`
   - `errorMessage: description`
2. Send "processing_failed" email with error details
3. Clean up `/tmp/` files
4. Credits NOT deducted on failure

---

## Stage 8: Download

Source: `server/download-tokens.ts`, `server/url-security.ts`

### Download Token

- 32 random bytes, hex-encoded
- Stored in-memory Map + database `download_tokens` table
- 24-hour expiry
- Endpoint: `GET /api/secure-download/:token`
- Validates token, streams file from R2

### URL Encryption (AES-256-CBC)

```typescript
// Encryption
iv = crypto.randomBytes(16)
key = crypto.scryptSync(SECRET_KEY, 'cutmv-salt', 32)
cipher = crypto.createCipheriv('aes-256-cbc', key, iv)
encrypted = Buffer.concat([iv, cipher.update(data), cipher.final()])
return encrypted.toString('base64url')
```

- Used for session tokens, video reuse tokens
- Secret from `URL_ENCRYPTION_SECRET` env var (SECURITY: has hardcoded fallback)

### Bulk Download

- `GET /api/bulk-download/:sessionId`
- Available only to Pro/Enterprise subscribers
- Downloads all exports as combined ZIP

---

## Timeout & Deadline System

Source: `server/timeout-config.ts`

### Deadline Calculation

```
totalMinutes = 10 + (videoDurationMinutes × 3.0)
totalMinutes × 1.5                          (50% safety buffer)
× 1.2  if bulk (8+ ops or 3+ export types)
× 1.1  if file > 5GB
× 1.15 if Canvas included
cap at 80 minutes
```

### Stall Detection

Source: `server/background-job-manager.ts`

- If no progress for 8 minutes: log warning
- If no progress for 85 minutes: kill job, mark failed
- Heartbeat interval: 3 minutes
- Grace period: 2 minutes for cleanup

---

## Temporary File Management

### Files Created

| Path | Contents | Lifecycle |
|------|----------|-----------|
| `/tmp/{videoId}/{filename}` | Downloaded source video | Cleaned on completion/failure |
| `/tmp/processing/{videoId}/` | All FFmpeg outputs | Cleaned on completion/failure |
| `/tmp/ffmpeg-progress-{jobId}.log` | FFmpeg progress data | Cleaned after operation |

### Cleanup Strategy

- **Success**: All `/tmp/` files deleted after ZIP upload to R2
- **Failure**: All `/tmp/` files deleted on failure handler
- **Stall**: Cleanup attempted when job killed by monitor
- **Tracking**: `job.localVideoPath` tracks downloaded video for cleanup

### Memory Constraints

- **Source video**: Downloaded from R2 to disk (not memory) for FFmpeg
- **ZIP**: Created in-memory via adm-zip (risk for very large exports)
- **Chunks (legacy)**: Assembled in-memory via Buffer.concat (up to 10GB — risk)
- **Progress file**: Polled from disk, not buffered in memory

---

## Cloudflare Queue Integration (Optional)

Source: `server/cloudflare-queue.ts`

### When Enabled

If `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` are set:
1. Job enqueued via Cloudflare API
2. Worker processes independently
3. Progress broadcast via WebSocket from Worker updates

### When Disabled

Falls back to direct processing on the Express server (default behavior).

---

## Key Environmental Dependencies

| Dependency | Purpose | Failure Mode |
|------------|---------|--------------|
| FFmpeg binary | Video processing | Fatal — no processing possible |
| Cloudflare R2 | Storage | Fatal — no upload/download |
| Neon PostgreSQL | Database | Fatal — no state tracking |
| Resend | Email | Non-fatal — processing continues, no notifications |
| Stripe | Payments | Non-fatal for processing — fatal for new purchases |
| OpenAI | AI metadata | Non-fatal — optional feature |

---

## Processing Time Estimates

Source: `shared/time-estimation.ts`

### Base Times Per Operation

| Operation | Base Time | File Size Multiplier Range | Duration Multiplier Range |
|-----------|-----------|---------------------------|--------------------------|
| Cutdown | 15 sec | 1.0x - 5.0x | 1.0x - 3.0x |
| GIF | 25 sec | 1.0x - 5.0x | 1.0x - 3.0x |
| Thumbnail | 8 sec | 1.0x - 5.0x | 1.0x - 3.0x |
| Canvas | 45 sec | 1.0x - 5.0x | 1.0x - 3.0x |

### Multiplier Breakpoints

**File size**: <1GB=1.0x, 1-2GB=1.5x, 2-5GB=2.2x, 5-8GB=3.5x, 8-10GB=5.0x
**Duration**: <=10min=1.0x, 10-30min=1.5x, 30-60min=2.0x, >60min=3.0x
**Bulk bonus**: cutdown=1.2x, gif=1.5x, thumbnail=1.1x, canvas=1.8x
**High quality**: 1.3x (balanced/compressed = 1.0x)
