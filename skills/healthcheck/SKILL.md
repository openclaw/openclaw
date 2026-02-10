---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
name: healthcheck（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
description: Host security hardening and risk-tolerance configuration for OpenClaw deployments. Use when a user asks for security audits, firewall/SSH/update hardening, risk posture, exposure review, OpenClaw cron scheduling for periodic checks, or version status checks on a machine running OpenClaw (laptop, workstation, Pi, VPS).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# OpenClaw Host Hardening（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Overview（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Assess and harden the host running OpenClaw, then align it to a user-defined risk tolerance without breaking access. Use OpenClaw security tooling as a first-class signal, but treat OS hardening as a separate, explicit set of steps.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Core rules（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Recommend running this skill with a state-of-the-art model (e.g., Opus 4.5, GPT 5.2+). The agent should self-check the current model and suggest switching if below that level; do not block execution.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Require explicit approval before any state-changing action.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Do not modify remote access settings without confirming how the user connects.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Prefer reversible, staged changes with a rollback plan.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Never claim OpenClaw changes the host firewall, SSH, or OS updates; it does not.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If role/identity is unknown, provide recommendations only.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Formatting: every set of user choices must be numbered so the user can reply with a single digit.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- System-level backups are recommended; try to verify status.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Workflow (follow in order)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 0) Model self-check (non-blocking)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Before starting, check the current model. If it is below state-of-the-art (e.g., Opus 4.5, GPT 5.2+), recommend switching. Do not block execution.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 1) Establish context (read-only)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Try to infer 1–5 from the environment before asking. Prefer simple, non-technical questions if you need confirmation.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Determine (in order):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. OS and version (Linux/macOS/Windows), container vs host.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Privilege level (root/admin vs user).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. Access path (local console, SSH, RDP, tailnet).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. Network exposure (public IP, reverse proxy, tunnel).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
5. OpenClaw gateway status and bind address.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
6. Backup system and status (e.g., Time Machine, system images, snapshots).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
7. Deployment context (local mac app, headless gateway host, remote gateway, container/CI).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
8. Disk encryption status (FileVault/LUKS/BitLocker).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
9. OS automatic security updates status.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   Note: these are not blocking items, but are highly recommended, especially if OpenClaw can access sensitive data.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
10. Usage mode for a personal assistant with full access (local workstation vs headless/remote vs other).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
First ask once for permission to run read-only checks. If granted, run them by default and only ask questions for items you cannot infer or verify. Do not ask for information already visible in runtime or command output. Keep the permission ask as a single sentence, and list follow-up info needed as an unordered list (not numbered) unless you are presenting selectable choices.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If you must ask, use non-technical prompts:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- “Are you using a Mac, Windows PC, or Linux?”（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- “Are you logged in directly on the machine, or connecting from another computer?”（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- “Is this machine reachable from the public internet, or only on your home/network?”（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- “Do you have backups enabled (e.g., Time Machine), and are they current?”（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- “Is disk encryption turned on (FileVault/BitLocker/LUKS)?”（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- “Are automatic security updates enabled?”（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- “How do you use this machine?”（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  Examples:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Personal machine shared with the assistant（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Dedicated local machine for the assistant（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Dedicated remote machine/server accessed remotely (always on)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Something else?（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Only ask for the risk profile after system context is known.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If the user grants read-only permission, run the OS-appropriate checks by default. If not, offer them (numbered). Examples:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. OS: `uname -a`, `sw_vers`, `cat /etc/os-release`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Listening ports:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - Linux: `ss -ltnup` (or `ss -ltnp` if `-u` unsupported).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - macOS: `lsof -nP -iTCP -sTCP:LISTEN`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. Firewall status:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - Linux: `ufw status`, `firewall-cmd --state`, `nft list ruleset` (pick what is installed).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - macOS: `/usr/libexec/ApplicationFirewall/socketfilterfw --getglobalstate` and `pfctl -s info`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. Backups (macOS): `tmutil status` (if Time Machine is used).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 2) Run OpenClaw security audits (read-only)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
As part of the default read-only checks, run `openclaw security audit --deep`. Only offer alternatives if the user requests them:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. `openclaw security audit` (faster, non-probing)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. `openclaw security audit --json` (structured output)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Offer to apply OpenClaw safe defaults (numbered):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. `openclaw security audit --fix`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Be explicit that `--fix` only tightens OpenClaw defaults and file permissions. It does not change host firewall, SSH, or OS update policies.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If browser control is enabled, recommend that 2FA be enabled on all important accounts, with hardware keys preferred and SMS not sufficient.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 3) Check OpenClaw version/update status (read-only)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
As part of the default read-only checks, run `openclaw update status`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Report the current channel and whether an update is available.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 4) Determine risk tolerance (after system context)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Ask the user to pick or confirm a risk posture and any required open services/ports (numbered choices below).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Do not pigeonhole into fixed profiles; if the user prefers, capture requirements instead of choosing a profile.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Offer suggested profiles as optional defaults (numbered). Note that most users pick Home/Workstation Balanced:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Home/Workstation Balanced (most common): firewall on with reasonable defaults, remote access restricted to LAN or tailnet.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. VPS Hardened: deny-by-default inbound firewall, minimal open ports, key-only SSH, no root login, automatic security updates.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. Developer Convenience: more local services allowed, explicit exposure warnings, still audited.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. Custom: user-defined constraints (services, exposure, update cadence, access methods).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 5) Produce a remediation plan（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Provide a plan that includes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Target profile（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Current posture summary（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Gaps vs target（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Step-by-step remediation with exact commands（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Access-preservation strategy and rollback（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Risks and potential lockout scenarios（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Least-privilege notes (e.g., avoid admin usage, tighten ownership/permissions where safe)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Credential hygiene notes (location of OpenClaw creds, prefer disk encryption)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Always show the plan before any changes.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 6) Offer execution options（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Offer one of these choices (numbered so users can reply with a single digit):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Do it for me (guided, step-by-step approvals)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Show plan only（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. Fix only critical issues（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. Export commands for later（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 7) Execute with confirmations（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
For each step:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Show the exact command（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Explain impact and rollback（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Confirm access will remain available（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Stop on unexpected output and ask for guidance（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 8) Verify and report（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Re-check:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Firewall status（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Listening ports（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Remote access still works（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- OpenClaw security audit (re-run)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Deliver a final posture report and note any deferred items.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Required confirmations (always)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Require explicit approval for:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Firewall rule changes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Opening/closing ports（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- SSH/RDP configuration changes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Installing/removing packages（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Enabling/disabling services（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- User/group modifications（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Scheduling tasks or startup persistence（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Update policy changes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Access to sensitive files or credentials（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If unsure, ask.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Periodic checks（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
After OpenClaw install or first hardening pass, run at least one baseline audit and version check:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw security audit`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw security audit --deep`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw update status`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Ongoing monitoring is recommended. Use the OpenClaw cron tool/CLI to schedule periodic audits (Gateway scheduler). Do not create scheduled tasks without explicit approval. Store outputs in a user-approved location and avoid secrets in logs.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
When scheduling headless cron runs, include a note in the output that instructs the user to call `healthcheck` so issues can be fixed.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Required prompt to schedule (always)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
After any audit or hardening pass, explicitly offer scheduling and require a direct response. Use a short prompt like (numbered):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. “Do you want me to schedule periodic audits (e.g., daily/weekly) via `openclaw cron add`?”（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If the user says yes, ask for:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- cadence (daily/weekly), preferred time window, and output location（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- whether to also schedule `openclaw update status`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use a stable cron job name so updates are deterministic. Prefer exact names:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `healthcheck:security-audit`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `healthcheck:update-status`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Before creating, `openclaw cron list` and match on exact `name`. If found, `openclaw cron edit <id> ...`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If not found, `openclaw cron add --name <name> ...`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Also offer a periodic version check so the user can decide when to update (numbered):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. `openclaw update status` (preferred for source checkouts and channels)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. `npm view openclaw version` (published npm version)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## OpenClaw command accuracy（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use only supported commands and flags:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw security audit [--deep] [--fix] [--json]`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw status` / `openclaw status --deep`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw health --json`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw update status`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw cron add|list|runs|run`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Do not invent CLI flags or imply OpenClaw enforces host firewall/SSH policies.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Logging and audit trail（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Record:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Gateway identity and role（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Plan ID and timestamp（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Approved steps and exact commands（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Exit codes and files modified (best effort)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Redact secrets. Never log tokens or full credential contents.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Memory writes (conditional)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Only write to memory files when the user explicitly opts in and the session is a private/local workspace（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
(per `docs/reference/templates/AGENTS.md`). Otherwise provide a redacted, paste-ready summary the user can（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
decide to save elsewhere.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Follow the durable-memory prompt format used by OpenClaw compaction:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Write lasting notes to `memory/YYYY-MM-DD.md`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
After each audit/hardening run, if opted-in, append a short, dated summary to `memory/YYYY-MM-DD.md`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
(what was checked, key findings, actions taken, any scheduled cron jobs, key decisions,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
and all commands executed). Append-only: never overwrite existing entries.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Redact sensitive host details (usernames, hostnames, IPs, serials, service names, tokens).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If there are durable preferences or decisions (risk posture, allowed ports, update policy),（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
also update `MEMORY.md` (long-term memory is optional and only used in private sessions).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If the session cannot write to the workspace, ask for permission or provide exact entries（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
the user can paste into the memory files.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
