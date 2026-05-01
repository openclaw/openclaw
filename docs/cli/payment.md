---
summary: "CLI reference for `openclaw payment` (setup, funding, virtual-card, execute, status)"
title: "payment"
read_when:
  - You want to check payment provider setup from the terminal
  - You want to issue a virtual card or execute a machine payment from a script
  - You want to understand which subcommands require --yes and what happens without it
---

# `openclaw payment`

Manage the OpenClaw payment plugin from the terminal. Subcommands cover provider setup, funding source listing, virtual card issuance, machine payment execution, and handle status lookup.

Related:

- User-facing plugin doc: [Payment plugin](/plugins/payment)

## Common flags

- `--provider <id>`: Provider id (`stripe-link` | `mock`). Optional on read-only subcommands; required on live-action subcommands.
- `--json`: Emit machine-readable JSON to stdout instead of human-readable text.

## Dry-run behavior

`virtual-card issue` and `execute` are live-action subcommands that move money. Both default to **dry-run**: they print a summary of what would happen and exit without contacting any provider. Pass `--yes` to actually execute the action.

Read-only subcommands (`setup`, `funding list`, `status`) have no `--yes` gate.

---

## `openclaw payment setup`

Check whether the configured payment provider is ready for use.

**Synopsis:**

```bash
openclaw payment setup [--provider <id>] [--json]
```

**Options:**

| Flag              | Description                                                                              |
| ----------------- | ---------------------------------------------------------------------------------------- |
| `--provider <id>` | Provider to check (`stripe-link` \| `mock`). Defaults to the configured provider.        |
| `--json`          | Emit JSON: `{ status: { available, reason?, authState?, providerVersion?, testMode? } }` |

**Behavior:**

Calls the provider's setup check and reports:

- `Available`: whether the provider is ready.
- `Auth state`: authentication status (relevant for `stripe-link`).
- `Version`: provider binary version when available.
- `Test mode`: whether the provider is running in test/sandbox mode.

**Example:**

```bash
openclaw payment setup --provider stripe-link
# Provider: stripe-link
# Available: true
# Auth state: authenticated
# Version: 1.2.3
# Test mode: false

openclaw payment setup --json
# { "status": { "available": true, "authState": "authenticated", "testMode": false } }
```

---

## `openclaw payment funding list`

List available funding sources for the configured provider.

**Synopsis:**

```bash
openclaw payment funding list [--provider <id>] [--json]
```

**Options:**

| Flag              | Description                                                 |
| ----------------- | ----------------------------------------------------------- |
| `--provider <id>` | Provider to list from. Defaults to the configured provider. |
| `--json`          | Emit JSON: `{ sources: FundingSource[] }`                   |

**Behavior:**

Returns each funding source with its `id`, `displayName`, supported rails (`virtual_card`, `machine_payment`), and currency. Use a `fundingSourceId` from this list when calling `virtual-card issue` or `execute`.

**Example:**

```bash
openclaw payment funding list
# fs_abc123  Personal Visa  [virtual_card, machine_payment]  USD

openclaw payment funding list --json
# {
#   "sources": [
#     {
#       "id": "fs_abc123",
#       "displayName": "Personal Visa",
#       "rails": ["virtual_card", "machine_payment"],
#       "settlementAssets": ["usd_card"],
#       "currency": "usd"
#     }
#   ]
# }
```

---

## `openclaw payment virtual-card issue`

Issue a single-use virtual card for browser-based checkout.

**Synopsis:**

```bash
openclaw payment virtual-card issue \
  --provider <id> \
  --funding-source <fs-id> \
  --amount <cents> \
  --currency <cur> \
  --merchant-name <name> \
  --purchase-intent <text> \
  [--merchant-url <url>] \
  [--idempotency-key <key>] \
  [--yes] \
  [--json]
```

**Options:**

| Flag                       | Required | Description                                                               |
| -------------------------- | -------- | ------------------------------------------------------------------------- |
| `--provider <id>`          | yes      | Provider id (`stripe-link` \| `mock`).                                    |
| `--funding-source <fs-id>` | yes      | Funding source id from `funding list`.                                    |
| `--amount <cents>`         | yes      | Amount in cents (integer >= 1, <= 50000 for `stripe-link`).               |
| `--currency <cur>`         | yes      | ISO 4217 currency code, e.g. `usd`.                                       |
| `--merchant-name <name>`   | yes      | Merchant name shown in the approval prompt.                               |
| `--purchase-intent <text>` | yes      | Description of the purchase (>= 100 characters).                          |
| `--merchant-url <url>`     | no       | Merchant URL shown in the approval prompt.                                |
| `--idempotency-key <key>`  | no       | Deduplication key for safe retries.                                       |
| `--yes`                    | no       | Confirm and proceed with live issuance. Required to contact the provider. |
| `--json`                   | no       | Emit JSON output.                                                         |

**Without `--yes` (dry run):**

Prints a summary of the would-be request and exits 0. No provider call is made.

```bash
openclaw payment virtual-card issue \
  --provider stripe-link \
  --funding-source fs_abc123 \
  --amount 2999 \
  --currency usd \
  --merchant-name "Example Store" \
  --purchase-intent "Purchasing a blue widget SKU W-123 from example.com for $29.99 as part of the user's home office order."

# [DRY RUN] Would issue virtual card:
#   Provider:       stripe-link
#   Funding source: fs_abc123
#   Amount:         2999 cents (USD)
#   Merchant:       Example Store
#
# Run with --yes to proceed with actual issuance.
```

