---
summary: "Heartbeat polling messages and notification rules"
read_when:
  - Adjusting heartbeat cadence or messaging
---
# Heartbeat (Gateway)

Heartbeat runs **periodic agent turns** in the main session so the model can
surface anything that needs attention without spamming you.

## Defaults

- Interval: `30m` (set `agent.heartbeat.every`; use `0m` to disable).
- Prompt body (configurable via `agent.heartbeat.prompt`):
  `Read HEARTBEAT.md if exists. Consider outstanding tasks. Checkup sometimes on your human during (user local) day time.`
- The heartbeat prompt is sent **verbatim** as the user message. The system
  prompt includes a “Heartbeat” section and the run is flagged internally.

## Response contract

- If nothing needs attention, reply with **`HEARTBEAT_OK`**.
- During heartbeat runs, Clawdbot treats `HEARTBEAT_OK` as an ack when it appears
  at the **start or end** of the reply. The token is stripped and the reply is
  dropped if the remaining content is **≤ `ackMaxChars`** (default: 30).
- If `HEARTBEAT_OK` appears in the **middle** of a reply, it is not treated
  specially.
- For alerts, **do not** include `HEARTBEAT_OK`; return only the alert text.

Outside heartbeats, stray `HEARTBEAT_OK` at the start/end of a message is stripped
and logged; a message that is only `HEARTBEAT_OK` is dropped.

## Config

```json5
{
  agent: {
    heartbeat: {
      every: "30m",           // default: 30m (0m disables)
      model: "anthropic/claude-opus-4-5",
      target: "last",         // last | whatsapp | telegram | discord | slack | signal | imessage | none
      to: "+15551234567",     // optional provider-specific override
      prompt: "Read HEARTBEAT.md if exists. Consider outstanding tasks. Checkup sometimes on your human during (user local) day time.",
      ackMaxChars: 30          // max chars allowed after HEARTBEAT_OK
    }
  }
}
```

### Field notes

- `every`: heartbeat interval (duration string; default unit = minutes).
- `model`: optional model override for heartbeat runs (`provider/model`).
- `target`:
  - `last` (default): deliver to the last used external provider.
  - explicit provider: `whatsapp` / `telegram` / `discord` / `slack` / `signal` / `imessage`.
  - `none`: run the heartbeat but **do not deliver** externally.
- `to`: optional recipient override (E.164 for WhatsApp, chat id for Telegram, etc.).
- `prompt`: overrides the default prompt body (not merged).
- `ackMaxChars`: max chars allowed after `HEARTBEAT_OK` before delivery.

## Delivery behavior

- Heartbeats run in the **main session** (`main`, or `global` when scope is global).
- If the main queue is busy, the heartbeat is skipped and retried later.
- If `target` resolves to no external destination, the run still happens but no
  outbound message is sent.
- Heartbeat-only replies do **not** keep the session alive; the last `updatedAt`
  is restored so idle expiry behaves normally.

## HEARTBEAT.md (optional)

If a `HEARTBEAT.md` file exists in the workspace, the default prompt tells the
agent to read it. Keep it tiny (short checklist or reminders) to avoid prompt
bloat.

## Manual wake (on-demand)

You can enqueue a system event and trigger an immediate heartbeat with:

```bash
clawdbot wake --text "Check for urgent follow-ups" --mode now
```

Use `--mode next-heartbeat` to wait for the next scheduled tick.

## Cost awareness

Heartbeats run full agent turns. Shorter intervals burn more tokens. Keep
`HEARTBEAT.md` small and consider a cheaper `model` or `target: "none"` if you
only want internal state updates.
