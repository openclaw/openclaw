---
summary: "Database-first state, schema version contracts, guarded updates, release channels, and the maturity scorecard"
title: "Versioned state, guarded upgrades"
read_when:
  - You need to know whether an OpenClaw upgrade can break your on-disk state
  - You are choosing between the stable, extended-stable, beta, and dev channels
  - You are assessing per-surface readiness before deploying
---

Runtime state is database-first: one global SQLite store, one per agent, with a written contract that runtime code never reads or writes JSON sidecars as active state. The contract is machine-checked in CI ([database schemas](/reference/database-schemas)). Schemas carry a two-place version contract; a build refuses to open a database newer than itself. [`openclaw update`](/cli/update) refuses targets whose declared schema support is older than your on-disk databases; legacy target packages without schema metadata cannot be preflighted. [`openclaw doctor --fix`](/cli/doctor) is the single owner of file-to-SQLite migrations and records a receipt for each one. SQLite snapshots in [backups](/cli/backup) use SQLite's online-backup API and are integrity- and hash-checked during creation and publication. Whole-archive verification does not bind ordinary file payloads to content hashes; restore never happens in place. [Restart recovery](/gateway/restart-recovery) resumes interrupted turns under a bounded attempt budget, and a crash-loop breaker keeps the control plane reachable while suppressing channel autostart.

Releases come through four channels (stable, extended-stable, beta, dev) on calendar versions with immutable npm publishes ([development channels](/install/development-channels), [release process](/reference/RELEASING)). Extended-stable is the conservative track and it fails closed: the updater re-fetches and verifies the exact selected package, and missing or inconsistent registry data is an error, never a fallback to `latest`. The [Full Release Validation](/reference/full-release-validation) workflow seals an immutable execution-plan artifact covering cross-OS installs and upgrades, package acceptance, live channel lanes, and performance gates. Publishing is serialized and provenance-verified (Sigstore attestations, npm provenance) under the OpenClaw Foundation identity.

Per-surface readiness is published. The [maturity scorecard](/maturity/scorecard) grades 50 surfaces across [280 capability areas](/maturity/taxonomy) from deterministic QA evidence plus reviewed quality scores, with long-term-support status on every row. Extended-stable answers how long a surface is supported; the scorecard answers how proven it is.
