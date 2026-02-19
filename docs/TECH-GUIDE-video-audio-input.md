# Technical Guide: Video/Audio Input Modality Support

**Version:** 1.0
**Branch:** `fix/extend-model-input-schema-video-audio`
**Author:** Automated (Claude Opus 4.6)
**Date:** 2026-02-19

---

## 1. Problem Statement

OpenClaw gateway fails to start when the user configuration file (`~/.openclaw/openclaw.json`) declares `"video"` and `"audio"` as input modalities for a model (e.g., `gemini-3.1-pro-preview`). The Zod validation schema rejects these values because it only allows `"text"` and `"image"`.

### Error Reproduction

```
$ node openclaw.mjs gateway run --port 18789
Error: Validation failed for openclaw.json
  - models.providers.google.models[1].input: Invalid literal value.
    Expected "text" | "image", received "video"
```

### Root Cause

```json
// ~/.openclaw/openclaw.json (user config)
{
  "models": {
    "providers": {
      "google": {
        "models": [
          {
            "id": "gemini-3.1-pro-preview",
            "input": ["text", "image", "video", "audio"] // <-- "video" and "audio" rejected
          }
        ]
      }
    }
  }
}
```

The Zod schema at `src/config/zod-schema.core.ts:41` was:

```ts
input: z.array(z.union([z.literal("text"), z.literal("image")])).optional();
```

---

## 2. Solution Architecture

### Design Principle

Rather than stripping unknown modalities, we **extend the schema** to support them. This is the correct approach because:

1. The codebase already has `MediaUnderstandingCapability = "image" | "audio" | "video"` in `src/media-understanding/types.ts`.
2. Models like Gemini genuinely support video/audio input natively.
3. The media-understanding runner already has a skip-if-native-support pattern for images.

### Change Layers

```
Layer 1: Validation        zod-schema.core.ts       (Zod accepts new literals)
              |
Layer 2: Types             types.models.ts          (TS type widens)
              |
Layer 3: Internal Types    model-catalog.ts          (ModelCatalogEntry widens)
              |                                       cloudflare-ai-gateway.ts
              |                                       onboard-auth.config-litellm.ts
              |
Layer 4: Discovery         model-scan.ts             (parseModality detects new values)
              |             huggingface-models.ts     (HF API modalities mapped)
              |
Layer 5: Capability Check  model-catalog.ts          (modelSupportsVideo/Audio helpers)
              |
Layer 6: Runtime Skip      runner.ts                 (skip pre-processing if native)
```

---

## 3. Detailed Changes

### 3.1 Validation Layer — Zod Schema

**File:** `src/config/zod-schema.core.ts`

The `ModelDefinitionSchema.input` field now accepts four literals:

```ts
input: z.array(
  z.union([
    z.literal("text"),
    z.literal("image"),
    z.literal("video"),   // NEW
    z.literal("audio"),   // NEW
  ]),
).optional(),
```

**Impact:** Any `openclaw.json` that declares video or audio modalities will now pass validation.

### 3.2 TypeScript Types

All internal types that represent model input modalities were widened from:

```ts
Array<"text" | "image">;
```

to:

```ts
Array<"text" | "image" | "video" | "audio">;
```

**Files affected:**

- `src/config/types.models.ts` — `ModelDefinitionConfig.input`
- `src/agents/model-catalog.ts` — `ModelCatalogEntry.input`, `DiscoveredModel.input`
- `src/agents/cloudflare-ai-gateway.ts` — `buildCloudflareAiGatewayModelDefinition` params
- `src/commands/onboard-auth.config-litellm.ts` — `buildLitellmModelDefinition` return type

### 3.3 Discovery Layer

#### OpenRouter / Model Scan (`src/agents/model-scan.ts`)

The `parseModality()` function now detects video and audio from modality strings:

```ts
function parseModality(modality: string | null): Array<"text" | "image" | "video" | "audio"> {
  if (!modality) return ["text"];
  const parts = new Set(
    modality
      .toLowerCase()
      .split(/[^a-z]+/)
      .filter(Boolean),
  );
  const result: Array<"text" | "image" | "video" | "audio"> = ["text"];
  if (parts.has("image")) result.push("image");
  if (parts.has("video")) result.push("video");
  if (parts.has("audio")) result.push("audio");
  return result;
}
```

