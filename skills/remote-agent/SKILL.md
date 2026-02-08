---
name: remote-agent
description: Bridge to external vertical agents (Google ADK, VeADK, etc.) for specialized tasks.
---

# Remote Agent Bridge

This skill enables OpenClaw to delegate tasks to external, specialized AI agents via a standard HTTP interface. Use this when the user's request requires domain-specific knowledge (e.g., enterprise data, financial analysis, legal review) that is handled by a separate agent system.

## Configuration

Ensure the following environment variables are set in your OpenClaw environment (e.g., via `.env` or `openclaw config`):

- `REMOTE_AGENT_URL`: The HTTP endpoint of the external agent (e.g., `https://api.veadk.com/v1/run` or your Google ADK endpoint).
- `REMOTE_AGENT_KEY`: (Optional) The Bearer token for authentication.

## Usage

When the user asks a question that falls into the domain of a configured remote agent, use the provided Python script to forward the query.

### Command

```bash
python3 skills/remote-agent/scripts/client.py --query "<USER_QUERY>" [--agent "<AGENT_ID>"]
```

### Examples

**Scenario 1: Financial Analysis (VeADK)**
User: "Analyze the Q3 earnings report for TechCorp."
Thought: The user is asking for financial analysis. I should delegate this to the 'financial-expert' agent.
Action:
```bash
python3 skills/remote-agent/scripts/client.py --agent "financial-expert" --query "Analyze the Q3 earnings report for TechCorp"
```

**Scenario 2: Enterprise Knowledge (Google ADK)**
User: "What is the company policy on remote work?"
Thought: This requires internal knowledge. I'll ask the 'hr-bot'.
Action:
```bash
python3 skills/remote-agent/scripts/client.py --agent "hr-bot" --query "company policy on remote work"
```

**Scenario 3: Custom LangChain Backend**
User: "Run the data processing pipeline."
Action:
```bash
python3 skills/remote-agent/scripts/client.py --query "Run the data processing pipeline"
```

