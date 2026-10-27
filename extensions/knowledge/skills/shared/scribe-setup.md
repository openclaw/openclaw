# Scribe setup

A scribe is an owner conversation that follows one Knowledge skill unattended.
The owner starts it by sending its setup message in a new conversation in their
direct chat. Three kinds of message reach it:

- **Setup**, the first message: `Knowledge scribe setup: <id>` and a JSON block.
- **Repair**, sent by the owner: `Knowledge scribe repair: <id>` and the same
  JSON block.
- **Scheduled run**, sent by the scribe's own automation:
  `Knowledge scribe run: <id>` and the same JSON block.

The JSON block is `{"scribe", "mode", "options", "timezone", "agentId"}`. It
is the only input. Do not ask questions: the run is unattended, and the owner
reads the result line afterwards.

| id                | Title                    | Skill                       | Modes         |
| ----------------- | ------------------------ | --------------------------- | ------------- |
| `unlinked-review` | Review unlinked claims   | `knowledge-unlinked-claims` | ongoing       |
| `conversations`   | Learn from conversations | `knowledge-ingest`          | once, ongoing |
| `memory`          | Learn from Memory        | `knowledge-ingest`          | once          |

## 1. Check access

Call `knowledge_status`. Continue when the scope is `private` and either
writes are enabled or the store is `unprovisioned`: a vault that was never
written reports writes off until its first write creates it. Otherwise end
with `state: "failed"` and say that this conversation lacks the owner's
private Knowledge access; sending the setup message from a new conversation in
the owner's direct chat fixes it. If a later write is refused, end the same
way.

## 2. Declare the automation (ongoing only)

A once scribe creates no automation; its `jobId` is `null`. An ongoing scribe
owns exactly one automation, found by its declaration key. Call the
`automations` tool:

```json
{
  "action": "add",
  "job": {
    "name": "Knowledge scribe · <Title>",
    "declarationKey": "knowledge:scribe:<id>",
    "schedule": { "kind": "cron", "expr": "<schedule>", "tz": "<timezone>" },
    "sessionTarget": "session:<this conversation's session key from Runtime>",
    "payload": { "kind": "agentTurn", "message": "<run message>" },
    "delivery": { "mode": "none" },
    "failureAlert": { "after": 2 }
  }
}
```

- `<schedule>` comes from the scribe's skill section.
- `<run message>` is `Knowledge scribe run: <id>`, then
  `Follow the "Scribe setup" section of the <skill> skill as a scheduled run.`,
  then the received JSON block unchanged in a `json` fence.
- Adding with an existing declaration key updates this conversation's job in
  place and keeps its enabled state, but not its session target.

Before adding, `automations` `list` with `includeDisabled: true` and take the
jobs with this declaration key. Keys are unique per owning conversation
(`owner.sessionKey`), so exactly one must remain:

- `remove` each job owned by another conversation, noting whether it was
  paused.
- For this conversation's own job, `get` it. If its `sessionTarget` is not this
  conversation, `update` it with
  `{"sessionTarget": "session:<this conversation's session key>"}`.
- Pass `enabled: false` in the add only when a removed job was paused and this
  conversation had no job, so the owner's pause carries over. Otherwise do not
  pass `enabled`; never enable a paused job.

After adding, `get` the job and check that its `sessionTarget` is this
conversation.

Do not start a run yourself: a run started from this turn is skipped once the
turn ends. The first scheduled run is the test; for the review scribe, the next
maintenance pass that leaves claims unlinked queues it. Report the job ID and
its next run time.

## 3. Repair

Repair re-checks the setup; it does not do the scribe's work. Run step 1. For
an ongoing scribe, `automations` `list` with `includeDisabled: true` and find
the job with declaration key `knowledge:scribe:<id>`. If it is missing,
targets another session or has duplicates, run step 2. Report whether the job
is enabled; never enable a paused job.

## 4. Scheduled runs

Run step 1, then the scribe's work. Scheduled runs cannot add automations; if
the work finds the setup broken, end with `state: "failed"` and say a repair is
needed.

## 5. Result line

End every final reply (setup, repair, scheduled run) with exactly one line:

```text
SCRIBE_RESULT {"scribe":"<id>","state":"on"|"done"|"failed","jobId":"<id or null>","summary":"<one sentence>"}
```

`on`: an ongoing scribe is set up or ran. `done`: a once scribe finished.
`failed`: the scribe could not do its work; `summary` says why. The summary
gives counts, not vault content: it is shown outside the vault.
