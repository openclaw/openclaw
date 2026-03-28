# Requirements Document

## Introduction

Add support for Amazon Bedrock Guardrails to the OpenClaw amazon-bedrock extension plugin. Bedrock Guardrails allow users to apply content filtering, topic denial, word filters, sensitive information filters, and contextual grounding checks to model invocations via the Converse API's `guardrailConfig` field. This feature injects the guardrail configuration into the Bedrock `ConverseStreamCommand` payload using the existing `onPayload` hook from the plugin's `wrapStreamFn`, keeping the change self-contained within the amazon-bedrock extension.

## Glossary

- **Plugin**: An OpenClaw extension package under `extensions/` that registers providers, hooks, or tools via the plugin SDK.
- **Bedrock_Guardrail**: An AWS Bedrock resource identified by a guardrail identifier and version that applies content policies to model invocations.
- **guardrailConfig**: The top-level field in the Bedrock Converse API request payload that specifies which guardrail to apply, its version, and optional stream processing mode.
- **guardrailIdentifier**: A string that uniquely identifies a Bedrock Guardrail (either an ARN or a guardrail ID).
- **guardrailVersion**: A string specifying which version of the guardrail to use (e.g. `"1"`, `"DRAFT"`).
- **streamProcessingMode**: An optional Bedrock parameter (`"sync"` or `"async"`) controlling whether guardrail evaluation happens synchronously or asynchronously during streaming.
- **onPayload**: A callback hook in pi-ai's streaming options that allows mutation of the outgoing API request payload before it is sent.
- **wrapStreamFn**: A provider plugin hook that wraps the stream function, enabling payload mutation via `onPayload`.
- **configSchema**: The JSON Schema in `openclaw.plugin.json` that defines the shape of a plugin's user-facing configuration.
- **streamWithPayloadPatch**: A utility function exported from the plugin SDK that simplifies payload mutation by wrapping `onPayload` handling.
- **Plugin_Config**: The validated configuration object for the amazon-bedrock plugin, accessible via `api.pluginConfig` during registration.

## Requirements

### Requirement 1: Guardrail Configuration Schema

**User Story:** As an OpenClaw operator, I want to configure Bedrock Guardrails via the plugin config, so that I can apply content policies to all Bedrock model invocations without modifying code.

#### Acceptance Criteria

1. THE configSchema in `openclaw.plugin.json` SHALL define a `guardrail` object property with `guardrailIdentifier` (string), `guardrailVersion` (string), and `streamProcessingMode` (string) sub-properties.
2. THE configSchema SHALL treat `guardrailIdentifier` and `guardrailVersion` as required when the `guardrail` object is present, by not defining defaults for those fields.
3. THE configSchema SHALL treat `streamProcessingMode` as optional.
4. THE configSchema SHALL accept `streamProcessingMode` values of `"sync"` or `"async"` only.
5. WHEN the `guardrail` object is omitted from Plugin_Config, THE Plugin SHALL not inject any guardrail configuration into the payload.

### Requirement 2: Guardrail Payload Injection

**User Story:** As an OpenClaw operator, I want guardrail config to be injected into every Bedrock Converse API request, so that all model invocations are subject to the configured guardrail policies.

#### Acceptance Criteria

1. WHEN a valid `guardrail` configuration is present in Plugin_Config, THE Plugin SHALL inject a `guardrailConfig` field into the Bedrock `ConverseStreamCommand` payload containing `guardrailIdentifier` and `guardrailVersion` from the configuration.
2. WHEN `streamProcessingMode` is specified in Plugin_Config, THE Plugin SHALL include `streamProcessingMode` in the injected `guardrailConfig` field.
3. WHEN `streamProcessingMode` is not specified in Plugin_Config, THE Plugin SHALL omit `streamProcessingMode` from the injected `guardrailConfig` field.
4. THE Plugin SHALL inject the `guardrailConfig` field using the `onPayload` hook via `streamWithPayloadPatch`, preserving any existing `onPayload` callbacks in the chain.
5. THE Plugin SHALL apply guardrail injection to all Bedrock model invocations regardless of whether the model is Anthropic or non-Anthropic.

### Requirement 3: Compatibility with Existing Stream Wrappers

**User Story:** As an OpenClaw developer, I want guardrail injection to compose cleanly with the existing cache-behavior wrappers, so that both features work together without conflicts.

#### Acceptance Criteria

1. THE Plugin SHALL apply guardrail payload injection as an outer wrapper around the existing `wrapStreamFn` logic (cache behavior selection for Anthropic vs non-Anthropic models).
2. WHEN guardrail config is present, THE Plugin SHALL preserve the existing Anthropic cache passthrough and non-Anthropic `createBedrockNoCacheWrapper` behavior.
3. WHEN guardrail config is absent, THE Plugin SHALL return the same `wrapStreamFn` result as the current implementation (no behavioral change).

### Requirement 4: Documentation

**User Story:** As an OpenClaw user, I want documentation on how to configure Bedrock Guardrails, so that I can enable content filtering for Bedrock models.

#### Acceptance Criteria

1. THE documentation at `docs/providers/bedrock.md` SHALL include a section describing how to configure Bedrock Guardrails via the plugin config.
2. THE documentation SHALL include a configuration example showing the `guardrail` object with `guardrailIdentifier`, `guardrailVersion`, and `streamProcessingMode`.
3. THE documentation SHALL note that `guardrailIdentifier` accepts both guardrail IDs and full ARNs.
4. THE documentation SHALL note the required IAM permissions for guardrail usage (`bedrock:ApplyGuardrail`).
