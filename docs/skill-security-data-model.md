# Skill Security Data Model

## Core Entities

### Skill Package Metadata

Represents the deterministic bundle manifest embedded in `_meta.json`.

Fields:

- `formatVersion`
- `skillName`
- `version`
- `publisher`
- `createdAt`
- `sourceFiles`
- `packageHashSha256`
- `packaging.ordering`
- `packaging.compression`
- `packaging.timestamp`

### Package Version Record

Represents one published or stored skill bundle version.

Fields:

- `version`
- `active`
- `bundlePath`
- `metadata`
- `packageHashSha256`
- `publisher`
- `scans[]`
- `latestVerdict`
- `latestPolicyAction`
- `firstScannedAt`
- `lastScannedAt`
- `lastRescannedAt`
- `externalReportUrl`

### Scan Record

Represents one scanner result for a bundle hash.

Fields:

- `provider`
- `scanId`
- `status`
- `verdict`
- `confidence`
- `packageHashSha256`
- `scannedAt`
- `lastRescannedAt`
- `reportUrl`
- `findings[]`
- `summary`
- `raw`

### Publisher Metadata

Fields:

- `publisherId`
- `displayName`
- `contact`
- `url`
- `trustLevel`

### Audit Entry

Fields:

- `ts`
- `actor`
- `skillName`
- `version`
- `packageHashSha256`
- `event`
- `detail`

## Store Shape

The local store is versioned and append-friendly:

```json
{
  "version": 1,
  "packages": [],
  "auditTrail": []
}
```

## Type Definitions

Code definitions live in:

- `src/security/skill-security-types.ts`
- `src/security/skill-security-store.ts`

These types are intended to stay stable enough for later API exposure and UI rendering.
