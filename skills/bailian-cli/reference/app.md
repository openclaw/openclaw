# `bl app` commands

> Auto-generated from `packages/cli/src/commands/catalog.ts`. Do not edit by hand.
> Regenerate: `pnpm --filter bailian-cli run generate:reference` (runs automatically on `build`).

Index: [index.md](index.md)

## Commands in this group

| Command | Description |
| --- | --- |
| `bl app call` | Call a Bailian application (agent or workflow) |
| `bl app list` | List Bailian applications |

## Command details

### `bl app call`

| Field | Value |
| --- | --- |
| **Name** | `app call` |
| **Description** | Call a Bailian application (agent or workflow) |
| **Usage** | `bl app call --app-id <id> --prompt <text> [flags]` |

#### Options

| Flag | Type | Required | Description |
| --- | --- | --- | --- |
| `--app-id <id>` | string | yes | Application ID (required) |
| `--prompt <text>` | string | yes | Input prompt text |
| `--image <url>` | array | no | Image URL(s) to pass to the app (repeatable) |
| `--file-id <id>` | array | no | Pre-uploaded file ID(s) (repeatable) |
| `--session-id <id>` | string | no | Session ID for multi-turn conversation |
| `--stream` | boolean | no | Stream response (default: on in TTY) |
| `--pipeline-ids <ids>` | string | no | Knowledge base pipeline IDs (comma-separated) |
| `--memory-id <id>` | string | no | Memory ID for long-term memory |
| `--biz-params <json>` | string | no | Business parameters JSON (workflow variables) |
| `--has-thoughts` | boolean | no | Show agent thinking process |

#### Examples

```bash
bl app call --app-id abc123 --prompt "你好"
```

```bash
bl app call --app-id abc123 --prompt "描述这张图片" --image https://example.com/photo.jpg
```

```bash
bl app call --app-id abc123 --prompt "分析图片" --image img1.jpg --image img2.jpg
```

```bash
bl app call --app-id abc123 --prompt "继续" --session-id sess_xxx --stream
```

```bash
bl app call --app-id abc123 --prompt "搜索资料" --pipeline-ids pipe1,pipe2
```

```bash
bl app call --app-id abc123 --prompt "开始" --biz-params '{"key":"value"}'
```

### `bl app list`

| Field | Value |
| --- | --- |
| **Name** | `app list` |
| **Description** | List Bailian applications |
| **Usage** | `bl app list [flags]` |

#### Options

| Flag | Type | Required | Description |
| --- | --- | --- | --- |
| `--name <name>` | string | no | Filter by app name (keyword search) |
| `--page <n>` | number | no | Page number (default: 1) |
| `--page-size <n>` | number | no | Results per page (default: 30) |
| `--region <region>` | string | no | API region (default: cn-beijing) |

#### Examples

```bash
bl app list
```

```bash
bl app list --name 客服
```

```bash
bl app list --page 2 --page-size 10
```

```bash
bl app list --output json
```
