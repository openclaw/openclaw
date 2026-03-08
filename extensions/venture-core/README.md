# Venture Core

Shared contract and runtime types for venture-studio modules.

This package defines:

- Module lifecycle contract (`plan`, `execute`, `validate`, `report`)
- Run context shape (`runId`, tracing metadata, logger)
- Result/event schema helpers

It is intentionally backend-agnostic and safe to reuse from gateway routes,
workflow workers, and business modules.
