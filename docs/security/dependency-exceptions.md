# Dependency Exception Register

This register documents time-bounded dependency exceptions used for security scanner triage (including Red Hat and enterprise CVE reporting workflows).

## Active exceptions

### DER-2026-02-16-001 - Matrix transitive `request` lineage

- Status: active
- Opened: 2026-02-16
- Last reviewed: 2026-02-16
- Next review due: 2026-05-16
- Scope: `extensions/matrix` only
- Dependency path:
  - `@openclaw/matrix`
  - `@vector-im/matrix-bot-sdk@0.8.0-element.3`
  - `request-promise@4.2.6`
  - `request` lineage
- Advisory context:
  - `CVE-2023-28155`
  - `GHSA-p8p7-x288-28g6`

#### Why this exception exists

`@vector-im/matrix-bot-sdk` (latest available as of 2026-02-16) still depends on `request`/`request-promise` lineage, and there is no upstream release that removes this chain.

#### Mitigation in place

- Root `pnpm.overrides` maps:
  - `"request": "npm:@cypress/request@^3.0.4"`
- Lockfile resolves Matrix transitive `request` references to `@cypress/request`.
- `pnpm audit` reports zero vulnerabilities after this override.

#### Residual risk

- Upstream still includes deprecated `request-promise`, which causes peer warnings.
- This is tracked as technical debt pending an upstream Matrix SDK update that removes `request-promise`.

#### Verification commands

Run from repo root:

```bash
npx pnpm audit --json
npx pnpm why @cypress/request
```

Inspect lockfile resolution:

```bash
rg -n "@cypress/request|request-promise" pnpm-lock.yaml
```

#### Scanner mapping (Trivy / Grype)

Use this exception ID in scanner triage notes:

- `DER-2026-02-16-001`

Typical mappings:

- Trivy finding key:
  - `CVE-2023-28155` on `request` lineage in Matrix dependency path.
- Grype finding key:
  - `GHSA-p8p7-x288-28g6` / `CVE-2023-28155`.

Recommended policy:

- Allowlist only this finding when the package path is under Matrix plugin lineage.
- Require periodic revalidation via this register's review date.

#### Exit criteria

- `@vector-im/matrix-bot-sdk` (or replacement SDK) no longer depends on `request-promise` lineage.
- Remove override and re-run full security scan.
