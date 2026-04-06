# Dedupe + ledger for bulk texting

## Why

Bulk sends must be idempotent. If a process restarts or is re-run, recipients must not get duplicates.

## Required artifacts

- **Queue file**: deterministic list of recipients for this campaign
  - deduped by normalized phone before any send begins
  - fields: phoneDigits, phoneRaw, firstName, messageVariantId, messageText
- **Sent ledger** (append-only JSONL or CSV)
  - key: campaignId + phoneDigits
  - fields: ts, campaignId, phoneDigits, phoneRaw, status, error
- **Delay window config**
  - e.g. `delayMinSec=20`, `delayMaxSec=50`

## Algorithm

1. Generate queue from source list and dedupe by normalized phone.
2. Load ledger and build `alreadySent` set for the current `campaignId` where status=="sent".
3. Iterate queue in order:
   - if phoneDigits in alreadySent: append ledger row with `skipped-already-sent`, then skip
   - append ledger row with `queued`
   - attempt send
   - append ledger row with status `sent` or `failed`
   - sleep a randomized duration inside the configured delay window before the next send

## Failure handling

- Track consecutive failures.
- If N consecutive failures (configurable):
  - sleep 10 minutes
  - retry one failed
  - widen delay window
  - continue

## Notes

- Do not rely on AppleScript exit code as delivery confirmation; it only indicates Messages accepted the command.
- Ledger is the only durable truth for dedupe.
