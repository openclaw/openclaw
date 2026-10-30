# Upstream Gaps & Missing Artifacts

1. **Missing 45 Agent docx files**: The user mentioned 45 pre-defined agents in docx files, but they were not present in the environment or repo. They must be provided in a parseable format (Markdown, JSON, text) to import them into Paperclip.
2. **Paperclip Heartbeat Integration**: Natively wiring OpenClaw agents to a Paperclip heartbeat depends on how OpenClaw parses `HEARTBEAT.md` vs. Paperclip's required API. This might require an integration script if a native plugin doesn't exist.
3. **spotify_player programmatic control**: If `spotify_player` does not expose an IPC/CLI interface for playback control, it will block true autonomous music management by the agent.
