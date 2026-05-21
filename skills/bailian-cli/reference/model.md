# `bl model` commands

> Auto-generated from `packages/cli/src/commands/catalog.ts`. Do not edit by hand.
> Regenerate: `pnpm --filter bailian-cli run generate:reference` (runs automatically on `build`).

Index: [index.md](index.md)

## Commands in this group

| Command | Description |
| --- | --- |
| `bl model list` | List available foundation models |

## Command details

### `bl model list`

| Field | Value |
| --- | --- |
| **Name** | `model list` |
| **Description** | List available foundation models |
| **Usage** | `bl model list [flags]` |

#### Options

| Flag | Type | Required | Description |
| --- | --- | --- | --- |
| `--name <name>` | string | no | Filter by model name (keyword search) |
| `--page <n>` | number | no | Page number (default: 1) |
| `--page-size <n>` | number | no | Results per page (default: 50) |
| `--provider <name>` | array | no | Filter by model provider (repeatable) |
| `--capability <name>` | array | no | Filter by capability (repeatable) |
| `--region <region>` | string | no | API region (default: cn-beijing) |

#### Examples

```bash
bl model list
```

```bash
bl model list --name qwen
```

```bash
bl model list --page-size 20
```

```bash
bl model list --output json
```
