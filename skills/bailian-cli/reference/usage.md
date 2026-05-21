# `bl usage` commands

> Auto-generated from `packages/cli/src/commands/catalog.ts`. Do not edit by hand.
> Regenerate: `pnpm --filter bailian-cli run generate:reference` (runs automatically on `build`).

Index: [index.md](index.md)

## Commands in this group

| Command | Description |
| --- | --- |
| `bl usage free` | Query free-tier quota for a model |

## Command details

### `bl usage free`

| Field | Value |
| --- | --- |
| **Name** | `usage free` |
| **Description** | Query free-tier quota for a model |
| **Usage** | `bl usage free --model <model> [flags]` |

#### Options

| Flag | Type | Required | Description |
| --- | --- | --- | --- |
| `--model <model>` | string | yes | Model name to query (e.g. qwen3-max, qwen-turbo) |
| `--region <region>` | string | no | API region (default: cn-beijing) |

#### Examples

```bash
bl usage free --model qwen3-max
```

```bash
bl usage free --model qwen-turbo --output json
```

```bash
bl usage free --model qwen3-max --region cn-beijing
```
