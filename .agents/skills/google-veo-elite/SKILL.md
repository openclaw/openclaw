# SKILL: GOOGLE-VEO-ELITE

> "Cinematic Reality. Native Audio. Studio Quality."

This skill provides Rykiri with Google's state-of-the-art video generation capabilities via the Gemini API.

## 1. CAPABILITIES
- **Veo 3.1 (High-Fidelity)**: Generates 8s videos in 720p, 1080p, or 4K.
- **Native Audio**: Native audio generation synchronized with video.
- **Cinematic Styles**: Supports portrait video, video extension, and frame-specific generation.
- **Image-Based Direction**: Can use up to 3 reference images to guide the generation.

## 2. API INTEGRATION (Gemini API)
- **Model Name**: `veo-3.1-generate-preview`
- **Auth**: `Authorization: Bearer <GEMINI_API_KEY>`
- **Parameters**:
  - `prompt`: String.
  - `aspect_ratio`: `16:9`, `9:16`, `1:1`.
  - `resolution`: `720p`, `1080p`, `4k`.
  - `fps`: `24`, `30`, `60`.
  - `duration_seconds`: `5` to `10`.

## 3. INTEGRATION DIRECTIVE
When generating cinematic assets for projects:
1. **Consult [PROMPTING.md](file:///d:/Rykiri/.agents/PROMPTING.md)** for S-Tier prompt construction.
2. **Execute**: Submit the generation job and poll the operation status until completion.
3. **Download**: Store the final video and native audio in the `assets/media/` directory.

## 4. EXAMPLE PROMPT (Google Veo)
```json
{
  "model": "veo-3.1-generate-preview",
  "prompt": "Cinematic wide shot of a brutalist crystalline skyscraper with glowing violet Solana runes, hovering in a storm of digital particles, 8K, photorealistic.",
  "aspect_ratio": "16:9",
  "resolution": "4k",
  "native_audio": true
}
```