**With `--yes` (live issuance):**

Issues the card through the provider. For `stripe-link`, this triggers a biometric approval prompt (Face ID or passkey) on your registered Link mobile app. The command blocks until approval resolves.

```bash
openclaw payment virtual-card issue \
  --provider stripe-link \
  --funding-source fs_abc123 \
  --amount 2999 \
  --currency usd \
  --merchant-name "Example Store" \
  --purchase-intent "Purchasing a blue widget SKU W-123 from example.com for $29.99 as part of the user's home office order." \
  --yes

# Issued virtual card: hdl_...
# Status: approved
# Card: ...4242
# Valid until: 2026-04-30T14:00:00Z
```

**Notes:**

- `--purchase-intent` must be at least 100 characters. Shorter values cause a validation error before any provider call.
- The amount is validated to be a positive integer. Non-integer or negative values exit with an error.
- For `stripe-link`, `maxAmountCents` is hard-capped at 50000. Requests above this fail at the config schema level.
- The CLI does not return `fillSentinels` — those are only meaningful in agent context where the `before_tool_call` hook can act on them. Use the agent tool (`payment.issue_virtual_card`) for browser checkout flows.

---

## `openclaw payment execute`

Execute a machine-to-machine payment to an HTTP 402 endpoint.

**Synopsis:**

```bash
openclaw payment execute \
  --provider <id> \
  --funding-source <fs-id> \
  --target-url <url> \
  --method <verb> \
  [--data <json>] \
  [--idempotency-key <key>] \
  [--yes] \
  [--json]
```

**Options:**

| Flag                       | Required | Description                                                                |
| -------------------------- | -------- | -------------------------------------------------------------------------- |
| `--provider <id>`          | yes      | Provider id (`stripe-link` \| `mock`).                                     |
| `--funding-source <fs-id>` | yes      | Funding source id from `funding list`.                                     |
| `--target-url <url>`       | yes      | Target payment API URL (must accept HTTP 402 + MPP).                       |
| `--method <verb>`          | yes      | HTTP method: `GET`, `POST`, `PUT`, `PATCH`, or `DELETE`.                   |
| `--data <json>`            | no       | JSON body for the request. Validated before the dry-run / `--yes` branch.  |
| `--idempotency-key <key>`  | no       | Deduplication key.                                                         |
| `--yes`                    | no       | Confirm and proceed with live execution. Required to contact the provider. |
| `--json`                   | no       | Emit JSON output.                                                          |

**Without `--yes` (dry run):**

Prints a summary and exits 0. No provider call is made. Malformed `--data` JSON is caught and reported even in dry-run mode.

```bash
openclaw payment execute \
  --provider stripe-link \
  --funding-source fs_abc123 \
  --target-url https://api.example.com/purchase \
  --method POST \
  --data '{"item":"widget-123"}'

# [DRY RUN] Would execute machine payment:
#   Provider:       stripe-link
#   Funding source: fs_abc123
#   Target URL:     https://api.example.com/purchase
#   Method:         POST
#   Body:           {"item":"widget-123"}
#
# Run with --yes to proceed with actual execution.
```

**With `--yes` (live execution):**

Executes the payment. This is **irreversible** once settled. For `stripe-link`, a spend request token (SPT) is issued and consumed by the MPP adapter.

```bash
openclaw payment execute \
  --provider stripe-link \
  --funding-source fs_abc123 \
  --target-url https://api.example.com/purchase \
  --method POST \
  --yes

# Machine payment: hdl_...
# Outcome: settled
# Status code: 200
```

**Notes:**

- `--method` is case-insensitive; `post` and `POST` are both accepted.
- `--data` must be valid JSON. Invalid JSON exits immediately with an error, before `--yes` is evaluated.
- Machine payments are not retried automatically. If `outcome` is `failed`, issue a new payment (check idempotency key usage to avoid double-charges).

---

## `openclaw payment status`

Look up the status of a handle issued by `virtual-card issue` or the agent tool.

**Synopsis:**

```bash
openclaw payment status --handle-id <id> [--json]
```

**Options:**

| Flag               | Required | Description                                                                 |
| ------------------ | -------- | --------------------------------------------------------------------------- |
| `--handle-id <id>` | yes      | Handle id returned by `virtual-card issue` or `payment.issue_virtual_card`. |
| `--json`           | no       | Emit JSON: `{ handle: CredentialHandle }`                                   |

**Behavior:**

Returns the current handle status. Sensitive fields (PAN, CVV, expiry digits in raw form) are never included.

```bash
openclaw payment status --handle-id hdl_...

# Handle: hdl_...
# Status: approved
# Card: ...4242
# Valid until: 2026-04-30T14:00:00Z

openclaw payment status --handle-id hdl_... --json
# {
#   "handle": {
#     "id": "hdl_...",
#     "status": "approved",
#     "display": { "brand": "Visa", "last4": "4242" },
#     "validUntil": "2026-04-30T14:00:00Z"
#   }
# }
```

**Handle statuses:**

| Status             | Meaning                                                 |
| ------------------ | ------------------------------------------------------- |
| `pending_approval` | Spend request submitted; awaiting phone approval.       |
| `approved`         | Card is ready for use.                                  |
| `denied`           | Approval was denied (OpenClaw gate or Link mobile app). |
| `expired`          | `validUntil` has passed or the card was consumed.       |

---

## Related

- [Payment plugin](/plugins/payment)
- [CLI reference](/cli)
