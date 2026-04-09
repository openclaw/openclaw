## Summary

- **Problem:** When the primary model (e.g. GLM-4.7) does not support image input, image attachments from webchat/Control UI are silently dropped. Users receive no feedback and cannot analyze images even when `agents.defaults.imageModel` is configured with a vision-capable model.
- **Why it matters:** This makes webchat appear broken for image uploads on any non-vision primary model, regardless of imageModel configuration.
- **What changed:** Instead of discarding attachments when `supportsImages=false`, `parseMessageWithAttachments` now saves images to the media store and injects `media://inbound/...` references into the message text. This allows the `image` tool (which uses `imageModel`) to analyze them via the standard media:// resolution path.
- **What did NOT change:** The behavior for vision-capable primary models is unchanged. The `supportsImages` gate itself is unchanged. No changes to `detectAndLoadPromptImages` or the agent runner.

## Change Type

- [x] Bug fix

## Scope

- [x] Gateway / orchestration

## Linked Issue

- Closes #60644
- Related #61103
- [x] This PR fixes a bug

## Root Cause

- **Root cause:** `parseMessageWithAttachments` in `chat-attachments.ts` treats `supportsImages=false` as a signal to silently discard all image data. The design assumes that if the primary model can't see images, there's no value in preserving them.
- **Missing detection / guardrail:** No consideration for the case where `agents.defaults.imageModel` provides a separate vision-capable model. The image tool can process media:// references regardless of the primary model's capabilities.
- **Contributing context:** The original code comment explicitly warns against leaking `media://` markers to text-only models, but these markers are opaque strings that don't cause issues — they're resolved by the image tool, not the primary model.

## Regression Test Plan

- [x] Unit test
- Target test: `src/gateway/chat-attachments.test.ts` — new `describe("parseMessageWithAttachments with supportsImages=false")` block
- Scenario: When `supportsImages=false`, images should be saved to disk with `media://` refs injected into message text, not dropped. Non-images should be skipped. Empty attachments should return empty.
- Why this is the smallest reliable guardrail: The test directly exercises the changed code path (`supportsImages=false` branch) and verifies the contract (media refs injected, images array empty, offloadedRefs populated).

## User-visible / Behavior Changes

- Users on text-only primary models (e.g. GLM-4.7) with a vision-capable imageModel configured can now successfully upload and analyze images in webchat/Control UI.
- Previously: images were silently dropped with a log warning `attachment(s) dropped — model does not support images`.
- Now: images are saved and a `media://` reference appears in the message, allowing the `image` tool to process them.

## Diagram

```text
Before:
[webchat image] → [chat.send] → supportsImages=false → DROP all attachments → user sees nothing

After:
[webchat image] → [chat.send] → supportsImages=false → save to disk → inject media:// ref in message
  → [agent receives message with media:// ref] → [image tool reads file via media://] → [imageModel analyzes] → response
```

## Security Impact

- New permissions/capabilities? No
- Secrets/tokens handling changed? No
- New/changed network calls? No
- Command/tool execution surface changed? No
- Data access scope changed? No — images are saved to the same `media/inbound` directory that was already used for large image offloading.

## Repro + Verification

### Environment

- OS: macOS (ARM)
- Runtime: Node.js 25.8.1
- Model/provider: zai/glm-4.7 (primary, text-only), zai/glm-4.6v (imageModel)
- Integration/channel: webchat / Control UI

### Steps

1. Configure a text-only primary model (e.g. glm-4.7) and a vision imageModel (e.g. glm-4.6v)
2. Open OpenClaw Control UI (webchat)
3. Take a screenshot and paste into the chat input
4. Send the message with "analyze this image"

### Expected

The agent receives the message with a `[media attached: media://inbound/<id>]` reference and can use the image tool to analyze it.

### Actual (before fix)

Gateway log shows: `parseMessageWithAttachments: 1 attachment(s) dropped — model does not support images`. The agent receives the text message only, with no indication an image was attached.

## Evidence

- [x] Failing test/log before + passing after
  - Before: `attachment(s) dropped — model does not support images` in gateway.err.log
  - After: `attachment(s) saved for text-only model` in gateway.log, agent successfully analyzes image

## Human Verification

- Verified scenarios:
  - Pasted screenshot in webchat → agent received media:// ref → image tool analyzed successfully
  - Multiple consecutive image uploads → all processed correctly
  - Non-image attachment → correctly skipped
- Edge cases checked: empty message with image, large image (>100KB)
- What I did **not** verify: ACP bridge clients (the `persistChatSendImages` function returns early for ACP clients, which is existing behavior)

## Review Conversations

- [x] I replied to or resolved every bot review conversation I addressed in this PR.
- [x] I left unresolved only the conversations that still need reviewer or maintainer judgment.

## Compatibility / Migration

- Backward compatible? Yes
- Config/env changes? No
- Migration needed? No

## Risks and Mitigations

- Risk: Additional disk I/O for text-only models — images are now saved even when the primary model can't use them.
  - Mitigation: This matches the existing behavior for large images (>2MB offload threshold). The media store has existing cleanup mechanisms. For models that support images, the code path is unchanged.
