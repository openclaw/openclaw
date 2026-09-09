---
summary: "The sequence, file checklist, and contract-test pattern for adding a capability to the plugin system"
read_when:
  - Adding a new plugin capability
  - You are deciding what core should own versus a vendor plugin
  - You need the file checklist and contract-test pattern for a new capability
title: "Adding a new capability"
sidebarTitle: "New capability"
---

The recommended sequence for adding a capability the plugin API does not have
yet, plus the file checklist and contract-test pattern. Part of the [Plugin
architecture internals](/plugins/architecture-internals) guide.

## Adding a new capability

When a plugin needs behavior that does not fit the current API, do not bypass
the plugin system with a private reach-in. Add the missing capability.

Recommended sequence:

1. **Define the core contract.** Decide what shared behavior core should own:
   policy, fallback, config merge, lifecycle, channel-facing semantics, and
   runtime helper shape.
2. **Add typed plugin registration/runtime surfaces.** Extend
   `OpenClawPluginApi` and/or `api.runtime` with the smallest useful typed
   capability surface.
3. **Wire core + channel/feature consumers.** Channels and feature plugins
   should consume the new capability through core, not by importing a vendor
   implementation directly.
4. **Register vendor implementations.** Vendor plugins then register their
   backends against the capability.
5. **Add contract coverage.** Add tests so ownership and registration shape
   stay explicit over time.

This is how OpenClaw stays opinionated without becoming hardcoded to one
provider's worldview. See [Adding capabilities](/plugins/adding-capabilities)
for a concrete file checklist and worked example.

### Capability checklist

When you add a new capability, the implementation should usually touch these
surfaces together:

- core contract types in `src/<capability>/types.ts`
- core runner/runtime helper in `src/<capability>/runtime.ts`
- plugin API registration surface in `src/plugins/types.ts`
- plugin registry wiring in `src/plugins/registry.ts`
- plugin runtime exposure in `src/plugins/runtime/*` when feature/channel
  plugins need to consume it
- capture/test helpers in `src/test-utils/plugin-registration.ts`
- ownership/contract assertions in `src/plugins/contracts/registry.ts`
- operator/plugin docs in `docs/`

If one of those surfaces is missing, that is usually a sign the capability is
not fully integrated yet.

### Capability template

Minimal pattern:

```ts
// core contract
export type VideoGenerationProviderPlugin = {
  id: string;
  label: string;
  generateVideo: (req: VideoGenerationRequest) => Promise<VideoGenerationResult>;
};

// plugin API
api.registerVideoGenerationProvider({
  id: "openai",
  label: "OpenAI",
  async generateVideo(req) {
    return await generateOpenAiVideo(req);
  },
});

// shared runtime helper for feature/channel plugins
const clip = await api.runtime.videoGeneration.generate({
  prompt: "Show the robot walking through the lab.",
  cfg,
});
```

Contract test pattern (`src/plugins/contracts/registry.ts` exposes ownership
lookups such as `providerContractPluginIds`; tests assert a plugin's
`contracts.videoGenerationProviders` list matches what it actually registers):

```ts
expect(pluginManifest.contracts?.videoGenerationProviders).toEqual(["openai"]);
```

That keeps the rule simple:

- core owns the capability contract + orchestration
- vendor plugins own vendor implementations
- feature/channel plugins consume runtime helpers
- contract tests keep ownership explicit
