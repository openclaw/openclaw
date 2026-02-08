# Changelog

Docs: https://docs.openclaw.ai

## Unreleased

### Added

- Bedrock: add cross-region inference profile discovery with smart deduplication to prevent invocation errors.
  - New `models.bedrockDiscovery.includeInferenceProfiles` config option (defaults to `true`)
  - Discovers both foundation models and inference profiles (e.g., `us.anthropic.claude-3-haiku-20240307-v1:0`, `us.amazon.nova-2-lite-v1:0`)
  - **Smart deduplication**: When a model has both a foundation model ID and an inference profile, only the inference profile is included (prevents "on-demand throughput isn't supported" errors)
  - Enables access to models that require inference profiles (e.g., Claude Opus 4.6, Amazon Nova 2)
  - Inference profiles inherit capabilities from their underlying foundation models
  - Provides improved availability and resilience through cross-region routing
  - See [Bedrock documentation](https://docs.openclaw.ai/bedrock) for details

### Fixed

- Bedrock: fix cache key to include `includeInferenceProfiles` setting, ensuring discovery respects configuration changes
- Bedrock: validate inference profile capabilities against foundation models to prevent surfacing unusable models

## 2026.2.6

### Changes
