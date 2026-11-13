# Knowledge

Evidence-backed knowledge vault, memory provider, and Control UI explorer for
OpenClaw agents. Agents save pages, claims, and typed relationships as Markdown
records with retained source evidence, journaled writes, and local Git history.

## Get started

Knowledge is bundled but off by default. Select it as the memory provider:

```json5
{
  plugins: {
    slots: {
      memory: "knowledge",
    },
  },
}
```

Then open **Knowledge** in the Control UI sidebar. Each agent gets its own store
under `<state dir>/knowledge/`; configure shared stores, write access, and the
maintenance schedule under `plugins.entries.knowledge.config`.

See the [Knowledge guide](https://docs.openclaw.ai/plugins/knowledge) for
configuration, stores and access, tools, bundled skills, and limits.

## Development

Registry and storage work run in worker threads under Node and Bun. Their
entrypoints are declared in `src/infra/runtime-process-manifest.ts` for standalone
packaging; each worker installs the host-selected SDK aliases before loading its
storage modules.

Bundled workflow skills keep shared guidance in `skills/shared/`. Refresh the
copies embedded in each skill after editing it:

```bash
node extensions/knowledge/scripts/sync-skill-references.mjs
```

Rebuild the Control UI assets after browser changes:

```bash
node --import ./scripts/tsx.mjs scripts/build-plugin-control-ui.mts extensions/knowledge
```

Third-party attributions are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
