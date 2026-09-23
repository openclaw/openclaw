# Composer measurement-cap proof

Served Control UI, source server, commit of the repair plus this proof.
Fixture transcript only. Not the production gateway.

The banner on each shot is the measured DOM state, not a caption added later.

What the pictures show:

- `before-anchor.png` — composer height 36px, transcript on `LAST LINE`, scroll 3392/3392.
- `after-anchor.png` — 30,800 characters pin the composer at 156px. `LAST LINE` is still against the composer. Scroll 3492/3492.
- `after-shrink.png` — deleting back to a short draft returns the composer to 36px and the transcript stays anchored, 3392/3392.

What they do not show: a visible edge fade. `before-fade.png` has `data-scroll-fade-top` set, and `after-fade.png` has it cleared, but the mask is only 16px and does not read in the screenshot. The attribute change is in `report.json`. It is not visual proof of the fade.

Focused test `ui/src/pages/chat/components/chat-composer-dom.test.ts`: 8 passed, shard 1.73s, wall 2.00s.
