# Smoke Checklist

- Agent switch
  - Start a run, switch to another agent, confirm run state, queue, stream, and busy indicators reset.
  - Switch back and confirm no prior chat runtime state is reused.

- Compact
  - Trigger manual compact and confirm summary is present, recent tail remains, and technical facts survive.
  - Repeat compact multiple times and confirm hashes, env names, paths, IDs, and errors remain preserved.

- Archive
  - Archive an active chat mid-run and confirm no late assistant message lands in the archived transcript.
  - Confirm archived chat no longer receives summary or transcript updates.

- New chat
  - Create a new chat from an active/busy chat and confirm clean runtime state, empty queue, empty stream, and new session key.

- Hard-limit preflight
  - Force a session above hard limit and send a message.
  - Confirm compact runs exactly once and the last user input is still processed.

- Restart server
  - Restart once after migration and confirm active chats still load.
  - Restart again and confirm no duplicate archived main sessions or duplicate summary artifacts appear.

- Agent isolation
  - Use `agent:a:*` and `agent:b:*` with similar session keys and confirm no cross-loading of session entries or summaries.

- Repeated compact
  - Compact the same chat several times and confirm single-summary invariant and stable technical fact retention.

- Migration rerun
  - Re-run startup migration on partially migrated state and confirm idempotent behavior.
