# Lead Schema (`~/openclaw-work/realestate/leads.json`)

Leads are stored as a JSON array. Each entry follows this structure:

```jsonc
{
  "id": "uuid-string",
  "name": "John Smith",
  "phone": "555-1234",
  "email": "john@example.com",
  "status": "prospect",           // prospect | active | offer | closed | lost
  "budget": 600000,               // Optional, numeric
  "bedrooms": 3,                  // Optional, desired bedrooms
  "areas": ["Downtown", "Midtown"], // Optional, preferred areas
  "next_followup": "2026-04-10",  // ISO date, null if not set
  "notes": [
    {
      "date": "2026-04-06",
      "text": "Interested in 3BR under $600k, prefers downtown"
    }
  ],
  "created_at": "2026-04-06",
  "updated_at": "2026-04-06"
}
```

## Status Definitions
| Status | Meaning |
|--------|---------|
| `prospect` | First contact made, not yet actively searching |
| `active` | Actively viewing properties |
| `offer` | Offer submitted or under negotiation |
| `closed` | Deal completed |
| `lost` | No longer pursuing |

## Directory Layout
```
~/openclaw-work/realestate/
├── leads.json          # all leads (auto-managed)
└── listings/
    └── 123-main-st_YYYY-MM-DD.md   # generated listing drafts
```
