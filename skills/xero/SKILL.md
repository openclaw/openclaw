---
name: xero
description: "Xero CLI for accounting: contacts, invoices, quotes, credit notes, payments, bank transactions, items, manual journals, tracking categories, currencies, tax rates, reports, and organisation details."
homepage: https://github.com/XeroAPI/xero-command-line#readme
metadata:
  {
    "openclaw":
      {
        "emoji": "📒",
        "requires": { "bins": ["xero"] },
        "install":
          [
            {
              "id": "node",
              "kind": "node",
              "package": "@xeroapi/xero-command-line",
              "bins": ["xero"],
              "label": "Install official Xero CLI (npm)",
            },
          ],
      },
  }
---

# xero

Use `xero` for the Xero accounting API. The CLI is the official tool from XeroAPI and uses PKCE OAuth — there is no token to wrangle from the agent side. This skill condenses the upstream [SKILL.md](https://github.com/XeroAPI/xero-command-line/blob/main/SKILL.md); follow the rules below before doing anything destructive.

## Auth

Xero auth is browser-based — the agent cannot complete it. If `xero org details` errors with "not logged in" or `unauthorized_client`, tell the user to run `xero login` in their terminal.

```bash
xero org details          # also doubles as "am I logged in?"
xero login                # browser OAuth (user runs this)
xero logout
xero profile list         # one profile per Xero org / OAuth app
xero login -p my-profile  # log in under a named profile
```

Scopes default to a broad read/write set. For read-only or narrower workflows, the user re-runs `xero login --scope "<space-separated scopes>"`. The required scopes (`openid profile email offline_access`) are prepended automatically.

Token storage edge cases (Linux WSL / SSH / headless) — see [token storage](https://github.com/XeroAPI/xero-command-line#token-storage-linux--wsl--ssh) in the upstream README. The short version: prefer fixing the keychain; fall back to `XERO_KEY_STORAGE=file` or `XERO_TOKEN_PASSPHRASE` before `xero login`.

## Identity verification — read this first

Before running **any** command, including read-only ones:

1. Run `xero org details` and show the organisation name to the user.
2. Use `-p <profile>` explicitly when the user named a profile. Do not rely silently on the default.
3. If `XERO_PROFILE`, `XERO_CLIENT_ID`, `XERO_KEY_STORAGE`, `XERO_KEYRING_FILE_BACKUP`, or `XERO_TOKEN_PASSPHRASE` is set, warn the user — they override profile/key behaviour. Check with `echo $XERO_PROFILE $XERO_CLIENT_ID $XERO_KEY_STORAGE`.
4. Never run `xero profile set-default` or switch profiles without explicit user instruction.

## Write safety — read this before creating, updating, or deleting anything

Any command that creates, updates, or deletes data (invoices, contacts, payments, bank transactions, manual journals, credit notes, quotes, items, tracking categories) is a write:

1. Run `xero org details` and show the user which organisation will be affected.
2. Run read commands first (`xero contacts list --search …`, `xero accounts list`, etc.) to verify IDs.
3. Show the user a summary of the write — resource type, key fields, target org — and **wait for explicit approval** ("yes", "go ahead", etc.).
4. Do not proceed on silence or ambiguity. This is a financial system.

These rules apply whether the write uses inline flags or `--file`.

## Global flags

| Flag | Notes |
|---|---|
| `-p, --profile <name>` | Pick a profile (defaults to the default profile) |
| `--client-id <id>` | Inline OAuth client ID override |
| `--toon` | TOON output — most token-efficient, prefer for read/list output the agent will parse |
| `--json` | Raw JSON — use when piping to `jq` or a tool requires it |
| `--csv` | CSV output |

For read commands the agent parses, prefer `--toon`. Use the default table when showing results to the user in chat.

## Find IDs first

Most create/update commands need Xero GUIDs. List first, write second:

```bash
xero contacts list --search "Acme"     # → ContactID
xero accounts list                     # → account codes
xero invoices list                     # → InvoiceID
xero items list                        # → ItemCode
xero tax-rates list                    # → TaxType values (region-specific)
```

## JSON file input

Every create/update accepts `--file <path.json>` instead of inline flags. Use it for anything with more than one line item or anything the user already pasted as JSON. Inputs are validated client-side before the API call.

```bash
xero invoices create --file invoice.json
xero contacts update --file contact-update.json
```

## Commands

### Contacts

```bash
xero contacts list
xero contacts list --search "Acme" --page 2
xero contacts create --name "Acme Corp" --email acme@example.com --phone "+1234567890"
xero contacts create --file contact.json
xero contacts update --contact-id <ID> --name "Acme Corporation" --email new@acme.com
xero contact-groups list
```

### Accounts, currencies, tax rates

```bash
xero accounts list
xero currencies list
xero tax-rates list
```

### Invoices

```bash
xero invoices list
xero invoices list --contact-id <ID>
xero invoices list --invoice-number INV-0001

# Single-line inline
xero invoices create --contact-id <ID> --type ACCREC \
  --description "Consulting" --quantity 10 --unit-amount 150 \
  --account-code 200 --tax-type OUTPUT2

# Multi-line via file
xero invoices create --file invoice.json

# Update a draft (only drafts can be updated)
xero invoices update --invoice-id <ID> --reference "Updated ref"
```

Types: `ACCREC` (sales / accounts receivable), `ACCPAY` (bills / accounts payable).

Example `invoice.json`:

```json
{
  "contactId": "<CONTACT_ID>",
  "type": "ACCREC",
  "date": "2026-06-15",
  "reference": "REF-001",
  "lineItems": [
    {
      "description": "Consulting",
      "quantity": 10,
      "unitAmount": 150,
      "accountCode": "200",
      "taxType": "OUTPUT2"
    }
  ]
}
```

### Quotes

```bash
xero quotes list
xero quotes list --contact-id <ID>
xero quotes create --contact-id <ID> --title "Project Quote" \
  --date 2026-12-30 --description "Web design" --quantity 1 --unit-amount 5000 \
  --account-code 200 --tax-type OUTPUT2
xero quotes create --file quote.json
xero quotes update --file quote-update.json
```

Quote updates: Xero's API requires `contact` and `date` even if the CLI doesn't. Include both if you hit a validation error.

### Credit notes, bank transactions, payments

```bash
xero credit-notes list
xero credit-notes create --contact-id <ID> --description "Refund" \
  --quantity 1 --unit-amount 100 --account-code 200 --tax-type OUTPUT2

xero bank-transactions list --bank-account-id <ID>
xero bank-transactions create --type SPEND --bank-account-id <BANK_ID> \
  --contact-id <CONTACT_ID> --description "Office supplies" \
  --quantity 1 --unit-amount 50 --account-code 429 --tax-type INPUT2

xero payments list --invoice-id <ID>
xero payments create --invoice-id <ID> --account-id <ACCOUNT_ID> --amount 500
```

Bank transaction types: `RECEIVE` (money in), `SPEND` (money out).

### Manual journals

Need ≥2 lines (debit + credit). Always use `--file`.

```bash
xero manual-journals list
xero manual-journals create --file journal.json
```

```json
{
  "narration": "Reclassify office supplies",
  "manualJournalLines": [
    { "accountCode": "200", "lineAmount": 100, "description": "Debit" },
    { "accountCode": "400", "lineAmount": -100, "description": "Credit" }
  ]
}
```

### Items, tracking categories

```bash
xero items list
xero items create --code WIDGET --name "Widget" --sale-price 29.99

xero tracking categories list
xero tracking categories create --name "Department"
xero tracking options create --category-id <ID> --names "Sales,Marketing,Engineering"
```

### Organisation

```bash
xero org details
```

### Reports

```bash
xero reports trial-balance --date 2026-12-31
xero reports profit-and-loss --from 2026-01-01 --to 2026-12-31
xero reports profit-and-loss --timeframe QUARTER --periods 4
xero reports balance-sheet --date 2026-12-31
xero reports balance-sheet --timeframe MONTH --periods 12
xero reports aged-receivables --contact-id <ID> --report-date 2026-12-31
xero reports aged-payables --contact-id <ID> --from-date 2026-01-01 --to-date 2026-12-31
```

## Tips

- Only drafts (invoices, quotes, credit notes) can be updated. To change a non-draft, void and reissue — that's a separate confirmation gate.
- Tax types are region-specific. Run `xero tax-rates list` to see what's valid for the active org.
- Account codes are required on line items. Run `xero accounts list` if you don't already have them.
- For multi-line creates, always prefer `--file` over chaining inline flags.

For the authoritative reference (auth corner cases, every flag, full output shapes), follow the homepage link or the upstream [SKILL.md](https://github.com/XeroAPI/xero-command-line/blob/main/SKILL.md).