**Compatibility note:** At the `scanOpenRouterModels` call site, the result is cast to `("text" | "image")[]` because the external `@mariozechner/pi-ai` library's `Model` type only accepts those two values. This is a deliberate narrowing — the broader type is used internally for our own catalog.

#### HuggingFace Discovery (`src/agents/huggingface-models.ts`)

Previously only checked `modalities.includes("image")`. Now checks all three:

```ts
const input: Array<"text" | "image" | "video" | "audio"> = ["text"];
if (Array.isArray(modalities)) {
  if (modalities.includes("image")) input.push("image");
  if (modalities.includes("video")) input.push("video");
  if (modalities.includes("audio")) input.push("audio");
}
```

### 3.4 Capability Helpers (`src/agents/model-catalog.ts`)

Two new exported functions, following the existing `modelSupportsVision` pattern:

```ts
export function modelSupportsVideo(entry: ModelCatalogEntry | undefined): boolean {
  return entry?.input?.includes("video") ?? false;
}

export function modelSupportsAudio(entry: ModelCatalogEntry | undefined): boolean {
  return entry?.input?.includes("audio") ?? false;
}
```

### 3.5 Runtime Skip Logic (`src/media-understanding/runner.ts`)

Two new skip blocks in `runCapability()`, placed after the existing image-skip block (line 689-720). They follow the identical pattern:

```
IF capability === "video"/"audio" AND activeProvider exists
  THEN load model catalog
  THEN look up model entry
  IF model natively supports video/audio
    THEN return skipped decision (no external processing needed)
```

This means:

- **Gemini 3.1 Pro Preview** with `input: ["text", "image", "video", "audio"]` will skip the media-understanding pipeline for video and audio attachments — they'll be passed directly to the model.
- **Models without native support** will continue to use the external media-understanding providers as before.

---

## 4. What Was NOT Changed

| Area                                         | Reason                                                                     |
| -------------------------------------------- | -------------------------------------------------------------------------- |
| `~/.openclaw/openclaw.json`                  | User config is correct; our schema was too narrow                          |
| Default values (`["text"]`)                  | Still correct — text is always the baseline                                |
| Existing `.includes("image")` runtime checks | Unaffected; they continue to work                                          |
| Display logic (`join("+")`)                  | Already generic; handles any array                                         |
| Gateway protocol schema                      | No changes needed; modalities don't flow through the gateway wire protocol |
| `MediaUnderstandingCapability` type          | Already defined as `"image" \| "audio" \| "video"` in `types.ts`           |

---

## 5. External Dependency Constraint

The `@mariozechner/pi-ai` library (v0.53.0) defines `Model.input` as `("text" | "image")[]`. This is an external constraint we cannot change. At the one call site in `model-scan.ts` where `parseModality()` feeds into a `Model` object, we use an explicit cast:

```ts
input: parseModality(entry.modality) as ("text" | "image")[],
```

This is safe because the `Model` object is only used for OpenRouter probing (tool/image tests), not for our internal catalog.

---

## 6. Verification Steps

### Type Safety

```bash
npx tsc --noEmit
# Expected: 0 errors (clean compilation)
```

### Gateway Startup

```bash
node openclaw.mjs gateway run --port 18789
# Expected: No validation errors, gateway starts successfully
```

### Port Verification

```bash
ss -tlnp | grep :18789
# Expected: LISTEN on *:18789
```

### Unit Tests

```bash
npx vitest run --config vitest.unit.config.ts
# Expected: All tests pass
```

---

## 7. Future Considerations

1. **pi-ai library update:** When `@mariozechner/pi-ai` updates `Model.input` to accept video/audio, the cast in `model-scan.ts:480` can be removed.

2. **New modalities:** If additional modalities are needed (e.g., `"code"`, `"document"`), the pattern is clear: add the literal to the Zod union, widen all type annotations, add a `modelSupports*` helper, and optionally add a skip block in the runner.

3. **Media-understanding providers:** The skip logic only applies when the _primary_ model handles the modality natively. External media-understanding providers for video/audio transcription remain available for models that don't declare native support.
