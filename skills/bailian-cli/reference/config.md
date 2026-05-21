# `bl config` commands

> Auto-generated from `packages/cli/src/commands/catalog.ts`. Do not edit by hand.
> Regenerate: `pnpm --filter bailian-cli run generate:reference` (runs automatically on `build`).

Index: [index.md](index.md)

## Commands in this group

| Command | Description |
| --- | --- |
| `bl config export-schema` | Export all (or one) CLI command(s) as Anthropic/OpenAI-compatible JSON tool schemas |
| `bl config set` | Set a config value |
| `bl config show` | Display current configuration |

## Command details

### `bl config export-schema`

| Field | Value |
| --- | --- |
| **Name** | `config export-schema` |
| **Description** | Export all (or one) CLI command(s) as Anthropic/OpenAI-compatible JSON tool schemas |
| **Usage** | `bl config export-schema [--command "<name>"]` |

#### Options

| Flag | Type | Required | Description |
| --- | --- | --- | --- |
| `--command <name>` | string | no | Export schema for a specific command only (e.g. "image generate") |

#### Examples

```bash
bl config export-schema
```

```bash
bl config export-schema --command "video generate"
```

### `bl config set`

| Field | Value |
| --- | --- |
| **Name** | `config set` |
| **Description** | Set a config value |
| **Usage** | `bl config set --key <key> --value <value>` |

#### Options

| Flag | Type | Required | Description |
| --- | --- | --- | --- |
| `--key <key>` | string | no | Config key (region, base_url, output, output_dir, timeout, api_key, access_token, default_*_model, access_key_id, access_key_secret, workspace_id) |
| `--value <value>` | string | no | Value to set |

#### Examples

```bash
bl config set --key output --value json
```

```bash
bl config set --key timeout --value 600
```

```bash
bl config set --key base_url --value https://dashscope.aliyuncs.com
```

### `bl config show`

| Field | Value |
| --- | --- |
| **Name** | `config show` |
| **Description** | Display current configuration |
| **Usage** | `bl config show` |

#### Options

_No command-specific options._

#### Examples

```bash
bl config show
```

```bash
bl config show --output json
```
