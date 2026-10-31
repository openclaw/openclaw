# Meeting page

Use a clean source title; no ingestion date in the title. Store the occurrence in
the meeting type's `fields.occurred_at` at source precision. A date-only value is
not a midnight instant. Put source timezone context in the body; never guess a
timezone. Follow [writing](writing.md).

```markdown
# {Meeting Title}

**Attendees:** {participants as links: people who spoke, were addressed or
otherwise took part}. Also invited: {plain names, no links}.
**Date:** {date and local time, or unknown}
**Duration:** {if known}

## Summary

{3–5 bullets: the outcomes a teammate needs, each cited}

## Key Decisions

{"Who: decision", cited, or: _No decisions — discussion only._}

## Action Items

{"Owner: action (deadline if stated)", cited, or: _None — exploratory conversation._}

## Notable Quotes

{Verbatim spans worth reading, attributed and cited, or:
_No notable quotes — operational/logistics meeting._}

## Discussion Notes

{Short notes by topic, cited. Link companies, projects and people inline where
they come up.}

## Source Context

{2–4 lines: source ID/URL, a compact speaker list ("me → Josh Lehman; Gideon
update → Gideon Adegbesan"), and any split boundary or real transcription gap.}
```

- The Attendees line links only people in the room identified with high or
  medium confidence. Low-confidence guesses, roles and unresolved speakers go
  in Discussion Notes or Source Context, not on that line.
- Summary, Key Decisions, Action Items and Notable Quotes are required. Check the
  transcript before writing "none"; a bare `None` is not a reason. Short
  logistics meetings still get every section.
- An action item with an unresolved owner names the speaker label instead
  ("Unidentified remote speaker: …"). Don't explain why it's unresolved.
- Cite transcript passages through the meeting's own observed path with verified
  line labels.
- The transcript stays an attachment. Don't paste it into the body.
- Publish the body with its evidence first, then add self-citations and links
  using the returned path.

For a complete worked page and matching profile, read
[meeting and entity example](meeting-entity-example.md).
