---
summary: "Let an agent move its own conversation into a registered project"
title: "Session project"
read_when:
  - A conversation started without a project and now needs one to publish a pull request
  - You are enabling the optional session_project tool
---

`session_project` lets an agent move the conversation it is running in into a
registered project. After the move, the conversation works in a managed checkout
of that project's repository on its own branch, the same as a session created in
the project, so `github_publish` can open a pull request from it. People no
longer have to pick the project before they start.

The tool is off by default. Existing agents see no new tool and no prompt change
until you enable it.

## Enable

Name the tool in the agent's tool policy, and in the sandbox tool policy that
sandboxed conversations also pass. Group entries such as `group:sessions` do not
include it; a wildcard (`"*"`, or the `full` profile) does.

```json
{
  "tools": {
    "alsoAllow": ["session_project"],
    "sandbox": { "tools": { "alsoAllow": ["session_project"] } }
  }
}
```

## Actions

| Action | Input                            | Result                                                                              |
| ------ | -------------------------------- | ----------------------------------------------------------------------------------- |
| `list` | none                             | The registered projects the requesting person may use: `id`, `name`, `originUrl`.   |
| `move` | `projectId`, optional `checkout` | Ends the turn, opens the project, and resumes the conversation in its new checkout. |

## What a move does

- The conversation keeps its key, transcript, model and permissions.
- The move records the project and a new [worktree](/concepts/managed-worktrees)
  on the conversation, the same intent a session created in the project with a
  new worktree carries, and opens it the same way: the setup script, ignored
  files, sandbox and project context (`AGENTS.md`, project skills) follow the
  rules of a session created in the project. The resumed turn runs in the new
  checkout.
- Files from before the move stay in the original workspace. Links in earlier
  messages still open them there.
- Without `checkout`, the new branch starts from the project's default branch.
- With `checkout`, a folder in the conversation's workspace that holds a clone
  of the project, the new branch starts at that folder's current commit, and its
  unsaved changes (edited, new and deleted files) arrive as unsaved changes.
  Files the folder ignores stay behind. Git reads the folder inside the
  conversation's sandbox, or, for a conversation without one, on the Gateway
  host with the folder's own Git configuration, hooks and filters ignored. The
  move refuses, with nothing moved, when the folder shares no history with the
  project or resolves outside the workspace.
- A conversation moves only once. When it already has a project, worktree,
  device folder or remote workspace, `move` refuses and names the alternative:
  start a new session in the project with `sessions_spawn` (`visible: true`,
  `projectId`).
- Running background exec, unfinished children, an open terminal or another run
  of the conversation refuse the move. Nothing is stopped or moved.

## Who can move a conversation

- Only the agent running in the conversation can move it, never another session.
- The person who started the conversation, or someone with full
  `operator.write` permission.
- Project visibility follows [project access](/gateway/operator-scopes): people
  with `operator.write` may use every registered project; restricted roles see
  only public GitHub projects.
- In a channel conversation with no signed-in operator, only the owner can move
  it.

## Related

- [Managed worktrees](/concepts/managed-worktrees)
- [Sandboxing](/gateway/sandboxing)
- [Sub-agents](/tools/subagents)
