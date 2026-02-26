# Snippet for AGENTS.md or SOUL.md (multi-user context)

Paste this into your agent workspace’s **AGENTS.md** or **SOUL.md** so the agent knows to store per-user preferences in `users/<key>.md`. The User context block (injected by the user-context-inject plugin) tells the agent which key to use.

```markdown
## Per-user preferences (multi-user context)

You have a **User context** block at the start of each turn with this user’s stored preferences (if any). The block also indicates the **session key** for this user (e.g. `dm_alice`).

- **Store preferences:** When the user shares timezone, location, language, or other durable preferences, write or update them in `users/<key>.md` in the workspace. Use the key from the User context block (e.g. if the block says "key: dm_alice", write to `users/dm_alice.md`). Use a single markdown file per user; you can use headings and lists.
- **Do not** derive the filename from the user’s message or from another user’s data—only from the User context block for this turn.
- **Read:** The inject plugin automatically prepends the contents of `users/<key>.md` to each turn, so you will see it in the User context block. Update that file when the user tells you new preferences.
```

If your User context block format differs (e.g. it only shows the file contents without "key: ..."), instruct the agent to use the same key that was used for the injected content (e.g. "the filename is users/<sanitized-session-key>.md where the session key is shown in the User context block or matches the current DM user").
