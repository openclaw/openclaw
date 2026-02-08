# Changelog

Docs: https://docs.openclaw.ai

## Unreleased

### Added

- Bedrock: add cross-region inference profile discovery to enable access to models that require inference profiles (e.g., Claude Opus 4.6, Amazon Nova 2).
  - New `models.bedrockDiscovery.includeInferenceProfiles` config option (defaults to `true`)
  - Discovers both foundation models and inference profiles (e.g., `us.anthropic.claude-3-haiku-20240307-v1:0`, `us.amazon.nova-2-lite-v1:0`)
  - Inference profiles inherit capabilities from their underlying foundation models
  - Enables improved availability and resilience through cross-region routing
  - See [Bedrock documentation](https://docs.openclaw.ai/bedrock) for details

### Fixed

- Bedrock: fix cache key to include `includeInferenceProfiles` setting, ensuring discovery respects configuration changes
- Bedrock: validate inference profile capabilities against foundation models to prevent surfacing unusable models

## 2026.2.6

### Changes
