# L264 handshake contention experiment

Synthetic signed-in warm reload, 3,000 sessions, chat and dashboard routes.
Use one quiet AWS c7a.4xlarge lease, the same built Gateway for every UI arm,
80 ms live-like shaping, 11 interleaved pairs, and an A/A control.
Profile separate diagnostic reloads from navigation through hello handling.

Primary: warm hello handled within the historical UI baseline plus 40 ms,
and better in at least 10/11 pairs against current main. Dashboard complete
page must improve in at least 8/11 pairs. Preserve cached first paint, first
transcript content, complete page, LoAF and CLS within the A/A spread.
Preserve one socket, connect-first, and no application requests before hello.

Identify introducing commits in 60aaedd81245..050238fdbdb0 with paired runs.
Do not ship a scheduling change without attributing the occupied main-thread
tasks. Inherent first-paint cost is a stop report, not permission to delay paint.
This experiment record is temporary and will be removed from a shipping PR.
