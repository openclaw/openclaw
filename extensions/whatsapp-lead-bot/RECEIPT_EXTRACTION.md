# Receipt Extraction Feature

## Overview

Automatically extracts data from CFE (Mexican electricity company) receipts when leads send images or PDFs via WhatsApp.

## Status

🚧 **Alpha - Core implementation complete, spawn integration pending**

✅ Completed:

- Database schema (v3→v4 migration)
- ReceiptExtractor service with protections
- MediaHandler integration
- Config schema
- TypeScript compilation

⏳ Pending:

- Implement `spawnSubagent()` using OpenClaw API
- Integration testing with real receipts
- Circuit breaker for extractions

## Architecture

```
Lead sends image → message_received hook
  ↓
MediaHandler validates file type/size
  ↓
ReceiptExtractor checks:
  - Max 3 attempts per lead
  - No pending extraction
  - Valid MIME type (jpg/png/pdf)
  - Size ≤ 5MB
  ↓
Spawn cfe-extractor subagent (Haiku)
  ↓
Extractor reads receipt → saves to DB
  ↓
Solayre agent uses data for accurate quote
```

## Configuration

Add to `openclaw.json`:

```json
{
  "plugins": {
    "entries": {
      "whatsapp-lead-bot": {
        "config": {
          "receiptExtraction": {
            "enabled": false,
            "maxAttemptsPerLead": 3,
            "maxFileSizeMB": 5,
            "timeoutSeconds": 30
          }
        }
      }
    }
  }
}
```

Or via CLI:

```bash
openclaw config set 'plugins.entries.whatsapp-lead-bot.config.receiptExtraction.enabled' true
openclaw gateway restart
```

## Database

New table: `receipt_extractions`

```sql
CREATE TABLE receipt_extractions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id INTEGER NOT NULL,
  status TEXT NOT NULL,          -- 'pending' | 'success' | 'failed'
  spawned_at INTEGER NOT NULL,
  completed_at INTEGER,
  error TEXT,
  file_size INTEGER,
  file_path TEXT,
  FOREIGN KEY (lead_id) REFERENCES leads(id)
);
```

Query attempts:

```bash
sqlite3 ~/.openclaw/workspace-solayre/data/leads.db "
  SELECT
    l.phone_number,
    r.status,
    r.spawned_at,
    r.error
  FROM receipt_extractions r
  JOIN leads l ON l.id = r.lead_id
  ORDER BY r.spawned_at DESC
  LIMIT 10;
"
```

## Protections

1. **Max Attempts:** 3 per lead
   - After 3rd failure → auto-handoff to human agent
2. **File Validation:**
   - Allowed: `image/jpeg`, `image/png`, `application/pdf`
   - Max size: 5MB
3. **Pending Check:**
   - Blocks duplicate spawns if extraction already running
4. **Timeout:**
   - 30 seconds (configurable)
   - Cleanup: `delete` (session removed after completion)

## Testing

### Test 1: Valid Receipt

Send JPG or PDF via WhatsApp to solayre number.

**Expected:**

```
Bot: "Procesando su recibo, un momento..."
(30s later)
Bot: "Perfecto, con base en su recibo de tarifa 1F..."
```

**DB Check:**

```sql
SELECT * FROM receipt_extractions WHERE lead_id = <LEAD_ID>;
-- status: 'success'
-- completed_at: <timestamp>
-- error: NULL
```

### Test 2: Too Large File

Send file >5MB.

**Expected:**

```
Bot: "Thanks for the document! A team member will review it shortly."
```

No extraction record created.

### Test 3: Max Attempts

Send 4 invalid images from same lead.

**Expected:**

- 1st, 2nd, 3rd: Spawn attempts
- 4th: No spawn, handoff triggered

**DB Check:**

```sql
SELECT COUNT(*) FROM receipt_extractions WHERE lead_id = <LEAD_ID>;
-- Result: 3
```

### Test 4: Unsupported Type

Send video or audio file.

**Expected:**

```
Bot: "Thanks for the video! A team member will review it shortly."
```

No extraction attempted.

## Logs

Successful extraction:

```
[lead-bot] Processing message on accountId="solayre" from="+5216672350818"
[media] Receipt extraction allowed for lead 42
[receipt-extractor] Spawned extractor for lead 42, session: agent:cfe-extractor:...
[cfe-extractor] ✅ Recibo procesado para lead 42
```

Failed extraction:

```
[receipt-extractor] Spawned extractor for lead 42
[cfe-extractor] ❌ Error: Imagen ilegible
[lead-bot] Receipt extraction failed for lead 42: timeout
```

Max attempts exceeded:

```
[receipt-extractor] Max attempts exceeded for lead 42
[lead-bot] 🤝 Handoff triggered for lead 42 - extraction_failed
```

## Rollback

If issues occur:

```bash
# Disable feature
openclaw config set 'plugins.entries.whatsapp-lead-bot.config.receiptExtraction.enabled' false
openclaw gateway restart
```

MediaHandler falls back to generic message → no functionality break.

## TODO

### High Priority

- [ ] Implement `spawnSubagent()` using OpenClaw API
- [ ] Integration test with real CFE receipt
- [ ] Validate save-receipt-data.mjs execution

### Medium Priority

- [ ] Circuit breaker for extraction failures
- [ ] Debounce (if lead sends multiple images rapidly)
- [ ] Metrics dashboard (success rate, avg duration)

### Low Priority

- [ ] Cleanup old extraction records (>30 days)
- [ ] Retry failed extractions (1 retry with backoff)
- [ ] Support for commercial tariffs (GDBT extraction)

## Cost Analysis

Per extraction:

- Model: Haiku (~1,500 tokens)
- Cost: ~$0.0003
- vs Sonnet: ~$0.003 (10× more expensive)

At scale (100 extractions/day):

- Haiku: $0.03/day = $9/month
- Sonnet: $0.30/day = $90/month

**Savings: $81/month using Haiku**

## Support

Issues or questions: Check logs in `~/.openclaw/logs/gateway.log`

Debug extraction:

```bash
# Check last 5 extractions
sqlite3 ~/.openclaw/workspace-solayre/data/leads.db "
  SELECT id, lead_id, status, error, spawned_at
  FROM receipt_extractions
  ORDER BY spawned_at DESC
  LIMIT 5;
"

# Check pending extractions
sqlite3 ~/.openclaw/workspace-solayre/data/leads.db "
  SELECT * FROM receipt_extractions WHERE status = 'pending';
"
```
