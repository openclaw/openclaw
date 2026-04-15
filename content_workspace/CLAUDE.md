# Master Dual-Agent Workflow Rules

## Architecture
This workspace utilizes a Two-Agent Model:
- **NanoClaw (Control Plane):** Reads/writes to Notion, assigns jobs, manages overall state.
- **OpenClaw (Execution Plane):** Executes assigned pipeline stages, writes artifacts, performs Tier 1 QA.

## Protocol Rules
- Agents MUST respect boundaries. OpenClaw NEVER approves its own output.
- All finalized artifacts are synced via the `jobs_sync/` directory.
- Honor the Model Workspace Protocol (ICM): Do one stage at a time.
- Context layers cascade: Root rules apply to all jobs, Account rules apply to specific accounts.
