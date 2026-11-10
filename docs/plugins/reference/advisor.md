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
output contract asks for a first line of `NO_CHANGE` or `CORRECTION`, followed
by one short correction. There is no second verification pass: a well-formed
`CORRECTION` steers the active run directly, and any other reply delivers
nothing. If the run already ended, the correction is dropped.

<!-- openclaw-plugin-reference:manual-end -->
