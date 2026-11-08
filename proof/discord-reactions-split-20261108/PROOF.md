# Discord reaction conversations

Discord-only replacement for [original PR #195021](https://github.com/openclaw/openclaw/pull/195021), reconciled through `b0fb2cabc282f21097d2456f9d925e60eae746bf`. Original source author: Bobby Bones. Original branch/proof remain preserved. The original ee89 comprehensive review is historical and does not clear this replacement.

Base: `9a5df3d60f12b6c303225c50abeaa4d17bd27108`. This sibling PR and the Signal replacement share prerequisite commit `e542f3b2390f672de93513bae7c12dc4b9233cdb` exactly. The common commit introduces only generic typed reaction context, durable receipt support and SDK documentation. This branch includes no Signal-specific source, tests, registration or documentation changes. After the first sibling lands, reconcile the shared commit's actual upstream ancestry and refresh the remaining PR; never assume a squash merge retains it.

## Contract and preserved controls

Authorized Discord reaction add/remove enters ordinary conversation dispatch with bounded original-target facts and gateway occurrence identity. Durable ingress suppresses retained duplicate/replayed events across monitor replacement. Keyed outgoing reactions retain confirmed/uncertain/claimed/not-sent semantics and the 5,000-row reject-new namespace. Reactions do not accept tasks or grant approval.

The original Discord production code is preserved, with a safety explanation added for validation's tentative payload type assertion. The b0fb registry-owned runtime initialization in the CLI message-authority fixture is retained. Receipt tests also cover pre-transport refusal/retry and interrupted claims so the shared primitive is independently covered in this sibling.

## Validation status

The initial local Discord snapshot `64bdf71b76ce14f999004a0492712e95dd8e4b0c` passed both durable ingress/receipt tests in 110.26 seconds wall; test body time was under five seconds, with most wall time in cold compilation. Its full build exited zero and verified all 162 SDK subpaths. Initial changed-scope checks first encountered a missing executable shim and then a missing assertion safety explanation; both are corrected, and their failed/partial logs retained. These are historical results; final sibling checks and exact-head reviews remain pending. No live phone/channel delivery, configuration, deployment, or merge occurred.
