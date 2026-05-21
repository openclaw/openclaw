# `bl search` commands

> Auto-generated from `packages/cli/src/commands/catalog.ts`. Do not edit by hand.
> Regenerate: `pnpm --filter bailian-cli run generate:reference` (runs automatically on `build`).

Index: [index.md](index.md)

## Commands in this group

| Command | Description |
| --- | --- |
| `bl search web` | Search the web using DashScope MCP WebSearch service |

## Command details

### `bl search web`

| Field | Value |
| --- | --- |
| **Name** | `search web` |
| **Description** | Search the web using DashScope MCP WebSearch service |
| **Usage** | `bl search web --query <text> [flags]` |

#### Options

| Flag | Type | Required | Description |
| --- | --- | --- | --- |
| `--query <text>` | string | yes | Search query text |
| `--count <n>` | number | no | Number of search results (default: 10) |
| `--list-tools` | boolean | no | List available MCP tools and exit |

#### Examples

```bash
bl search web --query "阿里云百炼最新功能"
```

```bash
bl search web --query "TypeScript 5.9 new features" --count 5
```

```bash
bl search web --query "今日新闻"
```

```bash
bl search web --list-tools
```
