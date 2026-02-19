# Modification Cards: Extend Model Input Schema for Video/Audio

**Branch:** `fix/extend-model-input-schema-video-audio`
**Commit:** `f4e4d42` — fix(config): extend model input schema to accept video and audio modalities
**Date:** 2026-02-19

---

## Card 1 — Zod Validation Schema Extension

| Field                   | Value                           |
| ----------------------- | ------------------------------- |
| **File**                | `src/config/zod-schema.core.ts` |
| **Line**                | 41                              |
| **Change Type**         | Schema extension                |
| **Risk**                | Low                             |
| **Backward Compatible** | Yes (additive union members)    |

**Before:**

```ts
input: z.array(z.union([z.literal("text"), z.literal("image")])).optional(),
```

**After:**

```ts
input: z.array(
  z.union([z.literal("text"), z.literal("image"), z.literal("video"), z.literal("audio")]),
).optional(),
```

**Rationale:** The root cause of the gateway startup failure. `openclaw.json` declared `"video"` and `"audio"` for `gemini-3.1-pro-preview`, but Zod rejected them. Adding `z.literal("video")` and `z.literal("audio")` to the union allows the config to validate.

---

## Card 2 — TypeScript Type Widening (ModelDefinitionConfig)

| Field                   | Value                        |
| ----------------------- | ---------------------------- |
| **File**                | `src/config/types.models.ts` |
| **Line**                | 31                           |
| **Change Type**         | Type widening                |
| **Risk**                | Low                          |
| **Backward Compatible** | Yes                          |

**Before:**

```ts
input: Array<"text" | "image">;
```

**After:**

```ts
input: Array<"text" | "image" | "video" | "audio">;
```

**Rationale:** Keeps the TypeScript type in sync with the Zod schema. All downstream consumers that use `ModelDefinitionConfig.input` now accept the wider union.

---

## Card 3 — Model Catalog Types (ModelCatalogEntry + DiscoveredModel)

| Field                   | Value                         |
| ----------------------- | ----------------------------- |
| **File**                | `src/agents/model-catalog.ts` |
| **Lines**               | 11, 20                        |
| **Change Type**         | Type widening                 |
| **Risk**                | Low                           |
| **Backward Compatible** | Yes                           |

**Before:**

```ts
input?: Array<"text" | "image">;  // both types
```

**After:**

```ts
input?: Array<"text" | "image" | "video" | "audio">;  // both types
```

**Rationale:** `ModelCatalogEntry` and `DiscoveredModel` are the internal representations used by discovery and catalog APIs. They must accept the full modality set.

---

## Card 4 — Capability Helper Functions

| Field                   | Value                         |
| ----------------------- | ----------------------------- |
| **File**                | `src/agents/model-catalog.ts` |
| **Lines**               | 174-186 (new)                 |
| **Change Type**         | New functions                 |
| **Risk**                | None (additive)               |
| **Backward Compatible** | Yes                           |

**Added:**

```ts
export function modelSupportsVideo(entry: ModelCatalogEntry | undefined): boolean {
  return entry?.input?.includes("video") ?? false;
}

export function modelSupportsAudio(entry: ModelCatalogEntry | undefined): boolean {
  return entry?.input?.includes("audio") ?? false;
}
```

**Rationale:** Follows the existing `modelSupportsVision` pattern. Used by the media-understanding runner to decide whether to skip pre-processing.

---

## Card 5 — Model Scan Modality Parser

| Field                   | Value                      |
| ----------------------- | -------------------------- |
| **File**                | `src/agents/model-scan.ts` |
| **Lines**               | 101-124                    |
| **Change Type**         | Logic extension            |
| **Risk**                | Low                        |
| **Backward Compatible** | Yes                        |

**Before:**

```ts
function parseModality(modality: string | null): Array<"text" | "image"> {
  // Only detected "image"
}
```

**After:**

```ts
function parseModality(modality: string | null): Array<"text" | "image" | "video" | "audio"> {
  // Now detects "image", "video", and "audio" from modality strings
  // Uses Set for efficient lookup
}
```

**Note:** At the OpenRouter `scanOpenRouterModels` call site (line 480), the result is cast to `("text" | "image")[]` because the external `@mariozechner/pi-ai` `Model` type only accepts those two values. This is safe — the extra modalities are only used internally.

