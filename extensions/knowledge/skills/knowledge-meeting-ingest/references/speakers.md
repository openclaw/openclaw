# Split, dedup and speaker resolution

## Split: one recording may hold several meetings

Signals: roster changes, hard topic cuts, fresh introductions or context resets,
an agenda naming several sessions. One signal is worth investigating; two or more
almost certainly mean a split. The same people changing topics in one
conversation is one meeting. If you can't tell, ask the user about the boundary.

For a split, partition into contiguous, non-overlapping segment ranges in original
order: drop nothing, duplicate nothing. Run the remaining steps once per meeting.
Record the shared source ID and exact boundaries on each page. Cross-link siblings
after their pages exist. Flag uncertain boundaries.

## Dedup across recorders

Search existing meetings by source ID, then title, attendees and date. Date ±1
day, attendee overlap ≥50% and a similar title make a candidate, not proof. Read
candidates and their coverage before deciding.

If the meeting exists, reconcile into it. Retain both originals and source IDs,
note coverage differences, and ground on the fuller transcript (compare lengths;
the recorder with better speaker labels may have captured less). Also inspect the
existing claims and connections, not just the page. Record source IDs in prose
or declared ontology fields, never in arbitrary frontmatter.

## Speaker resolution

Aim for a usable speaker map. Use every real signal, record a confidence, and
leave a label unresolved only when there is genuinely no signal. Never guess: a
wrong attribution is worse than none. Read a candidate's existing page before
accepting a match.

Keep source identity separate from human attribution. Within its provider/source
scope, the same supplied speaker ID remains one track across label changes;
different IDs with the same name remain distinct. An account or shared microphone
can carry several humans. Preserve its ID while attributing supported spans;
mentions, addressees and turn-taking cues never replace source track identity.
For label-only sources, keep the labels and uncertainty; do not manufacture IDs.
Keep raw account IDs in retained evidence and working attribution, not friendly
or public page prose. Use names or readable disambiguators there.

The [earlier guidance](https://github.com/openclaw/openclaw/blob/65ad1800528623f4148039b547a5550d0b89cf9e/extensions/knowledge/skills/knowledge-meeting-ingest/references/speakers.md#L40-L44)
could reassign a whole track from one remark. Grouping by display name also
[merged namesakes and split speakers after nickname changes](https://github.com/openclaw/openclaw/pull/205860).

1. **Recorder's own track.** Recorders that split audio into "me"/"microphone"
   and "them"/"room" (Granola does) put the note owner on the "me" track. Map
   it to the note owner with high confidence unless the content contradicts it
   or indicates a shared microphone.
2. **Handoffs.** On unresolved or shared tracks, "Gideon, go ahead" followed by
   an update supports attributing that update span to Gideon. Map the span, not
   the whole "them" track. Medium confidence unless the speaker self-identifies.
3. **Self-identification and roles.** "This is Calin, on cloud workers…" or a
   role that matches one roster person is evidence too. If what a named speaker
   says about themselves ("at my company…") contradicts that person's page,
   investigate the human attribution for that span. A mistaken label or shared
   microphone does not justify reassigning the whole track or changing its ID.
4. Record each label or span → person, with basis and confidence in
   `attribution_confidence` and your work log: high (recorder track, roster plus
   self-identification, or user-confirmed), medium (named unambiguously in the
   transcript, such as a handoff), low (inferred from content; flag it on the
   page). Only a compact speaker list goes on the meeting page.
5. Use `UNKNOWN` or `[Room]` only when no signal exists. Two roster people
   with the same first name and no other signal stay unresolved.
6. A roster lists invitees. It is not proof that someone spoke or attended.
7. **Phantom speakers:** more tracks than attendees, mid-sentence handoffs or
   labels that never address each other suggest over-splitting. Merge labels only
   on evidence, not counts.
8. **User correction:** an explicit user identification overrides inferred human
   attribution and the roster, while preserving source track IDs. Retain it as
   attributed evidence, keep the original transcript, and don't reopen a room
   the user has confirmed. Repairs of existing assertions go through
   `knowledge-correct`.
9. Speech-to-text garbles names. Before creating a transcript-only person,
   search spelling variants; assume a near-miss is the existing person. After
   confirming identity, reuse the page and add the variant as an alias.

## Fabricated-attendee check (during verification)

Names absent from both transcript and roster, or email domains that conflict with
a known identity, need inspection. Don't auto-rename or fill in addresses. Fix
affected outputs within scope and recheck. Uncertain identities stay flagged.
