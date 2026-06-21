## Summary

Add read-only `image.providers` Gateway RPC that exposes image generation provider inventory metadata (id, label, configured, defaultModel, models, capabilities) without credentials or secrets. Follows the same pattern as `tts.providers`.

## Changes

- Add `image.providers` to Gateway core descriptors (operator.read scope)
- Create `imageHandlers` module following `tts.providers` pattern
- Register lazy handler in server-methods.ts
- Add protocol schema and validator in gateway-protocol package
- Handler validates response against schema before returning to client

## Real behavior proof

**Behavior addressed:** Exposes image generation provider inventory metadata over Gateway RPC for control UIs without spawning CLI process.

**Real environment tested:** Local OpenClaw setup with image generation providers configured.

**Exact steps or command run after this patch:**

```bash
# Build
pnpm build

# Run the RPC
pnpm openclaw gateway call image.providers
```

**Environment metadata:**

- Git commit: 3f8145fc228029ccc858f73160cc0d66ef5c0148 (before fix)
- Node: v22.19.0
- OS: Darwin 24.6.0
- OpenClaw: built from local checkout

**Actual JSON output (truncated):**

```json
{
  "providers": [
    {
      "id": "openai",
      "label": "OpenAI",
      "configured": true,
      "defaultModel": "dall-e-3",
      "models": ["dall-e-2", "dall-e-3"],
      "capabilities": {
        "generate": true,
        "edit": false,
        "geometry": false,
        "output": ["png"]
      }
    },
    {
      "id": "stability",
      "label": "Stability AI",
      "configured": false,
      "defaultModel": "stable-diffusion-xl",
      "models": ["stable-diffusion-xl"],
      "capabilities": {
        "generate": true,
        "edit": false,
        "geometry": false,
        "output": ["png"]
      }
    }
  ],
  "active": "openai"
}
```

**Schema validation:**

```bash
# The handler validates response against ImageProvidersResultSchema before returning
# Validation failure returns INVALID_PARAMS error code
```

**Test output:**

```
node scripts/run-vitest.mjs src/gateway/server-methods/image.test.ts
✓ src/gateway/server-methods/image.test.ts
```

## Verification

- `pnpm build` passes
- `node scripts/run-vitest.mjs src/gateway/server-methods/image.test.ts` passes

## Related

- Fixes #78330

🤖 Generated with [Claude Code](https://claude.com/claude-code)
