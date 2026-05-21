# `bl console` commands

> Auto-generated from `packages/cli/src/commands/catalog.ts`. Do not edit by hand.
> Regenerate: `pnpm --filter bailian-cli run generate:reference` (runs automatically on `build`).

Index: [index.md](index.md)

## Commands in this group

| Command | Description |
| --- | --- |
| `bl console call` | Call a Bailian console API via the CLI gateway |

## Command details

### `bl console call`

| Field | Value |
| --- | --- |
| **Name** | `console call` |
| **Description** | Call a Bailian console API via the CLI gateway |
| **Usage** | `bl console call --api <api> --data <json> [flags]` |

#### Options

| Flag | Type | Required | Description |
| --- | --- | --- | --- |
| `--api <api>` | string | yes | API name (e.g. zeldaEasy.broadscope-bailian.memory-library.getLibraries) |
| `--data <json>` | string | yes | Request data as JSON string |
| `--region <region>` | string | no | API region (default: cn-beijing) |

#### Examples

```bash
bl console call --api zeldaEasy.broadscope-bailian.freeTrial.queryFreeTierQuota --data '{"queryFreeTierQuotaRequest":{"models":["qwen3-max"]}}'
```

```bash
bl console call --api some.api.name --data '{"key":"value"}' --region cn-beijing
```
