<!-- CONTRACT: DO NOT EDIT THIS HEADER -->
<!--
CC10X Session Memory - patterns.md
This file tracks project-specific patterns, gotchas, and conventions.
Managed by cc10x-router skill. Format changes require skill coordination.
-->

## Common Gotchas

- Android SDK tools are x86-64 only - Google doesn't provide ARM64 builds
- Building Android apps on ARM64 requires architectural solutions (emulation, cross-compilation, cloud build)
- Gradle daemon caches x86-64 binaries in ~/.gradle/caches - clearing may help but doesn't solve architecture issue
- **Recommended:** Use GitHub Actions CI for Android builds on ARM64 systems - simplest and most reliable approach

## Last Updated

2026-02-08 12:01:28 UTC
