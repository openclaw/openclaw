---
summary: "Reduce extension exposure by tightening default enablement and allowlist rules"
title: "Task 04: Extension Enable Defaults and Allowlist Hardening"
---

## Objective

Ensure extension loading is least-privilege by default and controlled through explicit allowlists.

## Scope

- Extension discovery, install, and runtime enablement logic.
- Config defaults for new installs and upgrades.
- Operator UX for managing allowlists.

## Task Checklist

- [ ] Change defaults so unapproved extensions are not auto-enabled.
- [ ] Require explicit allowlist entries for extension activation.
- [ ] Validate extension identity/source before enablement.
- [ ] Add clear status output that shows enabled vs blocked extensions.
- [ ] Define upgrade behavior that preserves safety without silently broadening trust.
- [ ] Update docs with secure default guidance and migration steps.

## Acceptance Criteria

- Fresh installs start with a restricted extension trust model.
- Non-allowlisted extensions do not activate.
- Operators can intentionally allow specific extensions with clear feedback.

## Verification

- Integration tests covering install, startup, and reload with and without allowlist entries.
- Upgrade test from prior config versions validating safe default transition.
- CLI/status snapshot tests for extension trust visibility.
