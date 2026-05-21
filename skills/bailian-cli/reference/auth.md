# `bl auth` commands

> Auto-generated from `packages/cli/src/commands/catalog.ts`. Do not edit by hand.
> Regenerate: `pnpm --filter bailian-cli run generate:reference` (runs automatically on `build`).

Index: [index.md](index.md)

## Commands in this group

| Command | Description |
| --- | --- |
| `bl auth login` | Authenticate with API key |
| `bl auth logout` | Clear stored credentials |
| `bl auth status` | Show current authentication state |

## Command details

### `bl auth login`

| Field | Value |
| --- | --- |
| **Name** | `auth login` |
| **Description** | Authenticate with API key |
| **Usage** | `bl auth login --api-key <key> \| bl auth login --console` |

#### Options

| Flag | Type | Required | Description |
| --- | --- | --- | --- |
| `--api-key <key>` | string | no | DashScope API key to store |
| `--console` | boolean | no | Sign in via browser; opens the console login URL in your default browser |

#### Examples

```bash
bl auth login --api-key sk-xxxxx
```

```bash
bl auth login --console
```

### `bl auth logout`

| Field | Value |
| --- | --- |
| **Name** | `auth logout` |
| **Description** | Clear stored credentials |
| **Usage** | `bl auth logout [--console] [--yes] [--dry-run]` |

#### Options

| Flag | Type | Required | Description |
| --- | --- | --- | --- |
| `--console` | boolean | no | Only clear the console access_token, keep api_key intact |
| `--yes` | boolean | no | Skip confirmation prompt |

#### Examples

```bash
bl auth logout
```

```bash
bl auth logout --console
```

```bash
bl auth logout --dry-run
```

```bash
bl auth logout --yes
```

### `bl auth status`

| Field | Value |
| --- | --- |
| **Name** | `auth status` |
| **Description** | Show current authentication state |
| **Usage** | `bl auth status` |

#### Options

_No command-specific options._

#### Examples

```bash
bl auth status
```

```bash
bl auth status --output json
```
