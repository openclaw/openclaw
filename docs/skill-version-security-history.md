# Skill Version Security History

## Purpose

Each skill version should keep a clear security history so you can answer:

- what exact bundle was reviewed?
- when was it scanned?
- by which provider?
- what verdict was returned?
- did the verdict change later?
- who published it?

## History Model

Per version, store:

- `packageHashSha256`
- `metadata`
- `publisher`
- `scans[]`
- `latestVerdict`
- `latestPolicyAction`
- `firstScannedAt`
- `lastScannedAt`
- `lastRescannedAt`
- `externalReportUrl`

## Scan History

Each scan entry should preserve:

- provider
- scan status
- verdict
- confidence
- findings
- report URL
- timestamps

Do not overwrite prior scans blindly. Append and update the version's latest fields.

## Audit Trail

Audit entries should record:

- package creation
- initial scan
- re-scan
- verdict changes
- downgrade warnings
- policy decisions

## Why This Matters

Without version security history:

- trust decisions are opaque
- rescans lose meaning
- provider disagreements are hard to explain
- incident response becomes guesswork
