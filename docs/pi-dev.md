---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "Pi Development Workflow"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Pi Development Workflow（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
This guide summarizes a sane workflow for working on the pi integration in OpenClaw.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Type Checking and Linting（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Type check and build: `pnpm build`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Lint: `pnpm lint`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Format check: `pnpm format`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Full gate before pushing: `pnpm lint && pnpm build && pnpm test`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Running Pi Tests（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use the dedicated script for the pi integration test set:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
scripts/pi/run-tests.sh（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
To include the live test that exercises real provider behavior:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
scripts/pi/run-tests.sh --live（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The script runs all pi related unit tests via these globs:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `src/agents/pi-*.test.ts`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `src/agents/pi-embedded-*.test.ts`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `src/agents/pi-tools*.test.ts`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `src/agents/pi-settings.test.ts`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `src/agents/pi-tool-definition-adapter.test.ts`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `src/agents/pi-extensions/*.test.ts`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Manual Testing（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Recommended flow:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Run the gateway in dev mode:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `pnpm gateway:dev`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Trigger the agent directly:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `pnpm openclaw agent --message "Hello" --thinking low`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Use the TUI for interactive debugging:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `pnpm tui`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
For tool call behavior, prompt for a `read` or `exec` action so you can see tool streaming and payload handling.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Clean Slate Reset（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
State lives under the OpenClaw state directory. Default is `~/.openclaw`. If `OPENCLAW_STATE_DIR` is set, use that directory instead.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
To reset everything:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw.json` for config（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `credentials/` for auth profiles and tokens（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `agents/<agentId>/sessions/` for agent session history（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `agents/<agentId>/sessions.json` for the session index（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `sessions/` if legacy paths exist（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `workspace/` if you want a blank workspace（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If you only want to reset sessions, delete `agents/<agentId>/sessions/` and `agents/<agentId>/sessions.json` for that agent. Keep `credentials/` if you do not want to reauthenticate.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## References（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [https://docs.openclaw.ai/testing](https://docs.openclaw.ai/testing)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [https://docs.openclaw.ai/start/getting-started](https://docs.openclaw.ai/start/getting-started)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