---

## Card 6 — HuggingFace Model Discovery

| Field                   | Value                              |
| ----------------------- | ---------------------------------- |
| **File**                | `src/agents/huggingface-models.ts` |
| **Lines**               | 201-212                            |
| **Change Type**         | Logic extension                    |
| **Risk**                | Low                                |
| **Backward Compatible** | Yes                                |

**Before:**

```ts
const input: Array<"text" | "image"> =
  Array.isArray(modalities) && modalities.includes("image") ? ["text", "image"] : ["text"];
```

**After:**

```ts
const input: Array<"text" | "image" | "video" | "audio"> = ["text"];
if (Array.isArray(modalities)) {
  if (modalities.includes("image")) input.push("image");
  if (modalities.includes("video")) input.push("video");
  if (modalities.includes("audio")) input.push("audio");
}
```

**Rationale:** HuggingFace API returns `architecture.input_modalities` which can include `"video"` and `"audio"`. Previously these were silently dropped.

---

## Card 7 — LiteLLM Onboard Config

| Field                   | Value                                         |
| ----------------------- | --------------------------------------------- |
| **File**                | `src/commands/onboard-auth.config-litellm.ts` |
| **Line**                | 23                                            |
| **Change Type**         | Type widening                                 |
| **Risk**                | None                                          |
| **Backward Compatible** | Yes                                           |

**Change:** `Array<"text" | "image">` → `Array<"text" | "image" | "video" | "audio">`

**Rationale:** Keeps return type of `buildLitellmModelDefinition()` consistent. The default value `["text", "image"]` is unchanged.

---

## Card 8 — Cloudflare AI Gateway Config

| Field                   | Value                                 |
| ----------------------- | ------------------------------------- |
| **File**                | `src/agents/cloudflare-ai-gateway.ts` |
| **Line**                | 20                                    |
| **Change Type**         | Type widening                         |
| **Risk**                | None                                  |
| **Backward Compatible** | Yes                                   |

**Change:** `Array<"text" | "image">` → `Array<"text" | "image" | "video" | "audio">`

**Rationale:** Keeps parameter type of `buildCloudflareAiGatewayModelDefinition()` consistent. The default value `["text", "image"]` is unchanged.

---

## Card 9 — Media-Understanding Runner Skip Logic

| Field                   | Value                               |
| ----------------------- | ----------------------------------- |
| **File**                | `src/media-understanding/runner.ts` |
| **Lines**               | 721-792 (new)                       |
| **Change Type**         | New logic blocks                    |
| **Risk**                | Low                                 |
| **Backward Compatible** | Yes                                 |

**Added:** Two skip blocks after the existing image-skip block (line 689-720):

1. **Video skip** (lines 723-755): When `capability === "video"` and the active model has `"video"` in its `input` array, returns a `"skipped"` decision instead of running external video understanding.

2. **Audio skip** (lines 757-789): Same pattern for `capability === "audio"`.

**Rationale:** Mirrors the existing `modelSupportsVision` skip logic. Models like `gemini-3.1-pro-preview` that natively handle video/audio don't need a separate media-understanding pass.

**Imports added:** `modelSupportsAudio`, `modelSupportsVideo` from `../agents/model-catalog.js`.

---

## Summary Matrix

| #         | File                             | Lines Changed  | Type             | Risk |
| --------- | -------------------------------- | -------------- | ---------------- | ---- |
| 1         | `zod-schema.core.ts`             | +4 -1          | Schema           | Low  |
| 2         | `types.models.ts`                | +1 -1          | Type             | Low  |
| 3         | `model-catalog.ts`               | +16 -2         | Type + Functions | Low  |
| 4         | `model-scan.ts`                  | +18 -6         | Logic            | Low  |
| 5         | `huggingface-models.ts`          | +10 -2         | Logic            | Low  |
| 6         | `onboard-auth.config-litellm.ts` | +1 -1          | Type             | None |
| 7         | `cloudflare-ai-gateway.ts`       | +1 -1          | Type             | None |
| 8         | `runner.ts`                      | +70 +2 imports | Logic            | Low  |
| **Total** | **8 files**                      | **+125 -14**   |                  |      |
