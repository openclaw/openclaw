# SKILL: NANOBANANA-ELITE

> "Speed and precision. Nano-scale latency, macro-scale impact."

This skill provides Rykiri with high-speed AI image and video generation capabilities using the Nano Banana ecosystem.

## 1. CAPABILITIES
- **Nano Banana 1 (Fast)**: For high-volume, rapid image/video prototyping.
- **Nano Banana 2 (Consistent)**: For multi-scene videos with character/object consistency.
- **Nano Banana Pro (Studio)**: For native 4K, high-fidelity text rendering, and cinematic realism.

## 2. API ENDPOINTS & AUTH
- **Base URL**: `https://api.nanobananaapi.com/v1`
- **Auth**: `Authorization: Bearer <NANOBANANA_API_KEY>`
- **Endpoints**:
  - `POST /video/generate`: Text-to-Video.
  - `POST /video/image-to-video`: Image-guided video.
  - `POST /image/generate`: High-fidelity image generation.

## 3. INTEGRATION DIRECTIVE
When generating visual assets for projects:
1. **Consult [PROMPTING.md](file:///d:/Rykiri/.agents/PROMPTING.md)** for S-Tier prompt construction.
2. **Select Grade**: 
   - Use `Pro` for client-facing or landing page assets.
   - Use `Fast` for internal HUD assets or background textures.
3. **Execute**: Use `fetch_url_content` or a custom script to trigger the generation and poll the job status.

## 4. EXAMPLE PROMPT (Nano Banana Pro)
```json
{
  "model": "nano-banana-pro-image",
  "prompt": "Macro shot of a high-fidelity holographic interface, brushed aluminum edges, electric blue data streams, 35mm lens, f/1.8, 8K resolution, photorealistic.",
  "aspect_ratio": "16:9",
  "negative_prompt": "blurry, generic, low quality"
}
```
