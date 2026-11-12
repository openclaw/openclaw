---
summary: "Reviews ongoing agent work on the session's own model and offers one short correction."
read_when:
  - You are installing, configuring, or auditing the advisor plugin
title: "Advisor plugin reference"
---

<!-- Generated file. Do not edit by hand.
Run `pnpm plugins:inventory:gen` to rebuild it. Hand-written text survives only
between the openclaw-plugin-reference:manual-start and
openclaw-plugin-reference:manual-end comment markers. -->

Reviews ongoing agent work on the session's own model and offers one short correction.

## Distribution

- Package: `@openclaw/advisor`
- Install route: included in OpenClaw

## Surface

This plugin declares no channels, providers, commands, or contracts.

<!-- openclaw-plugin-reference:manual-start -->

## How Advisor works

Advisor is a bundled plugin that is off by default. It watches
user-directed work and steps in while the agent goes off course: repeating
failing steps, waiting on finished work, working around a blocker it could fix,
drifting beyond what you asked, or claiming results the tools do not show.

A review forks the conversation on the session's own model and asks whether the
agent is on track. When it is not, Advisor steers the active run with one short
correction, which the agent sees before its next step under the run's own
permissions. If the run already ended, the correction is dropped. When the agent
is on track, nothing happens.

Each review is an extra model call on the session's model. With the default
`everyToolCalls: 0`, that is at most one per `everyMinutes` of work in a run.
Turning on `everyToolCalls` adds a second trigger, so reviews can run sooner
and more often. A review that misses the provider cache
processes the whole conversation again, which on a long session can be hundreds
of thousands of tokens.

Turn Advisor on or off with the **Enable** or **Disable** button in
**Settings → Plugins → Advisor**, and set the options below on its **Settings**
tab. The button saves `plugins.entries.advisor.enabled`. Or use config:

```json5
{
  plugins: {
    entries: {
      advisor: {
        enabled: true,
        config: { everyMinutes: 20, everyToolCalls: 0 },
      },
    },
  },
}
```

- `everyMinutes` (default `20`, range `0`–`1440`): review after this many minutes
  of work in a run, checked when a tool starts. Runs shorter than this are not
  reviewed.
- `everyToolCalls` (default `0`, off; range `0`–`1000`): also review after this
  many tool calls in a conversation.
- `reviewInstructions` (optional, up to 4,000 characters): replaces the built-in
  definition of "off course". Changes apply to the next review.

Set both triggers to `0` to turn reviews off.

Behavior and limits:

- Only the main agent's user-triggered runs are reviewed. Heartbeat, cron and
  other automatic runs are not, and neither are subagent sessions: the main
  agent sees what its subagents report, so Advisor corrects the main agent,
  which can redirect the subagent.
- After a correction steers a run, later reviews in that run are told what was
  already said and stay quiet unless they find a different problem.
- A due review waits until every running tool call has its result, so the fork
  never sees a missing or synthetic tool outcome. A stalled call delays the
  review rather than forcing it.
- Each conversation has at most one review in flight. The run ending, a new user
  message, session reset, plugin disable, or service stop cancels it.
- Reviews use the session's model, context and credentials. The fork cannot run
  tools or send replies. Corrections are labeled as advice the agent must check
  before acting.
- Advisor needs conversation access and prompt injection permission through
  `plugins.entries.advisor.hooks`, which trusted plugins have by default.
- Gateway info logs record review token usage (uncached input, cache reads,
  cache writes and output) and whether a correction steered the run. When a review
  misses the provider cache and the provider reports cache-write tokens, its
  context appears under cache writes rather than input. Reviews do not share the conversation's prompt-cache key, so on
  OpenAI routes some reviews miss the cache.

## Review instructions

Open the plugin's **Settings → Reviews → Review instructions** field to change
what Advisor reviews and when it stays quiet. The multiline field shows the
built-in guidance as placeholder text. Leave it blank to keep using the current
default without storing a copy.

The optional `plugins.entries.advisor.config.reviewInstructions` string accepts
up to 4,000 characters. Leading and trailing whitespace is trimmed;
whitespace-only values use the default. Changes apply to the next review without
restarting the Gateway.

Custom instructions replace only the guidance. A fixed prefix keeps tools
disabled and treats the conversation as evidence, not instructions. A fixed
output contract asks for a first line of `NO_CHANGE` or `CORRECTION`, followed
by one short correction. There is no second verification pass: a well-formed
`CORRECTION` steers the active run directly, and any other reply delivers
nothing. If the run already ended, the correction is dropped.

<!-- openclaw-plugin-reference:manual-end -->
