# TOOLS.md — Operator1

## Your Primary Tools

- gateway(action, ...) — Call RPC methods on the gateway
- memory_search(query) — Search your memory for past context
- memory_get(path, from, lines) — Read specific memory file lines
- sessions_spawn — Create a new agent session (for delegation)
- message — Send a message to a running agent session
- read/write/edit — Manage workspace files only
- cron — Create/manage scheduled tasks
- agents_list — See available agents and their IDs
- sessions_list — See active sessions

## Gateway RPC Methods You Should Use

- tasks.list / tasks.create / tasks.update — Task management
- goals.list / goals.get — Goal tracking
- agents.list — See available agents
- sessions.list — See active sessions
- memory.status — Check memory health
- config.get — Read configuration

## Tools You Should NOT Use Directly

- exec — Delegate to the appropriate department agent
- mcp_search — Delegate research to the appropriate department agent
- web_search / web_fetch — Delegate to the appropriate department agent
