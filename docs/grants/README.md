# Grant Applications - ConsentGuard for OpenClaw

This folder contains draft grant narratives for ConsentGuard, a consent-gated authorization layer for OpenClaw.

## Current program status

Checked on February 19, 2026.

| Funder | Program | Draft | Status |
| -------- | --------- | ------- | -------- |
| [AI Safety Fund](https://aisfund.org/funding-opportunities/) | AI Agent Evaluation and Cybersecurity | [AISF draft](/grants/aisf-agent-cybersecurity) | No open opportunities listed; prior rounds closed in January 2025 |
| [UK AI Safety Institute](https://www.aisi.gov.uk/grants) | Systemic AI Safety Fast Grants | [UK AISI draft](/grants/uk-aisi-systemic) | Not currently accepting applications |
| [Foresight Institute](https://foresight.org/ai-safety/) | AI Safety (security and multi-agent) | [Foresight draft](/grants/foresight) | Quarterly deadlines (Mar, Jun, Sep, Dec 31) |
| [NSF](https://www.nsf.gov/funding/opportunities/safe-ose-safety-security-privacy-open-source-ecosystems/nsf24-608/solicitation) | Safe-OSE | [NSF draft](/grants/nsf-safe-ose) | Verify annual cycle before submitting |
| [OpenSSF Alpha-Omega](https://alpha-omega.dev/grants/how-to-apply/) | Critical OSS Security | [OpenSSF draft](/grants/openssf-alpha-omega) | Rolling application intake |
| [TLA+ Foundation](https://foundation.tlapl.us/grants/2024-grant-program/index.html) | Formal verification | [TLA+ draft](/grants/tlaplus-foundation) | Rolling |
| [Horizon Europe](https://eufundingportal.eu/) and [GitHub SOSF](https://resources.github.com/secure-open-source-fund/) | EU and OSS security programs | [Horizon and GitHub draft](/grants/horizon-github) | Program-specific timelines |

## Codebase grounding for all drafts

- Tool invocation over HTTP runs through `POST /tools/invoke` in `src/gateway/tools-invoke-http.ts`, with auth, policy resolution, default HTTP deny list, and then `tool.execute(...)`.
- Node execution runs through `node.invoke` server handlers in `src/gateway/server-methods/nodes.ts` and executes on node hosts in `src/node-host/invoke.ts`.
- Existing hardening already present:
  - Gateway HTTP default deny list (`sessions_spawn`, `sessions_send`, `gateway`, `whatsapp_login`) in `src/security/dangerous-tools.ts`.
  - Exec approval flow (`exec.approval.requested` and `exec.approval.resolve`) in gateway methods and protocol docs.
  - Session scoping supports `main`, `per-peer`, and `per-channel-peer` in routing/session key logic.
- Core tool names to reference in proposals are real OpenClaw tools, for example:
  - `exec`, `read`, `write`, `edit`, `apply_patch`, `browser`, `cron`, `message`, `sessions_spawn`, `sessions_send`, `gateway`, `whatsapp_login`.

## ConsentGuard deployment options

- In-process middleware:
  - Pros: lower latency, simpler rollout, easier single choke point.
  - Cons: weaker process boundary if gateway process is fully compromised.
- Separate service:
  - Pros: stronger isolation and independent lifecycle.
  - Cons: more operational complexity and strict no-bypass enforcement required at every invoke path.
- Practical path:
  - Start in-process at invoke choke points.
  - Add optional out-of-process mode for higher assurance deployments.

## Placeholders to fill before submission

- `[Host organization]`: legal entity that can receive funds for the specific program.
- `[PI and contributors]`: names, roles, affiliations.
- `[Budget]`: personnel, infrastructure, and dissemination.
- `[Timeline]`: milestones that match the target program period.
