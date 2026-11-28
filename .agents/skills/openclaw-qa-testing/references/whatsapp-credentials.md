## WhatsApp live credentials

Use this when setting up or replacing Convex `kind=whatsapp` credentials.

- Treat WhatsApp QA credentials as operator-owned live accounts, not generated fixtures.
- Use two dedicated WhatsApp-capable test numbers: one driver account and one SUT account. Do not use personal numbers or personal OpenClaw WhatsApp accounts in the shared pool.
- Register and link each account manually with WhatsApp or WhatsApp Business, storing Web auth only in isolated local auth dirs outside the repo.
- For group coverage, create a dedicated test group that includes both QA accounts and store its JID as `groupJid`; otherwise the group mention-gating scenario should be skipped by default and fail when explicitly requested.
- Package the two Baileys auth dirs into base64 `.tgz` payload fields and add a new active Convex credential row. Prefer adding a fresh row and disabling stale/broken rows over overwriting credentials in place.
- Expected payload fields: `driverPhoneE164`, `sutPhoneE164`, `driverAuthArchiveBase64`, `sutAuthArchiveBase64`, and optional `groupJid`.
- Keep credential material out of the repo, logs, PRs, and screenshots. Redact phone numbers unless the operator explicitly asks for local debugging.
- Validate with `pnpm openclaw qa whatsapp --credential-source convex --credential-role maintainer --provider-mode mock-openai` and preserve artifact paths plus redacted pass/fail summaries.
- If WhatsApp expires or invalidates a linked Web session, relink locally, package fresh auth archives, add a new Convex row, then disable the stale row.
