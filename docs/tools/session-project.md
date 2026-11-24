---
summary: "Let an agent move its own conversation into a registered project"
title: "Session project"
read_when:
  - A conversation started without a project and now needs one
  - You are checking when an agent can move a conversation into a project
---

`session_project` lets an agent move the conversation it is running in into a
registered project. After the move, the conversation works in a managed checkout
of that project's repository on its own branch, the same as a session created in
the project.

The tool is available by default in the agent's default workspace, subject to
tool policy. The agent sees the registered projects the requester can use. When
the user asks to work on a matching project, the agent moves the conversation
before starting work. Once the conversation is bound to a project or another
workspace, the tool is removed from its tool list.

## Actions

| Action | Input                            | Result                                                                              |
| ------ | -------------------------------- | ----------------------------------------------------------------------------------- |
| `list` | none                             | The registered projects the requesting person may use: `id`, `name`, `originUrl`.   |
| `move` | `projectId`, optional `checkout` | Ends the turn, opens the project, and resumes the conversation in its new checkout. |

## What a move does

- The conversation keeps its key, transcript, model and permissions.
- For sandboxed conversations, project moves require Docker or Podman.
- The move prepares the same [managed worktree](/concepts/managed-worktrees)
  as a new project session. When the move succeeds, Files can open the checkout
  immediately, including after a Gateway restart. Carried edits arrive before
  repository setup. Host setup requires the moving operator's administrator
  scope and follows the same worker and sandbox rules as session creation.
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

In the Control UI, open the conversation menu and choose **Move to project…**.
Select an existing project from the dropdown, then choose **Move**. The menu
offers this action only when you have a project to move into.

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
