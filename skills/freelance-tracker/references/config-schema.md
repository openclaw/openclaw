# Client Config Schema (`~/openclaw-work/freelance/clients/<client>/config.json`)

```jsonc
{
  "client": "acme-corp", // Folder slug, kebab-case
  "name": "Acme Corporation", // Display name used in invoices
  "email": "billing@acme.com", // Where to send invoices
  "rate": 100, // Hourly rate (number)
  "currency": "USD", // Optional, default USD
  "payment_terms": "Net 30", // Optional, shown on invoice
  "your_name": "Jane Doe", // Your name on the invoice
  "your_email": "jane@example.com", // Your contact email
}
```

## Field Notes

- **client**: Hyphenated slug matching the folder name.
- **rate**: Hourly rate as a plain number. Applied to all log entries unless overridden per project (not yet supported).
- **currency**: Shown on invoice header and totals. Default: `USD`.
- **payment_terms**: e.g. `Net 15`, `Net 30`, `Due on receipt`. Default: `Due on receipt`.

## Directory Layout

```
~/openclaw-work/freelance/
├── clients/
│   └── <client>/
│       ├── config.json   # client metadata + rate
│       └── log.json      # time entries (auto-managed)
└── out/
    └── <client>/
        └── invoice_YYYY-MM-DD.md   # generated invoices
```
