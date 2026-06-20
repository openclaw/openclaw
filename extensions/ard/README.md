# @openclaw/ard-plugin

Official Agent Resource Discovery catalog plugin for OpenClaw.

The plugin exposes ARD catalog contracts, runtime validation, MCP media-type
compatibility, and deterministic local search helpers. It is metadata-only: it
does not fetch remote catalogs, install plugins, activate runtimes, or execute
referenced resources.

## Install

```bash
openclaw plugins install clawhub:@openclaw/ard-plugin
```

Restart the Gateway after installing or updating the plugin.

## What it provides

- `specVersion: "1.0"` catalog manifest validation
- `urn:air:<publisher>:<namespace>:<name>` identifier parsing
- exactly-one-of `url` or `data` entry validation
- current and legacy MCP server-card media-type compatibility
- deterministic local search, filtering, scoring, and pagination helpers

## Package

- Plugin id: `ard`
- Package: `@openclaw/ard-plugin`
- Minimum OpenClaw host: `2026.6.8`
