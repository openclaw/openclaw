---
summary: "Which tool calls move into the sandbox and which stay on the Gateway host"
title: "What gets sandboxed"
read_when: "You want to know exactly which execution moves into the sandbox."
---

The tool calls that run inside the sandbox, the directory discovery contract, and the parts that deliberately stay on the host.

## What gets sandboxed

- Tool execution: `exec`, `ls`, `read`, `write`, `edit`, `apply_patch`, `process`, etc.
- The optional sandboxed browser (`agents.defaults.sandbox.browser`).

Directory discovery uses `ls` without granting shell execution. It returns
whole, JSON-quoted names and a filename cursor when another page is available.
Use the same directory and returned `after` value to continue. Each page fits
the selected model's tool-result budget; no partial filename is returned.

Custom backends can provide `SandboxFsBridge.readDirectory({ filePath, cwd,
signal })`, returning `{ name, isDirectory }` entries from their permitted
filesystem roots. The method is optional for older plugins: `ls` is hidden when
it is absent, and OpenClaw does not fall back to reading the host filesystem.

Not sandboxed:

- The Gateway process itself.
- Any tool explicitly allowed to run outside an ordinary sandbox via `tools.elevated`. Elevated exec uses the configured escape path (`gateway` by default, or `node` when the exec target is `node`), but cannot escape a session whose creator role requires sandboxing. If sandboxing is off, `tools.elevated` changes nothing since exec already runs on the host. See [Elevated Mode](/tools/elevated).
