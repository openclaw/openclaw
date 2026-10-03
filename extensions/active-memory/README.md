# Active Memory

Bring relevant memories into a conversation before OpenClaw replies. Active
Memory can search prior context and use a recall agent for questions that need
deeper retrieval. Its default escalation mode reserves that extra recall step
for questions about the past when simpler retrieval is insufficient.

## Get started

Configure memory search and an authenticated model for your agent. For private
conversation recall, enable the agent's **Remember across conversations** setting
and keep Active Memory enabled.

Use `/active-memory status`, `/active-memory off`, or `/active-memory on` to
inspect or change recall for a conversation.

See [enabling Active Memory](https://docs.openclaw.ai/concepts/active-memory/enabling)
for scope, privacy boundaries, and advanced configuration.
