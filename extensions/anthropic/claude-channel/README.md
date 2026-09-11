# OpenClaw channel for Claude Code

Lets teammates on your OpenClaw team server send messages into a Claude Code
session running on this machine. Reading the session needs nothing from this
directory: the OpenClaw node host tails `~/.claude/projects/**.jsonl` on its
own. Input needs the two files here:

- `openclaw-channel-server.mjs`: a Claude Code [channel](https://code.claude.com/docs/en/channels-reference)
  MCP server. Claude Code spawns it; it connects to the OpenClaw bridge socket
  (`<state dir>/node/claude-channel.sock`, `~/.openclaw` by default) and pushes
  each team message as `notifications/claude/channel`. It also exposes a
  `reply` tool.
- `openclaw-channel-hook.mjs`: a hook that posts `{session_id, cwd}` to the same
  socket on SessionStart / UserPromptSubmit / Stop / SessionEnd, which is how the
  bridge learns which Claude session a channel process belongs to (matched by
  working directory) and where turns end.

`openclaw` prints the exact paths and commands for your install
(`describeClaudeLocalSessionSetup()` in the plugin). By hand:

1. Register the channel server (user scope works from any project):

   ```sh
   claude mcp add --scope user openclaw -- node "<abs path>/openclaw-channel-server.mjs"
   ```

   or add to `.mcp.json`: `{"mcpServers": {"openclaw": {"command": "node", "args": ["<abs path>/openclaw-channel-server.mjs"]}}}`.

2. Install the hooks: merge `hooks.json` into `~/.claude/settings.json` after
   replacing `${CLAUDE_CHANNEL_DIR}` with this directory's absolute path.

3. Start Claude Code with the development channel flag (channels are a research
   preview; custom channels are not on the allowlist):

   ```sh
   claude --dangerously-load-development-channels server:openclaw
   ```

The session then shows `canInput` on the team server. Messages are delivered at
the next turn boundary; Claude Code does not acknowledge them, so OpenClaw
reports `submitted` once the notification is written and confirms delivery when
the echoed `<channel source="openclaw" openclaw_input_id="…">` record appears in
the transcript.

Requires `@modelcontextprotocol/sdk`, resolved from the OpenClaw install that
ships this file.
