# Deep Research

Opt-in evidence-backed research using portable model completions or the explicitly configured Google managed service. Jobs, operation receipts, cancellation intent, and results are retained in plugin state for seven days.

Use `deep_research` to start, inspect, resume, cancel, and retrieve a job. Reuse a start idempotency key. After interruption, resume with fresh authority; an unknown submission is indeterminate and is never blindly repeated. This layer does not schedule background recovery.

Provider citations remain provider-attributed; locally fetched and quoted source passages are distinct evidence. Native Google live entitlement and OAuth are not qualified.
