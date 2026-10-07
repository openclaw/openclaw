---
summary: "Isolated transcript admission lifecycle investigation for issue 166446"
title: "Admission lifecycle investigation"
---

This investigation is based on upstream revision
`d9813e3489766284c105907f30065a83ff798a11`.

The added fixture resolves a synthetic persisted target through
`resolveAgentRunSessionTarget`, installs the real durable admission callback,
and persists through `createUserTurnTranscriptRecorder.persistApproved` before
awaiting the provider-dispatch persistence boundary. Ordinary, child, and
requester-settle-shaped keys are covered, but this is not a live Telegram,
spawn, or announcement reproduction. Logs contain only field equality booleans.

The manual-only workflow also runs the existing provider-dispatch rejection
contract. No comparison is relaxed, no rejection is caught or suppressed, and
no production repair is proposed until the incident mismatch is identified.
