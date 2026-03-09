---
name: founder_outreach
description: Research people surfaced from WhatsApp groups via `wacli` and web tools, then draft personalized outreach for explicit recipients. Use for small-batch, user-reviewed prospecting only.
user-invocable: true
metadata: { "openclaw": { "requires": { "bins": ["wacli"] } } }
---

# Founder Outreach

Use this skill when the user wants to:

- inspect one or more WhatsApp groups they are already part of
- identify relevant people from those groups
- research those people using public professional sources
- draft personalized outbound messages for later review

Do not use this skill for bulk spam, mass cold outreach, or unsolicited sends without review.

This skill supports two modes:

- `research mode`: inspect a specific group or person on demand
- `monitor mode`: repeatedly scan an explicit allowlist of groups for buying-signal messages, then draft outreach for review

Unless the user overrides them, `monitor mode` defaults to:

- scan all messages from local midnight through now
- review the full message set before narrowing
- prioritize code-review and dev-tooling buying signals
- use public web research when available
- draft outreach for approval only
- never auto-send

## Guardrails

- Work only on chats or groups the user explicitly asked you to inspect.
- Keep batches small. Default to a shortlist of at most 5 people per pass.
- Use public professional information only: company sites, LinkedIn, X, GitHub, conference pages, podcasts, and other public web sources.
- Do not guess identity matches. If a match is uncertain, mark it low-confidence and say why.
- Never send a WhatsApp message until the user has approved both:
  - the exact recipient
  - the final message text
- Prefer short, specific, non-spammy messages. Mention shared group context when true.

## Tooling

- WhatsApp history and sends: `wacli`
- Public research: `web_search`, `web_fetch`
- JS-heavy sites or logged-in flows: `browser` if available

If `web_search` is unavailable, say so and fall back to `web_fetch` plus `browser` when possible.
If LinkedIn is needed, prefer `web_search` first. Use `browser` only when a logged-in browser session is available and the user wants that extra step.

## Workflow

1. Identify the target group.

```bash
wacli chats list --limit 50 --query "<group name or clue>" --json
```

If more than one group matches, stop and ask the user which chat to use.

2. Sync enough recent context for the chosen group.

```bash
wacli history backfill --chat "<group-jid>" --requests 4 --count 200
```

3. Search within that chat for useful signals.

Start with terms that help find introductions and operator/founder context:

- `founder`
- `startup`
- `building`
- `raising`
- `hiring`
- company names already seen in the thread
- the person's name once discovered

```bash
wacli messages search "founder" --chat "<group-jid>" --limit 50 --json
wacli messages search "raising" --chat "<group-jid>" --limit 50 --json
```

4. Build a shortlist.

For each candidate, extract:

- display name or WhatsApp label
- any number or JID evidence
- company / product / role clues from the chat
- why they seem relevant to the user's product
- confidence level

5. Research each candidate on the public web.

Search for:

- `"Name" company`
- `"Name" LinkedIn`
- `"Name" founder`
- `"Company" funding`
- `"Company" product`

Prioritize first-party and high-signal sources:

- company website
- LinkedIn
- GitHub
- conference/speaker pages
- interviews, podcasts, or launch posts

6. Produce a compact dossier before drafting messages.

For each person, include:

- who they likely are
- current company / role
- evidence from the WhatsApp group
- public-source evidence with links
- why they are a fit for outreach
- 1-2 message angles

7. Draft outreach only after the shortlist looks right.

Each message should:

- be 60-120 words unless the user asks otherwise
- mention the shared group context if appropriate
- mention one specific, truthful observation from the research
- explain the product in plain language
- end with a low-friction CTA

8. Ask for approval before sending.

When the user approves a recipient and message, send with:

```bash
wacli send text --to "<phone-or-jid>" --message "<approved text>"
```

## Monitor mode

Use monitor mode when the user asks you to keep checking a fixed list of groups over time.

Only monitor groups the user explicitly named.
Do not auto-send anything in monitor mode.

For each monitoring pass:

1. Sync recent WhatsApp state if needed.

```bash
wacli sync --once --refresh-groups --refresh-contacts
```

2. For each target group, inspect only recent messages since the requested window.

```bash
wacli messages list --chat "<group-jid>" --after "<RFC3339-or-date>" --limit 100 --json
```

When the user asks for a daily scan, treat that as:

- scan all messages from local midnight of the current day through now
- review the full message set first, not only keyword hits
- then prioritize the strongest code-review and dev-tooling signals for outreach review

3. Prioritize messages that mention these themes:

- code review
- code review tool
- CodeRabbit
- Greptile
- pull request review
- PR review
- reviewer
- static analysis
- developer tools
- dev tooling
- engineering productivity
- CI
- debugging

These are the default high-priority monitoring triggers. If the user says "monitor mode" without extra criteria, use this list automatically.

4. Use targeted searches to reduce noise when useful.

```bash
wacli messages search "code review" --chat "<group-jid>" --after "<RFC3339-or-date>" --limit 50 --json
wacli messages search "dev tooling" --chat "<group-jid>" --after "<RFC3339-or-date>" --limit 50 --json
wacli messages search "CodeRabbit" --chat "<group-jid>" --after "<RFC3339-or-date>" --limit 50 --json
wacli messages search "Greptile" --chat "<group-jid>" --after "<RFC3339-or-date>" --limit 50 --json
```

5. For each promising mention, build a review item:

- person
- group
- trigger message
- why it looks relevant
- quick public-web enrichment
- draft outreach

6. Stop at review.

Your output should be an approval queue, not an outbound action.
Use a format like:

- `Candidate`
- `Why flagged`
- `Evidence`
- `Draft message`
- `Status: awaiting approval`

If the user only provides a group list and asks for monitor mode, do not ask for more detail unless something is ambiguous. Use the default trigger set, the daily scan window, public-web enrichment, and approval-only behavior automatically.

## Output format

When doing research, present results in this order:

1. `Shortlist`
2. `Research notes`
3. `Draft outreach`
4. `Pending approval before send`

For each candidate, explicitly label confidence as `high`, `medium`, or `low`.

## Messaging style

- direct
- warm
- not overly polished
- no fake familiarity
- no hypey growth-hacker language
- avoid long paragraphs

Good example pattern:

`Hey <name> - we're in <group name> together. I noticed you're building <company/product>. We're working on <product> for <problem>. Thought it might actually be relevant because <specific reason>. If useful, happy to send a 2-minute overview.`

## Stop conditions

Stop and ask the user before continuing when:

- multiple identity matches look plausible
- the group is ambiguous
- the recipient is unclear
- the research evidence is weak
- the user has not approved the final send
- the monitoring scope or target groups are not explicit
