---
title: "SLOs and Ownership"
summary: "Availability targets, severity levels, rollback windows, and the on-call / release / security ownership model"
read_when:
  - Defining or reviewing production availability targets
  - Understanding on-call or release ownership
  - Triaging an incident and need severity classification
---

# SLOs and Ownership

## Production bar

OpenClaw is a personal AI assistant — self-hosted by individuals and small teams.
The production bar reflects that reality: high reliability for the owner's daily use,
fast turnaround on security fixes, and a low blast radius for any single failure.

---

## Availability targets (SLOs)

| Component | Target | Measurement window | Notes |
|---|---|---|---|
| Gateway process | 99.5 % uptime | Rolling 30 days | Measured by supervisor heartbeat or systemd/launchd unit restart count |
| Channel ingestion (WhatsApp/Telegram/etc.) | Best-effort | Per-channel health monitor | `gateway.channelHealthCheckMinutes` default 5 min; see [Health Checks](../gateway/health.md) |
| Agent response latency | p95 < 15 s | Per-session | Depends on model provider; local models excluded |
| Release publish (stable) | ≤ 48 h after beta validation | Per-release cycle | Beta must be green before stable promotes |
| Security patch (critical) | ≤ 48 h | From confirmed report | See [Vulnerability SLA](./vulnerability-sla.md) |

> These targets apply to the shipping product, not to individual user deployments.
> Users can tune `gateway.channelHealthCheckMinutes`, `gateway.channelStaleEventThresholdMinutes`,
> and `gateway.channelMaxRestartsPerHour` to match their own bar.

---

## Severity levels

Use these classifications consistently in incidents, postmortems, and security reports.

| Severity | Definition | Target response | Target resolution |
|---|---|---|---|
| **S1 – Critical** | Complete service loss, active exploit, release supply-chain compromise, OpenClaw-owned credential exposure | ≤ 1 h acknowledgment | ≤ 24 h |
| **S2 – High** | Major feature broken for most users, verified trust-boundary bypass, release blocking regression | ≤ 4 h acknowledgment | ≤ 48 h |
| **S3 – Medium** | Significant degradation affecting a subset of users or channels, security hardening gap with practical impact | ≤ 24 h acknowledgment | ≤ 7 days |
| **S4 – Low** | Minor defect, cosmetic issue, defense-in-depth hardening, documentation gap | ≤ 48 h acknowledgment | Next scheduled release |

---

## Rollback targets

| Scenario | Target rollback time | Method |
|---|---|---|
| Bad npm publish | ≤ 30 min | `npm dist-tag add openclaw@<prev> latest` (release managers only) |
| Bad Docker image | ≤ 30 min | Re-tag previous SHA in registry, redeploy |
| Bad macOS app build | ≤ 2 h | Re-publish previous Sparkle appcast entry |
| Gateway config regression | ≤ 5 min | `openclaw doctor --repair` or manual config edit on host |

---

## Ownership model

Ownership is explicit and documented here. Every surface must have exactly one named owner team.

### On-call owner

The on-call owner is responsible for:

- Acknowledging incidents within the target response window above
- Triaging, escalating, or resolving S1/S2 issues
- Posting status updates in GitHub Discussions or the Discord `#incidents` channel
- Initiating a postmortem for S1/S2 incidents (see [Postmortem Template](./postmortem-template.md))

**Current rotation:** Maintained by core maintainers. For the active on-call contact,
see the private maintainer docs at `openclaw/maintainers`.

### Release owner

The release owner is responsible for:

- Driving each release through the beta → stable pipeline
- Running `pnpm release:check` preflight before every tag
- Approving the npm publish workflow dispatch
- Verifying the post-publish smoke (`openclaw-npm-postpublish-verify`)
- Updating `CHANGELOG.md` entries and tagging

**Owner team:** `@openclaw/openclaw-release-managers`
(see `.github/CODEOWNERS`)

### Security owner

The security owner is responsible for:

- Triaging all incoming `SECURITY.md` vulnerability reports
- Maintaining the GHSA advisory pipeline (use the `$openclaw-ghsa-maintainer` skill)
- Reviewing changes to security-sensitive surfaces (see `.github/CODEOWNERS` secops entries)
- Driving the [Vulnerability SLA](./vulnerability-sla.md) compliance

**Owner team:** `@openclaw/secops`
**Security contact:** security@openclaw.ai
**Trust and Security lead:** Jamieson O'Reilly (@theonejvo)

---

## Ownership matrix (surface → team)

| Surface | Owner |
|---|---|
| Core CLI + Gateway | Core maintainers |
| macOS app | @tyler6204, @ngutman, @nimrod |
| iOS app | @mbelinky, @ngutman |
| Android app | @obviyus |
| Discord channel + Clawhub | @thewilloftheshadow |
| Telegram channel | @joshp123, @obviyus |
| Slack channel | Core maintainers |
| Signal channel | Core maintainers |
| Security and secrets surfaces | @openclaw/secops |
| Releases and npm publish | @openclaw/openclaw-release-managers |
| Docs and Control UI | @BunsDev, @velvet-shark |
| Plugin SDK contract | Core maintainers |

---

## CI gate policy (Phase 1 enforcement)

The following gates must be green before any commit lands on `main`:

1. `check` — lint, format, type-check, import-cycles
2. `test-shard-*` — unit + integration test shards
3. `check-additional` — architecture boundary and policy guards (runs in CI only)
4. `build-smoke` — full production build + plugin SDK dts
5. `CodeQL` — scheduled security scan (see `.github/workflows/codeql.yml`);
   should be triggered on push/PR in addition to manual dispatch once secops approves the trigger change
6. `install-smoke` — end-to-end install verification

**Branch protection requirements (configure in GitHub → Settings → Branches → `main`):**

- Require a pull request before merging
- Require approvals: minimum 1 (2 recommended for security or release paths)
- Require status checks to pass: `check`, `test-shard-*`, `build-smoke`, `install-smoke`
- Require branches to be up to date before merging
- Do not allow bypassing the above settings for administrators
- Restrict who can push to `main`: release managers and core maintainers only
