# Capability-aware prompt context optimization

Related: https://github.com/openclaw/openclaw/issues/206424

## Problem and proposal

Keep model-facing context relevant to the effective capabilities of each agent. Operational telemetry is not automatically useful conversation context. Redundant host, session, workspace, operating system and runtime identifiers can consume tokens unnecessarily; repeated sender metadata and mixing invariant policy with volatile conversation facts also deserve scrutiny.

Separate stable instructions from changing facts, preserve attribution and trust boundaries, and project runtime metadata only where it is needed. Do not indiscriminately remove tool instructions or security policy.

## Proof of concept

A scoped runtime overlay on OpenClaw 2026.11.10 (Windows, local Gemma, openai-completions, tool-free Discord) reduced one runtime block from 405 to 57 characters (85.9%). Follow-up recall checks succeeded. This is evidence for the narrow tested route, not a general performance guarantee.

Observed first-token latencies on three subsequent requests were approximately 97, 5 and 40 seconds. History changes and cache behavior confound these measurements, so controlled benchmarks are needed.

- [Detailed experiment and roadmap](https://github.com/Animeleague/openclaw/blob/bank/prompt-optimisation-v3.1-2026-11-27/live-bank/2026-11-27-prompt-optimisation-v3.1/README.md)
- [OpenClaw Transient Tools plugin](https://github.com/Animeleague/openclaw-plugin-transient-tools): complementary public implementation for bounded transient tool interactions rather than indefinitely growing persistent transcripts. Its documented initial compatibility is OpenClaw 2026.7.1.
- Related cache investigation: https://github.com/openclaw/openclaw/issues/202001

## Status and limitations

This draft records a design proposal only; it does not modify runtime behavior. The existing overlay is tied to exact compiled bundles, and private recovery fixtures are excluded. The upstream implementation still needs source-level integration, validation of tool-enabled and other provider paths, security and identity-preservation tests, checkpoint compatibility checks, and controlled benchmarks.

The fork's main branch contains unrelated work and has diverged from upstream. This proposal is isolated on an upstream-based branch. Maintainer guidance is requested before proceeding with implementation.
