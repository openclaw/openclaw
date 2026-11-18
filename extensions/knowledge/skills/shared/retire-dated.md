# Retire dated sections

Older pages may carry a written `## Timeline` section or sections headed by a
date, timestamp or source ("Context · 2026-08-12…", "Source context",
"Mentioned context", "Recorded follow-through"), or a paragraph that summarizes
one meeting. Retiring one means writing what is true now into the page and
keeping every dated fact as a record, then deleting the section. Do not move
dated reports under new headings, into Milestones as a log, or onto another
page: that rearranges them without explaining anything.

When to retire: in a page review, every one. During an ingestion, capture or
entity update that edits such a page, or when a write to it is rejected for its
size budget, retire at most three, largest first; the Knowledge Consolidation
scribe retires the rest.

## Retire a dated section

1. Move each lasting fact into the State topic or type section it bears on,
   with its citation, written as current. Several reports about one subject
   become one sentence about where it stands.
2. Make sure the section's source has a source note for this entity: reuse the
   existing relationship, or write a `discusses` relationship whose body is one
   sentence on what that source says about the entity
   ([source notes](source-notes.md)).
3. A remaining fact the page's claims do not already hold becomes an event or
   fact claim with the source as `source_page`.
4. Check every `[[id|label]]` link in the section: the page must still reach
   that record afterwards ([keep citations reachable](profiles.md#keep-citations-reachable)).
5. Delete the section with `knowledge_edit_body`. A line you could not record
   stays under the heading and goes in your report; it never keeps the rest of
   the section.

## Retire a written Timeline

1. Read the derived rows with `knowledge_timeline({entity, group: "source"})`,
   following `nextOffset`. Rows are usually missing for older entries; writing
   them is the job, not a reason to stop.
2. Give every entry a record. An entry needs nothing when its source already
   has a row with a note that says the same thing and the row's date is the
   entry's date. A grouped row carries its source's date, so an entry dated
   differently still needs its own event claim. Otherwise:
   - The first entry for a dated source with no note on its row becomes a
     `discusses` relationship (source → entity) whose body is the entry's
     sentence, citing the lines the entry cites. Copy the cited file's path,
     sha256, filename, mediaType and size from the source page's evidence; a
     citation that differs from the retained source is rejected.
   - Any other entry becomes an event claim with the entry's date as
     `occurred_at`, the entity in `entities`, and the source as `source_page`
     when there is one. That covers a second entry from the same source, an
     entry dated differently from its source, an undated source, no source, and
     a source whose relationship citation is rejected.
   - Batch the writes, then check every entry before you delete anything.
     A note shows as its source's row in the grouped rows. A claim from a
     source that already has a row is folded into that row's claim count, so
     check claims in the publication receipt or with
     `knowledge_timeline({entity})` without `group`, which lists each claim.
3. If an entry carries the only statement of something still current, fold it
   into State as in step 1 above.
4. Delete the whole section with `knowledge_edit_body`. Shrinking edits always
   succeed, and revision history keeps the old text. If an entry could not be
   recorded, delete the others, keep only that line under the heading, and
   report it.

Never move a Timeline section to another page with `knowledge_extract_section`.
