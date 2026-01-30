---
name: webhooks
description: Registering webhook endpoints and event types for HeyGen
metadata:
  tags: webhooks, callbacks, events, notifications
---

# Webhooks

Webhooks allow HeyGen to notify your application when events occur, such as video completion. This is more efficient than polling for status updates.

## Overview

Instead of repeatedly checking video status, webhooks push notifications to your server when:
- Video generation completes
- Video generation fails
- Translation completes
- Avatar training completes
- Other async operations finish

## Setting Up a Webhook Endpoint

Your webhook endpoint should:
1. Accept POST requests
2. Return 200 status quickly
3. Handle events asynchronously

### Express.js Example

```typescript
import express from "express";
import crypto from "crypto";

const app = express();
app.use(express.json());

// Webhook endpoint
app.post("/webhook/heygen", async (req, res) => {
  // Acknowledge receipt immediately
  res.status(200).send("OK");

  // Process event asynchronously
  processWebhookEvent(req.body).catch(console.error);
});

async function processWebhookEvent(event: HeyGenWebhookEvent) {
  console.log(`Received event: ${event.event_type}`);

  switch (event.event_type) {
    case "avatar_video.success":
      await handleVideoSuccess(event);
      break;
    case "avatar_video.fail":
      await handleVideoFailure(event);
      break;
    case "video_translate.success":
      await handleTranslationSuccess(event);
      break;
    default:
      console.log(`Unknown event type: ${event.event_type}`);
  }
}

app.listen(3000, () => {
  console.log("Webhook server running on port 3000");
});
```

### Python Flask Example

```python
from flask import Flask, request, jsonify
import threading

app = Flask(__name__)

@app.route("/webhook/heygen", methods=["POST"])
def heygen_webhook():
    event = request.json

    # Acknowledge immediately
    response = jsonify({"status": "received"})

    # Process asynchronously
    thread = threading.Thread(
        target=process_webhook_event,
        args=(event,)
    )
    thread.start()

    return response, 200

def process_webhook_event(event):
    event_type = event.get("event_type")
    print(f"Received event: {event_type}")

    if event_type == "avatar_video.success":
        handle_video_success(event)
    elif event_type == "avatar_video.fail":
        handle_video_failure(event)
    elif event_type == "video_translate.success":
        handle_translation_success(event)

if __name__ == "__main__":
    app.run(port=3000)
```

## Webhook Event Types

| Event Type | Description |
|------------|-------------|
| `avatar_video.success` | Video generation completed |
| `avatar_video.fail` | Video generation failed |
| `video_translate.success` | Translation completed |
| `video_translate.fail` | Translation failed |
| `instant_avatar.success` | Instant avatar created |
| `instant_avatar.fail` | Instant avatar creation failed |

## Event Payload Structure

### Video Success Event

```typescript
interface VideoSuccessEvent {
  event_type: "avatar_video.success";
  event_data: {
    video_id: string;
    video_url: string;
    thumbnail_url: string;
    duration: number;
    callback_id?: string;
  };
}
```

```json
{
  "event_type": "avatar_video.success",
  "event_data": {
    "video_id": "abc123",
    "video_url": "https://files.heygen.ai/video/abc123.mp4",
    "thumbnail_url": "https://files.heygen.ai/thumbnail/abc123.jpg",
    "duration": 45.2,
    "callback_id": "your_custom_id"
  }
}
```

### Video Failure Event

```typescript
interface VideoFailureEvent {
  event_type: "avatar_video.fail";
  event_data: {
    video_id: string;
    error: string;
    callback_id?: string;
  };
}
```

```json
{
  "event_type": "avatar_video.fail",
  "event_data": {
    "video_id": "abc123",
    "error": "Script too long for selected avatar",
    "callback_id": "your_custom_id"
  }
}
```

## Registering a Webhook URL

Configure your webhook URL through the HeyGen dashboard or API:

### Request Fields

| Field | Type | Req | Description |
|-------|------|:---:|-------------|
| `url` | string | ✓ | Your webhook endpoint URL |
| `events` | array | ✓ | Event types to subscribe to |
| `secret` | string | | Shared secret for signature verification |

### Via API

```bash
curl -X POST "https://api.heygen.com/v1/webhook.add" \
  -H "X-Api-Key: $HEYGEN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://your-domain.com/webhook/heygen",
    "events": ["avatar_video.success", "avatar_video.fail"]
  }'
```

### TypeScript

