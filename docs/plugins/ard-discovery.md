# Agent Resource Discovery Plugin

Agent Resource Discovery (ARD) is a catalog and registry format for publishing AI-accessible resources at `/.well-known/ai-catalog.json`. It is discovery metadata, not an execution protocol. OpenClaw should treat ARD as a control-plane input for finding plugins, MCP server cards, A2A agent cards, catalogs, and registries before any install, activation, or tool execution path runs.

## Goals

- Publish OpenClaw-owned capabilities through ARD-compatible catalog entries.
- Ingest remote ARD catalogs and registry search results into a local discovery index.
- Keep plugin installation, runtime activation, and tool execution behind existing OpenClaw permission and manifest gates.
- Preserve plugin-agnostic gateway behavior by keeping ARD parsing in the bundled ARD plugin.

## Non Goals

- ARD does not replace OpenClaw plugin manifests.
- ARD does not grant trust, permissions, or runtime activation.
- ARD relevance scores do not represent safety or trust.
- ARD catalog ingestion must not materialize plugin runtimes.

## Plugin Contract

The bundled `ard` plugin owns ARD data contracts, validation, and deterministic local search. Its public `api.ts` surface accepts `specVersion: "1.0"` manifests with `entries[]`, validates `urn:air:<publisher>:<namespace>:<name>` identifiers, requires exactly one of `url` or `data`, and accepts both the current `application/mcp-server-card+json` media type and the legacy `application/mcp-server+json` spelling for MCP server cards.

The plugin intentionally has no network, gateway, install, or runtime activation dependencies.

## Implementation Plan

1. Add ARD plugin types, validators, media type compatibility, and local search helpers.
2. Add a catalog ingestion service that fetches `/.well-known/ai-catalog.json`, validates entries, and stores normalized descriptors in a discovery index without activating plugins.
3. Add an ARD publisher for local OpenClaw capabilities that emits stable `urn:air:openclaw.dev:*` identifiers and OpenClaw-specific media types where no standard descriptor exists.
4. Add gateway API methods for catalog search and entry inspection. These methods should return metadata only.
5. Add an explicit install or connect flow that turns a selected ARD entry into an OpenClaw plugin, MCP server, or agent connection using existing trust, permission, and manifest checks.
6. Add optional registry federation after local catalog ingestion is stable.

## Security Model

Remote ARD descriptors are untrusted input. The ingestion path must validate shape, reject ambiguous resource locations, cap result sizes, and avoid executing or importing referenced resources. Trust manifests can be preserved as metadata, but verification must be a separate policy decision. Network fetching belongs behind existing SSRF and allow-list controls.

## Rollout Shape

The lowest-risk rollout is additive:

1. Shared core package and tests.
2. Internal catalog ingestion behind an off-by-default setting.
3. Read-only gateway search.
4. Explicit install/connect flow.
5. Public catalog publication.

This keeps OC core impact small at first. The durable boundary is that ARD discovers resources; OpenClaw decides whether and how they are trusted, installed, and executed.
