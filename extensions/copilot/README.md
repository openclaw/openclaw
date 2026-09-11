# GitHub Copilot agent runtime (OpenClaw plugin)

External OpenClaw plugin that registers a `copilot` agent harness backed by `@github/copilot-sdk` and the GitHub Copilot CLI.

## Install

```bash
openclaw plugins install @openclaw/copilot
```

Restart the Gateway after installing or updating the plugin.

The harness claims the canonical subscription `github-copilot` provider plus
custom BYOK provider entries that the Copilot SDK can represent. Manifest-owned
native provider ids stay with their owning runtimes. The harness is opt-in only:
selection requires explicit `agentRuntime.id: "copilot"` on a model or provider
entry; `auto` never picks it. OpenClaw remains the default embedded runtime.

See [GitHub Copilot agent runtime](../../docs/plugins/copilot.md) for
configuration, the doctor contract, transcript mirroring, compaction, side
questions, replay, and the supported-surface contract.

## Package

- Plugin id: `copilot`
- Package: `@openclaw/copilot`
- Historical installation floor: `openclaw.install.minHostVersion` remains
  `>=2026.5.28`. This is not the package admission floor.
- Current package admission floor: `openclaw.compat.pluginApi` is
  `>=2026.9.3`. Install and load enforce this declared Plugin API range.
- Code Mode is an optional surface on an admitted host. It additionally
  requires provider transcript commit support when `exec` or `wait` survives
  final prompt filtering. Ordinary tools remain available without it.
- Unrestricted Code Mode publication remains blocked until the release owner
  assigns the first release containing that capability and the package floor
  is updated to that release.
