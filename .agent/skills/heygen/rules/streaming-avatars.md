---
name: streaming-avatars
description: Real-time interactive avatar sessions for HeyGen
metadata:
  tags: streaming, real-time, interactive, websocket, live
---

# Streaming Avatars

HeyGen's Streaming Avatar feature enables real-time interactive avatar experiences, perfect for live customer service, virtual assistants, and interactive applications.

## Overview

Streaming avatars provide:
- **Real-time rendering** - Avatar responds immediately to input
- **Interactive dialogue** - Two-way conversation capability
- **WebRTC streaming** - Low-latency video delivery
- **Session management** - Create and manage live sessions

## Creating a Streaming Session

### Request Fields

| Field | Type | Req | Description |
|-------|------|:---:|-------------|
| `avatar_id` | string | ✓ | Avatar to use for streaming |
| `voice_id` | string | ✓ | Voice for TTS responses |
| `quality` | string | | `"low"`, `"medium"`, or `"high"` |
| `video_encoding` | string | | `"H264"` or `"VP8"` |

### curl

```bash
curl -X POST "https://api.heygen.com/v1/streaming.new" \
  -H "X-Api-Key: $HEYGEN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "avatar_id": "josh_lite3_20230714",
    "voice_id": "1bd001e7e50f421d891986aad5158bc8",
    "quality": "high"
  }'
```

### TypeScript

```typescript
interface StreamingSessionRequest {
  avatar_id: string;                           // Required
  voice_id: string;                            // Required
  quality?: "low" | "medium" | "high";
  video_encoding?: "H264" | "VP8";
}

interface StreamingSessionResponse {
  error: null | string;
  data: {
    session_id: string;
    access_token: string;
    url: string;
    ice_servers: IceServer[];
  };
}

interface IceServer {
  urls: string[];
  username?: string;
  credential?: string;
}

async function createStreamingSession(
  config: StreamingSessionRequest
): Promise<StreamingSessionResponse["data"]> {
  const response = await fetch("https://api.heygen.com/v1/streaming.new", {
    method: "POST",
    headers: {
      "X-Api-Key": process.env.HEYGEN_API_KEY!,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(config),
  });

  const json: StreamingSessionResponse = await response.json();

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

def create_streaming_session(config: dict) -> dict:
    response = requests.post(
        "https://api.heygen.com/v1/streaming.new",
        headers={
            "X-Api-Key": os.environ["HEYGEN_API_KEY"],
            "Content-Type": "application/json"
        },
        json=config
    )

    data = response.json()
    if data.get("error"):
        raise Exception(data["error"])

    return data["data"]
```

## Session Quality Options

| Quality | Resolution | Bandwidth | Use Case |
|---------|------------|-----------|----------|
| `low` | 480p | ~500kbps | Limited bandwidth |
| `medium` | 720p | ~1Mbps | Standard applications |
| `high` | 1080p | ~2Mbps | Premium experiences |

## Sending Text to Avatar

Make the avatar speak in real-time:

### Request Fields

| Field | Type | Req | Description |
|-------|------|:---:|-------------|
| `session_id` | string | ✓ | Active streaming session ID |
| `text` | string | ✓ | Text for avatar to speak |
| `task_type` | string | ✓ | `"talk"` or `"repeat"` |
| `task_mode` | string | | `"sync"` or `"async"` |

### curl

```bash
curl -X POST "https://api.heygen.com/v1/streaming.task" \
  -H "X-Api-Key: $HEYGEN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "session_id": "your_session_id",
    "text": "Hello! How can I help you today?",
    "task_type": "talk"
  }'
```

### TypeScript

```typescript
interface StreamingTaskRequest {
  session_id: string;                          // Required
  text: string;                                // Required
  task_type: "talk" | "repeat";                // Required
  task_mode?: "sync" | "async";
}

async function sendTextToAvatar(
  sessionId: string,
  text: string
): Promise<void> {
  const response = await fetch("https://api.heygen.com/v1/streaming.task", {
    method: "POST",
    headers: {
      "X-Api-Key": process.env.HEYGEN_API_KEY!,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      session_id: sessionId,
      text,
      task_type: "talk",
    }),
  });

  const json = await response.json();

  if (json.error) {
    throw new Error(json.error);
  }
}
```

## Stopping a Session

### curl

```bash
curl -X POST "https://api.heygen.com/v1/streaming.stop" \
  -H "X-Api-Key: $HEYGEN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "session_id": "your_session_id"
  }'
```

### TypeScript

```typescript
async function stopStreamingSession(sessionId: string): Promise<void> {
  const response = await fetch("https://api.heygen.com/v1/streaming.stop", {
    method: "POST",
    headers: {
      "X-Api-Key": process.env.HEYGEN_API_KEY!,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ session_id: sessionId }),
  });

  const json = await response.json();

  if (json.error) {
    throw new Error(json.error);
  }
}
```

## WebRTC Integration

Connect to the streaming avatar using WebRTC:

