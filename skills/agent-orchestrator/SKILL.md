---
name: agent-orchestrator
description: |
  Meta-agent skill for orchestrating complex tasks through autonomous sub-agents. Decomposes macro tasks into subtasks, spawns specialized sub-agents with dynamically generated SKILL.md files, coordinates file-based communication, consolidates results, and dissolves agents upon completion.

  MANDATORY TRIGGERS: orchestrate, multi-agent, decompose task, spawn agents, sub-agents, parallel agents, agent coordination, task breakdown, meta-agent, agent factory, delegate tasks
---

# Agent Orchestrator

Orchestrate complex tasks by decomposing them into subtasks, spawning autonomous sub-agents, and consolidating their work.

## Core Workflow

### Phase 1: Task Decomposition

Analyze the macro task and break it into independent, parallelizable subtasks:

```
1. Identify the end goal and success criteria
2. List all major components/deliverables required
3. Determine dependencies between components
4. Group independent work into parallel subtasks
5. Create a dependency graph for sequential work
```

**Decomposition Principles:**
- Each subtask should be completable in isolation
- Minimize inter-agent dependencies
- Prefer broader, autonomous tasks over narrow, interdependent ones
- Include clear success criteria for each subtask

### Phase 2: Agent Generation

For each subtask, create a sub-agent workspace:

```bash
python3 scripts/create_agent.py <agent-name> --workspace <path>
```

This creates:
```
<workspace>/<agent-name>/
âââ SKILL.md          # Generated skill file for the agent
âââ inbox/            # Receives input files and instructions
âââ outbox/           # Delivers completed work
âââ workspace/        # Agent's working area
âââ status.json       # Agent state tracking
```

**Generate SKILL.md dynamically** with:
- Agent's specific role and objective
- Tools and capabilities needed
- Input/output specifications
- Success criteria
- Communication protocol

See [references/sub-agent-templates.md](references/sub-agent-templates.md) for pre-built templates.

### Phase 3: Agent Dispatch

Initialize each agent by:

1. Writing task instructions to `inbox/instructions.md`
2. Copying required input files to `inbox/`
3. Setting `status.json` to `{"state": "pending", "started": null}`
4. Spawning the agent using the Task tool:

```python
# Spawn agent with its generated skill
Task(
    description=f"{agent_name}: {brief_description}",
    prompt=f"""
    Read the skill at {agent_path}/SKILL.md and follow its instructions.
    Your workspace is {agent_path}/workspace/
    Read your task from {agent_path}/inbox/instructions.md
    Write all outputs to {agent_path}/outbox/
    Update {agent_path}/status.json when complete.
    """,
    subagent_type="general-purpose"
)
```

### Phase 4: Monitoring (Checkpoint-based)

For fully autonomous agents, minimal monitoring is needed:

```python
# Check agent completion
def check_agent_status(agent_path):
    status = read_json(f"{agent_path}/status.json")
    return status.get("state") == "completed"
```

Periodically check `status.json` for each agent. Agents update this file upon completion.

### Phase 5: Consolidation

Once all agents complete:

1. **Collect outputs** from each agent's `outbox/`
2. **Validate deliverables** against success criteria
3. **Merge/integrate** outputs as needed
4. **Resolve conflicts** if multiple agents touched shared concerns
5. **Generate summary** of all work completed

```python
# Consolidation pattern
for agent in agents:
    outputs = glob(f"{agent.path}/outbox/*")
    validate_outputs(outputs, agent.success_criteria)
    consolidated_results.extend(outputs)
```

### Phase 6: Dissolution & Summary

After consolidation:

1. **Archive agent workspaces** (optional)
2. **Clean up temporary files**
3. **Generate final summary**:
   - What was accomplished per agent
   - Any issues encountered
   - Final deliverables location
   - Time/resource metrics

```python
python3 scripts/dissolve_agents.py --workspace <path> --archive
```

## File-Based Communication Protocol

See [references/communication-protocol.md](references/communication-protocol.md) for detailed specs.

**Quick Reference:**
- `inbox/` - Read-only for agent, written by orchestrator
- `outbox/` - Write-only for agent, read by orchestrator
- `status.json` - Agent updates state: `pending` â `running` â `completed` | `failed`

## Example: Research Report Task

```
Macro Task: "Create a comprehensive market analysis report"

Decomposition:
âââ Agent: data-collector
â   âââ Gather market data, competitor info, trends
âââ Agent: analyst
â   âââ Analyze collected data, identify patterns
âââ Agent: writer
â   âââ Draft report sections from analysis
âââ Agent: reviewer
    âââ Review, edit, and finalize report

Dependency: data-collector â analyst â writer â reviewer
```

## Sub-Agent Templates

Pre-built templates for common agent types in [references/sub-agent-templates.md](references/sub-agent-templates.md):

- **Research Agent** - Web search, data gathering
- **Code Agent** - Implementation, testing
- **Analysis Agent** - Data processing, pattern finding
- **Writer Agent** - Content creation, documentation
- **Review Agent** - Quality assurance, editing
- **Integration Agent** - Merging outputs, conflict resolution

## Best Practices

1. **Start small** - Begin with 2-3 agents, scale as patterns emerge
2. **Clear boundaries** - Each agent owns specific deliverables
3. **Explicit handoffs** - Use structured files for agent communication
4. **Fail gracefully** - Agents report failures; orchestrator handles recovery
5. **Log everything** - Status files track progress for debugging
