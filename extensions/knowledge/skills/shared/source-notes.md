# Source notes

What a source says about an entity is its source note: the body of the one
relationship between them, shown as that source's row in the entity's derived
Timeline:

- `attended` (participant → meeting) for people who took part.
- `discusses` (source → entity) for anything else the source says something
  substantive about.

The body is one short sentence on what this source says about this entity, with
no date: the source carries it. Give the relationship evidence and `source_page`
like any other ([assertions](assertions.md)). Reuse an existing relationship
between the pair instead of adding a second. Claims about the entity from the
same source join the row through `source_page` and need no note of their own.

A row needs a dated source: a meeting's `occurred_at`, or the source's
`source_event` claim. A note on an undated source shows on no Timeline, so date
the source when it has a date (publication date, message date), and otherwise
save what happened as an event claim. An event the source reports from another
date (a founding, a past launch) is an event claim with its own `occurred_at`;
it keeps its own row.
