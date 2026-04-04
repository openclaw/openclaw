# fal.ai Routing Reference

**App name:** `fal-ai`
**Base URL proxied:** `queue.fal.run`

## API Path Pattern

```
/fal-ai/fal-ai/{model-id}
/fal-ai/fal-ai/{model-id}/requests/{request_id}/status
/fal-ai/fal-ai/{model-id}/requests/{request_id}
/fal-ai/fal-ai/{model-id}/requests/{request_id}/cancel
```

## Queue API

### Submit Request

```bash
POST /fal-ai/fal-ai/{model-id}
Content-Type: application/json

{
  "prompt": "model-specific parameters"
}
```

**Response:**

```json
{
  "status": "IN_QUEUE",
  "request_id": "3229f185-a99a-48c0-a292-e25bf9baaeba",
  "response_url": "https://queue.fal.run/fal-ai/flux/requests/...",
  "status_url": "https://queue.fal.run/fal-ai/flux/requests/.../status",
  "cancel_url": "https://queue.fal.run/fal-ai/flux/requests/.../cancel",
  "queue_position": 0
}
```

### Check Status

```bash
GET /fal-ai/fal-ai/{model-id}/requests/{request_id}/status
```

### Get Result

```bash
GET /fal-ai/fal-ai/{model-id}/requests/{request_id}
```

### Cancel Request

```bash
PUT /fal-ai/fal-ai/{model-id}/requests/{request_id}/cancel
```

## Popular Models

| Model            | Path                      | Use Case              |
| ---------------- | ------------------------- | --------------------- |
| Flux Schnell     | `fal-ai/flux/schnell`     | Fast image generation |
| Flux Dev         | `fal-ai/flux/dev`         | High quality images   |
| Fast SDXL        | `fal-ai/fast-sdxl`        | Stable Diffusion XL   |
| Clarity Upscaler | `fal-ai/clarity-upscaler` | Image upscaling       |
| Minimax Video    | `fal-ai/minimax/video-01` | Video generation      |
| F5-TTS           | `fal-ai/f5-tts`           | Text-to-speech        |

## Image Generation Parameters

```json
{
  "prompt": "description of the image",
  "negative_prompt": "what to avoid",
  "image_size": "square_hd",
  "num_images": 1,
  "num_inference_steps": 4,
  "seed": 12345
}
```

**Image Sizes:** `square_hd`, `square`, `portrait_4_3`, `portrait_16_9`, `landscape_4_3`, `landscape_16_9`

## Request Status Values

| Status        | Description         |
| ------------- | ------------------- |
| `IN_QUEUE`    | Waiting for runner  |
| `IN_PROGRESS` | Model is processing |
| `COMPLETED`   | Result available    |
| `FAILED`      | Processing failed   |

## Request Headers

| Header                  | Description                    |
| ----------------------- | ------------------------------ |
| `X-Fal-Request-Timeout` | Server-side deadline (seconds) |
| `X-Fal-Queue-Priority`  | `normal` or `low`              |
| `X-Fal-No-Retry`        | Disable automatic retries      |

## Notes

- All model requests are queued - poll status until completion
- Model parameters vary by model type
- Image/video URLs from fal.ai CDN are temporary
- Use webhooks for long-running tasks: `?fal_webhook=URL`
- Uses API key authentication (not OAuth)

## Resources

- [fal.ai Documentation](https://fal.ai/docs)
- [Model Gallery](https://fal.ai/models)
- [Queue API Reference](https://fal.ai/docs/model-endpoints/queue)
