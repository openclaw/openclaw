Subject: Cron job session routing — channel delivery ambiguity with multi-channel agents
When a cron job runs in sessionTarget: isolated mode, the resulting message is sent to a Slack channel but the message is never injected back into an active agent session. This means users cannot reply to the cron output and have the agent treat it as a continuation of that conversation — the reply simply goes unhandled or falls into a different session context.
isolated mode does support a to: field in the cron delivery config, which guarantees the output is routed to the correct channel. This makes channel delivery predictable.
Switching to sessionTarget: main resolves the reply continuity issue, but introduces a different problem: main mode does not support a to: field. For agents bound to multiple Slack channels, there is no mechanism to guarantee the cron output is delivered to the intended channel. The delivery channel appears to depend on whichever channel last had activity in the main session, making it non-deterministic.
This creates a forced tradeoff with no clean solution:
• isolated → guaranteed channel delivery, but no reply continuity
• main → reply continuity, but no channel targeting (to: not supported)
Questions:
1. Is there a plan to support to: (or equivalent channel pinning) in sessionTarget: main cron jobs?
2. Alternatively, is there a way in isolated mode to inject the cron message into a session so that subsequent user replies are handled in context?
3. Is this a known limitation, or is there a recommended workaround for multi-channel agents that need both delivery guarantees and reply continuity?
