# `bl memory` commands

> Auto-generated from `packages/cli/src/commands/catalog.ts`. Do not edit by hand.
> Regenerate: `pnpm --filter bailian-cli run generate:reference` (runs automatically on `build`).

Index: [index.md](index.md)

## Commands in this group

| Command | Description |
| --- | --- |
| `bl memory add` | Add memory from messages or custom content |
| `bl memory delete` | Delete a memory node |
| `bl memory list` | List memory nodes for a user |
| `bl memory profile create` | Create a user profile schema for memory profiling |
| `bl memory profile get` | Get user profile by schema ID and user ID |
| `bl memory search` | Search memory nodes by query or messages |
| `bl memory update` | Update a memory node content |

## Command details

### `bl memory add`

| Field | Value |
| --- | --- |
| **Name** | `memory add` |
| **Description** | Add memory from messages or custom content |
| **Usage** | `bl memory add --user-id <id> [--messages <json>] [--content <text>] [flags]` |

#### Options

| Flag | Type | Required | Description |
| --- | --- | --- | --- |
| `--user-id <id>` | string | yes | User ID (required) |
| `--messages <json>` | string | no | Messages JSON array: [{"role":"user","content":"..."},...] |
| `--content <text>` | string | no | Custom content text to memorize |
| `--profile-schema <id>` | string | no | Profile schema ID for user profiling |
| `--memory-library-id <id>` | string | no | Memory library ID (isolate memory space) |

#### Examples

```bash
bl memory add --user-id user1 --content "用户喜欢Python编程"
```

```bash
bl memory add --user-id user1 --messages '[{"role":"user","content":"我喜欢旅行"}]'
```

```bash
bl memory add --user-id user1 --content "住在北京" --profile-schema schema_xxx
```

### `bl memory delete`

| Field | Value |
| --- | --- |
| **Name** | `memory delete` |
| **Description** | Delete a memory node |
| **Usage** | `bl memory delete --node-id <id> --user-id <id>` |

#### Options

| Flag | Type | Required | Description |
| --- | --- | --- | --- |
| `--node-id <id>` | string | yes | Memory node ID (required) |
| `--user-id <id>` | string | yes | User ID (required) |
| `--memory-library-id <id>` | string | no | Memory library ID (non-default library) |

#### Examples

```bash
bl memory delete --node-id node_xxx --user-id user1
```

### `bl memory list`

| Field | Value |
| --- | --- |
| **Name** | `memory list` |
| **Description** | List memory nodes for a user |
| **Usage** | `bl memory list --user-id <id> [flags]` |

#### Options

| Flag | Type | Required | Description |
| --- | --- | --- | --- |
| `--user-id <id>` | string | yes | User ID (required) |
| `--page-size <n>` | number | no | Results per page (default: 10) |
| `--page <n>` | number | no | Page number (default: 1) |
| `--memory-library-id <id>` | string | no | Memory library ID |

#### Examples

```bash
bl memory list --user-id user1
```

```bash
bl memory list --user-id user1 --page-size 20 --page 2
```

### `bl memory profile create`

| Field | Value |
| --- | --- |
| **Name** | `memory profile create` |
| **Description** | Create a user profile schema for memory profiling |
| **Usage** | `bl memory profile create --name <name> --attributes <json> [flags]` |

#### Options

| Flag | Type | Required | Description |
| --- | --- | --- | --- |
| `--name <name>` | string | yes | Schema name (required) |
| `--description <text>` | string | no | Schema description |
| `--attributes <json>` | string | yes | Attributes JSON array: [{"name":"age","description":"年龄"}] |

#### Examples

```bash
bl memory profile create --name "user_basic" --attributes '[{"name":"age","description":"年龄"},{"name":"hobby","description":"爱好"}]'
```

### `bl memory profile get`

| Field | Value |
| --- | --- |
| **Name** | `memory profile get` |
| **Description** | Get user profile by schema ID and user ID |
| **Usage** | `bl memory profile get --schema-id <id> --user-id <id>` |

#### Options

| Flag | Type | Required | Description |
| --- | --- | --- | --- |
| `--schema-id <id>` | string | yes | Profile schema ID (required) |
| `--user-id <id>` | string | yes | User ID (required) |

#### Examples

```bash
bl memory profile get --schema-id schema_xxx --user-id user1
```

### `bl memory search`

| Field | Value |
| --- | --- |
| **Name** | `memory search` |
| **Description** | Search memory nodes by query or messages |
| **Usage** | `bl memory search --user-id <id> [--query <text>] [flags]` |

#### Options

| Flag | Type | Required | Description |
| --- | --- | --- | --- |
| `--user-id <id>` | string | yes | User ID (required) |
| `--query <text>` | string | no | Search query text |
| `--messages <json>` | string | no | Messages JSON array for context-based search |
| `--top-k <n>` | number | no | Number of results to return (default: 10) |
| `--memory-library-id <id>` | string | no | Memory library ID |

#### Examples

```bash
bl memory search --user-id user1 --query "编程偏好"
```

```bash
bl memory search --user-id user1 --messages '[{"role":"user","content":"推荐一本书"}]' --top-k 5
```

### `bl memory update`

| Field | Value |
| --- | --- |
| **Name** | `memory update` |
| **Description** | Update a memory node content |
| **Usage** | `bl memory update --node-id <id> --user-id <id> --content <text>` |

#### Options

| Flag | Type | Required | Description |
| --- | --- | --- | --- |
| `--node-id <id>` | string | yes | Memory node ID (required) |
| `--user-id <id>` | string | yes | User ID (required) |
| `--content <text>` | string | yes | New content for the memory node (required) |
| `--memory-library-id <id>` | string | no | Memory library ID (non-default library) |

#### Examples

```bash
bl memory update --node-id node_xxx --user-id user1 --content "更新后的记忆内容"
```