```typescript
interface WebhookConfig {
  url: string;                                 // Required
  events: string[];                            // Required
  secret?: string;
}

async function registerWebhook(config: WebhookConfig): Promise<void> {
  const response = await fetch("https://api.heygen.com/v1/webhook.add", {
    method: "POST",
    headers: {
      "X-Api-Key": process.env.HEYGEN_API_KEY!,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(config),
  });

  const json = await response.json();

  if (json.error) {
    throw new Error(json.error);
  }
}
```

## Using Callback IDs

Track which video triggered a webhook with callback IDs:

### Include Callback ID in Video Generation

```typescript
const videoConfig = {
  video_inputs: [...],
  callback_id: "order_12345", // Your custom identifier
};
```

### Handle in Webhook

```typescript
async function handleVideoSuccess(event: VideoSuccessEvent) {
  const { video_id, video_url, callback_id } = event.event_data;

  if (callback_id) {
    // Look up your original request
    const order = await getOrderByCallbackId(callback_id);
    await updateOrderWithVideo(order.id, video_url);
  }
}
```

## Webhook Security

### Verify Webhook Signatures

If HeyGen provides signature verification:

```typescript
import crypto from "crypto";

function verifyWebhookSignature(
  payload: string,
  signature: string,
  secret: string
): boolean {
  const expectedSignature = crypto
    .createHmac("sha256", secret)
    .update(payload)
    .digest("hex");

  return crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(expectedSignature)
  );
}

// In your webhook handler
app.post("/webhook/heygen", (req, res) => {
  const signature = req.headers["x-heygen-signature"] as string;
  const payload = JSON.stringify(req.body);

  if (!verifyWebhookSignature(payload, signature, WEBHOOK_SECRET)) {
    return res.status(401).send("Invalid signature");
  }

  // Process event...
});
```

### Validate Event Origin

```typescript
function isValidHeygenEvent(event: any): boolean {
  // Check required fields
  if (!event.event_type || !event.event_data) {
    return false;
  }

  // Check event type is known
  const validEventTypes = [
    "avatar_video.success",
    "avatar_video.fail",
    "video_translate.success",
    "video_translate.fail",
  ];

  return validEventTypes.includes(event.event_type);
}
```

## Handling Webhook Failures

Implement retry logic and error handling:

```typescript
async function processWebhookEvent(event: HeyGenWebhookEvent) {
  const maxRetries = 3;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await handleEvent(event);
      return;
    } catch (error) {
      console.error(`Attempt ${attempt} failed:`, error);

      if (attempt < maxRetries) {
        // Exponential backoff
        await new Promise((r) => setTimeout(r, Math.pow(2, attempt) * 1000));
      }
    }
  }

  // Store failed event for manual review
  await storeFailedEvent(event);
}
```

## Webhook vs Polling Comparison

| Aspect | Webhook | Polling |
|--------|---------|---------|
| Latency | Immediate | Depends on interval |
| Efficiency | High (push) | Low (repeated requests) |
| Complexity | Requires endpoint | Simpler to implement |
| Reliability | Needs retry handling | Guaranteed delivery |
| Cost | Lower API usage | Higher API usage |

## Testing Webhooks

### Local Development with ngrok

```bash
# Start ngrok tunnel
ngrok http 3000

# Use ngrok URL as webhook endpoint
# https://abc123.ngrok.io/webhook/heygen
```

### Webhook Testing Tool

```typescript
// Test webhook locally
async function simulateWebhook(event: HeyGenWebhookEvent) {
  const response = await fetch("http://localhost:3000/webhook/heygen", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(event),
  });

  console.log(`Response: ${response.status}`);
}

// Simulate success event
await simulateWebhook({
  event_type: "avatar_video.success",
  event_data: {
    video_id: "test_123",
    video_url: "https://example.com/test.mp4",
    thumbnail_url: "https://example.com/test.jpg",
    duration: 30,
    callback_id: "test_callback",
  },
});
```

## Best Practices

1. **Respond quickly** - Return 200 within 5 seconds, process async
2. **Handle duplicates** - Same event may be sent multiple times
3. **Implement retries** - Handle temporary processing failures
4. **Log everything** - Store webhook payloads for debugging
5. **Use callback IDs** - Track requests through the system
6. **Secure endpoints** - Verify signatures, use HTTPS
7. **Monitor health** - Track webhook success rates
8. **Queue processing** - Use job queues for heavy processing
