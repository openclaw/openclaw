# `bl knowledge` commands

> Auto-generated from `packages/cli/src/commands/catalog.ts`. Do not edit by hand.
> Regenerate: `pnpm --filter bailian-cli run generate:reference` (runs automatically on `build`).

Index: [index.md](index.md)

## Commands in this group

| Command | Description |
| --- | --- |
| `bl knowledge retrieve` | Retrieve from a Bailian knowledge base (requires AK/SK) |

## Command details

### `bl knowledge retrieve`

| Field | Value |
| --- | --- |
| **Name** | `knowledge retrieve` |
| **Description** | Retrieve from a Bailian knowledge base (requires AK/SK) |
| **Usage** | `bl knowledge retrieve --index-id <id> --query <text> [flags]` |

#### Options

| Flag | Type | Required | Description |
| --- | --- | --- | --- |
| `--index-id <id>` | string | yes | Knowledge base index ID (required) |
| `--query <text>` | string | yes | Search query (required) |
| `--workspace-id <id>` | string | no | Bailian workspace ID (or env BAILIAN_WORKSPACE_ID) |
| `--top-k <n>` | number | no | Number of results (default: 10) |
| `--rerank` | boolean | no | Enable rerank |
| `--rerank-top-n <n>` | number | no | Rerank top N results |
| `--access-key-id <key>` | string | no | Alibaba Cloud Access Key ID (or env) |
| `--access-key-secret <key>` | string | no | Alibaba Cloud Access Key Secret (or env) |

#### Examples

```bash
bl knowledge retrieve --index-id idx_xxx --query "如何使用阿里云百炼" --workspace-id ws_xxx
```

```bash
bl knowledge retrieve --index-id idx_xxx --query "API限流" --top-k 5 --rerank
```
