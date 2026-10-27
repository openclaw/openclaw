# Scribe setup

A scribe is an owner conversation that the Knowledge page's **Scribes** tab
starts. It follows one Knowledge skill. Three kinds of message reach it:

- **Setup**, the first message: `Knowledge scribe setup: <id>` and a JSON block.
- **Repair**, sent from the Scribes tab: `Knowledge scribe repair: <id>` and
  the same JSON block.
- **Scheduled run**, sent by the scribe's own automation:
  `Knowledge scribe run: <id>` and the same JSON block.

The JSON block is `{"scribe", "mode", "options", "timezone", "agentId"}`. It
is the only input. Do not ask questions: the run is unattended, and the owner
reads the result from the Scribes tab.

| id                | Title                    | Skill                       | Modes         |
| ----------------- | ------------------------ | --------------------------- | ------------- |
| `unlinked-review` | Review unlinked claims   | `knowledge-unlinked-claims` | ongoing       |
| `conversations`   | Learn from conversations | `knowledge-ingest`          | once, ongoing |
| `memory`          | Learn from Memory        | `knowledge-ingest`          | once          |

## 1. Check access

Call `knowledge_status`. Continue only when the scope is `private` and writes
are enabled. Otherwise end with `state: "failed"` and say that this
conversation lacks the owner's private Knowledge access; a new scribe started
from the Knowledge page fixes it.

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
- Do not pass `enabled`. Adding with an existing declaration key updates that
  job in place, so a job the owner paused stays paused.

Then start one test run: `automations` `{"action": "run", "jobId": "<id>",
"runMode": "force", "timeoutMs": 1000}`. The run is a turn in this
conversation, so it starts after this turn ends; do not wait for it. Report the
returned run ID. The test run is the first real run and ends with its own
result line.

## 3. Repair

Repair re-checks the setup; it does not do the scribe's work. Run step 1. For
an ongoing scribe, `automations` `list` with `includeDisabled: true` and find
the job with declaration key `knowledge:scribe:<id>`. If it is missing or
targets another session, run step 2 (without the test run when the job
existed). Report whether the job is enabled; never enable a paused job.

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
