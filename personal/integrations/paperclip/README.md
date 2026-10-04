# Paperclip Orchestration

"If OpenClaw is an employee, Paperclip is the company."

Paperclip orchestrates a team of agents, provides org charts, heartbeat scheduling, monthly token budgets with hard-stop enforcement, board approval for hires and strategy changes, and full audit logs.

## Deployment

**DO NOT** expose Paperclip to the internet. We use `local_trusted` mode.

1. Prerequisites: Node.js 20+ and pnpm 9.15+.
2. Install & Onboard:
   ```bash
   npx paperclipai onboard --yes
   ```
   Server runs at `http://localhost:3100`.
3. Start:
   ```bash
   paperclipai run
   ```
4. Diagnose issues:
   ```bash
   paperclipai doctor
   ```

## OpenClaw ↔ Paperclip Integration

OpenClaw agents can be "hired" into a Paperclip org chart if they can receive a heartbeat. Paperclip's budget enforcement and board-approval gates act as the safety mechanism for autonomous operation.

(Note: Wiring an OpenClaw agent to a Paperclip heartbeat depends on `HEARTBEAT.md` configurations and Paperclip's native HTTP triggers, documented in `GAPS.md` if not natively supported).
