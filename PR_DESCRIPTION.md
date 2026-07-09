# xAI / Grok video generation uses consumer endpoint (grok.com), not developer API

## Problem
`video_generate` with any `grok-imagine-video*` model fails with 404 or "prompt required".

The current `xai` video provider (`video-generation-provider-CSHDnzIw.js`) only implements the developer API path:
- `POST https://api.x.ai/v1/videos/generations`
- Model: `grok-imagine-video`

This endpoint returns 404 even with valid `xai-` keys that have video permissions.

## Root Cause (from console.xai.com + grok.com inspection)
The working video generation flow (as of 2026-07-09) lives on the **consumer Grok website**, not the developer API:

- `POST https://grok.com/rest/media/post/create`
  - `modelName: "imagine-video-gen"`
  - `mediaType: "MEDIA_POST_TYPE_VIDEO"`
  - `prompt: "..."`

- Authentication is via browser cookies / Grok web session, not `xai-` API key.

- The developer API (`api.x.ai`) video surface appears to be incomplete or not yet exposed for the `imagine-video-gen` model.

## Reproduction
1. Call `video_generate` with `model: grok-imagine-video` or `grok-imagine-video-1.5`
2. Result: 404 or routing error ("prompt required")

## Expected
The tool should either:
- Route `imagine-video-gen` / `grok-imagine-video*` to the working consumer endpoint, or
- Clearly document that video generation currently requires a Grok web session.

## Suggested Fix Direction
- Add support for the `grok.com/rest/media/post/create` consumer video surface (cookie or session-token auth).
- Update model routing so `imagine-video-gen` and related models are recognized.
- Keep the developer API path for future compatibility when xAI exposes it.

## Evidence
Screenshots from console.xai.com (2026-07-09) showing successful video generation requests to `grok.com/rest/media/post/create` with `imagine-video-gen`.

---

**Note to maintainers:** This PR is intentionally minimal — it only documents the correct working endpoint and the mismatch with the current provider. Full implementation left to the team.