---
summary: "Experimental: reviews ongoing agent work on the session's own model and offers one short correction."
read_when:
  - You are installing, configuring, or auditing the advisor plugin
title: "Advisor plugin reference"
---

<!-- Generated file. Do not edit by hand.
Run `pnpm plugins:inventory:gen` to rebuild it. Hand-written text survives only
between the openclaw-plugin-reference:manual-start and
openclaw-plugin-reference:manual-end comment markers. -->

Experimental: reviews ongoing agent work on the session's own model and offers one short correction.

## Distribution

- Package: `@openclaw/advisor`
- Install route: included in OpenClaw

## Surface

This plugin declares no channels, providers, commands, or contracts.

<!-- openclaw-plugin-reference:manual-start -->

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
output contract asks for a first line of `NO_CHANGE`, `BLOCKER`, or
`CORRECTION`, followed by one short correction. There is no second verification
pass. A well-formed `BLOCKER` steers the active run directly and is dropped if
the run already ended. A well-formed `CORRECTION` does not interrupt the run: it
is queued as next-turn context for the conversation's next user message and
expires after 24 hours. Any other reply delivers nothing.

Within a run, each review is told the corrections already given. Code also
drops a repeated correction, compared after ignoring case, spacing, and
punctuation, unless it escalates an earlier `CORRECTION` to a `BLOCKER`. A new
user message starts a new run and clears that history.

<!-- openclaw-plugin-reference:manual-end -->
