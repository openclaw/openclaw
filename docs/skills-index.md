# Skills Index

OpenClaw can optionally load skills from a `skills-index.json` file instead of scanning every child directory in a skills root.

This is an opt-in startup optimization for large skill collections. It reduces directory discovery work. It does not eliminate reading `SKILL.md` files.

## Enable

Add this to your config:

```json
{
  "skills": {
    "load": {
      "indexFirst": true,
      "indexFileName": "skills-index.json"
    }
  }
}
```

If `indexFirst` is enabled, OpenClaw looks for `skills-index.json` in each skills root before falling back to normal directory scanning.

## Strict mode

```json
{
  "skills": {
    "load": {
      "indexFirst": true,
      "strictIndex": true
    }
  }
}
```

With `strictIndex: true`, indexed roots require a valid index instead of falling back to scanning.

## Index format

Use root-relative paths:

```json
{
  "version": 1,
  "generated": "2026-03-05T00:00:00.000Z",
  "skills": [
    {
      "name": "klaviyo",
      "path": "klaviyo",
      "description": "Klaviyo API reference and task guide"
    }
  ]
}
```

Notes:

1. `path` must be relative to the indexed root.
2. Absolute paths are rejected.
3. Paths that resolve outside the root are rejected.

## Build an index

Use the helper script:

```bash
node scripts/build-skills-index.mjs ~/.agents/skills
```

If no path is provided, the script defaults to `~/.agents/skills`.

## Watch behavior

When `indexFirst` is enabled, OpenClaw watches `skills-index.json` for changes.

If you add, remove, or rename skills in an indexed root, rebuild the index. Changes inside underlying skill directories are still watched through `SKILL.md`, but discovery changes depend on the index being refreshed.
