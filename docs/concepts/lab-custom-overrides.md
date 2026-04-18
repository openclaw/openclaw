---
title: "Custom Overrides"
summary: "How Lab custom AGENTS addenda load, where they live, and how to debug them"
read_when:
  - You want to enable Lab custom overrides in a workspace
  - You need the exact model or agent override file paths
  - `/lab custom status` says an override is absent and you want to debug it
---

# Custom Overrides

Custom overrides are the first Lab feature. They let you prepend extra
`AGENTS.md` instructions for a specific model and, optionally, for a specific
agent.

## Enablement

Enable the feature from chat:

```txt
/lab enable custom
```

Check the current state:

```txt
/lab custom status
```

Disable it:

```txt
/lab disable custom
```

## Live filesystem contract

Model-level live addendum:

```txt
.openclaw/lab/overrides/<model-id>/AGENTS.md
```

Agent-level live addendum:

```txt
.openclaw/lab/agents/<agent-id>/overrides/<model-id>/AGENTS.md
```

Examples:

```txt
.openclaw/lab/overrides/gpt-5.4/AGENTS.md
.openclaw/lab/agents/reviewer/overrides/gpt-5.4/AGENTS.md
```

Agent ids are normalized from the active session key. The override is keyed by
the **agent id**, not by an arbitrary folder name.

## Prompt precedence

When present, Lab addenda are prepended ahead of the normal repo `AGENTS.md`:

```txt
1. model Lab addendum
2. agent Lab addendum
3. root AGENTS.md
4. other prompt/context files
5. FINAL_REMINDER.md
```

This is intentional. Lab is the higher-priority experimental overlay.

## Truncation and budgeting

Lab addenda are treated like normal prompt files:

- they have their own injected file entries
- they can truncate independently
- they show up in prompt reporting
- they follow normal context budgeting

Budget priority matches prompt priority:

```txt
1. model Lab addendum
2. agent Lab addendum
3. root AGENTS.md
```

If truncation happens, `/lab custom status` reports it against the active Lab
paths.

## What `/lab custom status` really tells you

`/lab custom status` resolves against the **active session workspace**, not
whatever repo you happen to be editing in another terminal.

It reports:

- `workspace`
- checked model override path
- checked agent override path
- whether each live override is present
- active addenda
- truncation state

That means this command is useful for diagnosing cases like:

- the file exists in the repo checkout, but the active Telegram or Discord agent
  is actually using a different workspace
- the active model id does not match the folder name exactly
- the active agent id does not match the folder you created

## Best practice

Treat the repo copy as the source of truth, then sync the active workspace copy
when you want to test live behavior quickly.

That avoids silent drift between:

- the repo version you intend to ship
- the live workspace version your bot is actually loading

See [GPT-5.4 Tuning](/concepts/lab-gpt54-tuning) for the current shipped
GPT-5.4 addendum structure and tuning guidance.
