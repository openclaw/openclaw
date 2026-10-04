# Predictive Extensions (ROADMAP)

## Extensions Assessment

- **Voice Interaction**: Possible through MLX-native whisper + piper or similar open-source TTS.
- **Browser Automation**: `openclaw browser` tool is sandboxed and functional. Ensure `agents.defaults.sandbox.browser.allowHostControl` remains false unless strictly necessary.
- **Email/Calendar**: Requires OAuth; prefer local IMAP/SMTP sync (e.g., `isync`/`mbsync`) over cloud connectors to adhere to the local-first mandate.
- **Signal**: Viable via `signal-cli`. Sandboxed integration needed.
- **Vocabulary Learning**: Integrate into the dreaming process (curated in `USER.md`).
- **Document Intelligence**: Handled by memory-core embedding adapter pointing to MLX.
- **Financial Surface**: Only integrate via strict read-only APIs or manual export uploads.
- **Home Automation**: Home Assistant local API.
- **Multi-agent Teams**: Fully addressed by Paperclip `local_trusted` deployment.
- **Backup**: Add to `memory-compress.sh` as a cron job.
- **Model Eval / Cost Tracking**: Local MLX costs $0, but compute power can be tracked via `powermetrics`.

## Proactivity and Tracking

- **Scheduled Proactivity**:
  - A cron-driven check at intervals (e.g. 8am). Uses `HEARTBEAT.md` to decide whether to initiate conversation.
  - Do not build a custom system; use Automations if natively supported by OpenClaw.
- **Goal Tracking**:
  - Use a `GOALS.md` file in the workspace. If a goal has a deadline, the assistant proactively checks progress during its heartbeat.
- **Content Pipeline End-to-End**:
  - YouTube upload + Suno + content repurpose + Obsidian archival.
  - Do not build a monolithic pipeline. Document how each independent script connects via standard pipes.
- **Agent Performance Review**:
  - Weekly review generated from Paperclip's API (tracking tokens/tasks) to assess which agents are most effective.
