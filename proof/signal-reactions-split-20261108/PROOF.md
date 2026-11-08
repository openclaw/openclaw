# Signal reaction conversations

Signal-only replacement for [original PR #195021](https://github.com/openclaw/openclaw/pull/195021), reconciled through `b0fb2cabc282f21097d2456f9d925e60eae746bf`. Original source author: Bobby Bones. Original branch/proof remain preserved. The original ee89 comprehensive review is historical and does not clear this replacement.

Base: `9a5df3d60f12b6c303225c50abeaa4d17bd27108`. This sibling PR and the Discord replacement share prerequisite commit `e542f3b2390f672de93513bae7c12dc4b9233cdb` exactly. The common commit introduces only generic typed reaction context, durable receipt support and SDK documentation. This branch includes no Discord-specific source, tests, registration or documentation changes. After the first sibling lands, reconcile the shared commit's actual upstream ancestry and refresh the remaining PR; never assume a squash merge retains it.

## Contract and proof limits

Signal authorized add/remove, group routing, bounded original context, concurrent/restart replay and denied-group/self/sync controls are preserved. Keyed outgoing reactions retain confirmed/uncertain/claimed/not-sent semantics and the 5,000-row reject-new namespace. Reactions do not accept tasks or grant approval.

The earlier cumulative local snapshot `8567517bf3623cf8022e1e743fe319f7998767c3` passed 60 tests in two shards (217.10 seconds wall), including the two real ingress/receipt cases. That snapshot included Discord, so this is historical support only; fresh Signal-sibling tests, build, checks and exact-head CI/comprehensive/native reviews remain pending. No live phone/channel delivery, configuration, deployment, or merge occurred.