```typescript
class StreamingAvatarClient {
  private peerConnection: RTCPeerConnection | null = null;
  private sessionId: string | null = null;

  async connect(avatarId: string, voiceId: string): Promise<MediaStream> {
    // 1. Create session
    const session = await createStreamingSession({
      avatar_id: avatarId,
      voice_id: voiceId,
      quality: "high",
    });

    this.sessionId = session.session_id;

    // 2. Set up WebRTC peer connection
    this.peerConnection = new RTCPeerConnection({
      iceServers: session.ice_servers,
    });

    // 3. Handle incoming video stream
    const mediaStream = new MediaStream();

    this.peerConnection.ontrack = (event) => {
      event.streams[0].getTracks().forEach((track) => {
        mediaStream.addTrack(track);
      });
    };

    // 4. Create and set offer
    const offer = await this.peerConnection.createOffer();
    await this.peerConnection.setLocalDescription(offer);

    // 5. Exchange SDP with server (implementation depends on signaling method)
    // ...

    return mediaStream;
  }

  async speak(text: string): Promise<void> {
    if (!this.sessionId) {
      throw new Error("Not connected");
    }
    await sendTextToAvatar(this.sessionId, text);
  }

  async disconnect(): Promise<void> {
    if (this.sessionId) {
      await stopStreamingSession(this.sessionId);
      this.sessionId = null;
    }

    if (this.peerConnection) {
      this.peerConnection.close();
      this.peerConnection = null;
    }
  }
}
```

## React Integration Example

```tsx
import React, { useRef, useEffect, useState } from "react";

interface StreamingAvatarProps {
  avatarId: string;
  voiceId: string;
}

function StreamingAvatar({ avatarId, voiceId }: StreamingAvatarProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [client] = useState(() => new StreamingAvatarClient());
  const [connected, setConnected] = useState(false);
  const [inputText, setInputText] = useState("");

  useEffect(() => {
    async function connect() {
      try {
        const stream = await client.connect(avatarId, voiceId);
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
        }
        setConnected(true);
      } catch (error) {
        console.error("Failed to connect:", error);
      }
    }

    connect();

    return () => {
      client.disconnect();
    };
  }, [avatarId, voiceId]);

  const handleSend = async () => {
    if (inputText.trim()) {
      await client.speak(inputText);
      setInputText("");
    }
  };

  return (
    <div>
      <video
        ref={videoRef}
        autoPlay
        playsInline
        style={{ width: "100%", maxWidth: 640 }}
      />
      {connected && (
        <div>
          <input
            type="text"
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            placeholder="Type message..."
          />
          <button onClick={handleSend}>Send</button>
        </div>
      )}
    </div>
  );
}
```

## Session Management

### Listing Active Sessions

```typescript
async function listActiveSessions(): Promise<string[]> {
  const response = await fetch("https://api.heygen.com/v1/streaming.list", {
    headers: { "X-Api-Key": process.env.HEYGEN_API_KEY! },
  });

  const json = await response.json();
  return json.data.sessions;
}
```

### Session Timeout

Sessions automatically timeout after inactivity. Send periodic keep-alive messages:

```typescript
class StreamingAvatarClient {
  private keepAliveInterval: NodeJS.Timer | null = null;

  startKeepAlive() {
    this.keepAliveInterval = setInterval(async () => {
      if (this.sessionId) {
        await this.ping();
      }
    }, 30000); // Every 30 seconds
  }

  private async ping(): Promise<void> {
    // Implementation depends on API
  }

  stopKeepAlive() {
    if (this.keepAliveInterval) {
      clearInterval(this.keepAliveInterval);
      this.keepAliveInterval = null;
    }
  }
}
```

## Interrupting Speech

Interrupt current speech to start new content:

```typescript
async function interruptAndSpeak(
  sessionId: string,
  newText: string
): Promise<void> {
  // Interrupt current speech
  await fetch("https://api.heygen.com/v1/streaming.interrupt", {
    method: "POST",
    headers: {
      "X-Api-Key": process.env.HEYGEN_API_KEY!,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ session_id: sessionId }),
  });

  // Send new text
  await sendTextToAvatar(sessionId, newText);
}
```

## Use Cases

### Virtual Customer Service

```typescript
async function handleCustomerQuery(
  sessionId: string,
  query: string
): Promise<void> {
  // Process query with your AI/logic
  const response = await processCustomerQuery(query);

  // Have avatar speak the response
  await sendTextToAvatar(sessionId, response);
}
```

### Interactive Training

```typescript
async function conductTrainingSession(
  sessionId: string,
  trainingScript: string[]
): Promise<void> {
  for (const segment of trainingScript) {
    await sendTextToAvatar(sessionId, segment);

    // Wait for avatar to finish speaking
    await waitForSpeechComplete(sessionId);

    // Pause between segments
    await new Promise((r) => setTimeout(r, 1000));
  }
}
```

## Best Practices

1. **Handle disconnections** - Implement reconnection logic
2. **Manage bandwidth** - Adjust quality based on connection
3. **Limit session duration** - Close unused sessions to save credits
4. **Test latency** - Ensure acceptable response times
5. **Provide fallback** - Have backup for streaming failures
6. **Monitor usage** - Track session duration and costs

## Limitations

- Session duration limits vary by plan
- Concurrent session limits apply
- Credits consumed based on session time
- WebRTC requires modern browser support
- Network quality affects experience
