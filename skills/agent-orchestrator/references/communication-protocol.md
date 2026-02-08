# File-Based Communication Protocol

Specification for how orchestrator and sub-agents communicate via files.

## Directory Structure

Each agent has a standardized workspace:

```
agent-workspace/
├── SKILL.md           # Agent's skill definition (read-only for agent)
├── inbox/             # Input from orchestrator → agent
│   ├── instructions.md    # Task description and requirements
│   └── [input files]      # Any files needed for the task
├── outbox/            # Output from agent → orchestrator
│   └── [deliverables]     # Task outputs
├── workspace/         # Agent's private working area
│   └── [temp files]       # Intermediate work products
└── status.json        # Agent state tracking
```

## Status File Specification

`status.json` tracks agent lifecycle:

```json
{
  "state": "pending|running|completed|failed",
  "started": "2024-01-15T10:30:00Z",
  "completed": "2024-01-15T11:45:00Z",
  "error": null,
  "progress": {
    "current_step": "analyzing_data",
    "steps_completed": 3,
    "total_steps": 5
  },
  "metrics": {
    "files_processed": 12,
    "outputs_generated": 4
  }
}
```

### State Transitions

```
pending → running → completed
                 ↘ failed
```

**State Definitions:**
- `pending`: Agent created but not yet started
- `running`: Agent actively working on task
- `completed`: Agent finished successfully
- `failed`: Agent encountered unrecoverable error

### Update Protocol

1. **Orchestrator sets** initial state to `pending`
2. **Agent updates** to `running` when starting work
3. **Agent updates** to `completed` or `failed` when done
4. **Orchestrator reads** to determine next action

## Inbox Protocol

### instructions.md Format

```markdown
# Task: {TASK_NAME}

## Objective
{Clear statement of what needs to be accomplished}

## Context
{Background information relevant to the task}

## Inputs Provided
- `input_file_1.txt` - Description of what this contains
- `data/` - Directory containing...

## Requirements
1. {Specific requirement 1}
2. {Specific requirement 2}

## Success Criteria
- [ ] {Measurable outcome 1}
- [ ] {Measurable outcome 2}

## Constraints
- {Time/resource constraints}
- {Quality standards}

## Output Expectations
- Place main deliverable in `outbox/{filename}`
- Include summary in `outbox/summary.md`
```

### File Transfer Rules

- Orchestrator copies all needed files to `inbox/`
- Agent treats `inbox/` as read-only
- Original files remain with orchestrator
- Large files: use references/paths instead of copies

## Outbox Protocol

### Required Outputs

Every agent must produce at minimum:
1. **Primary deliverable(s)** - The actual work product
2. **summary.md** - Brief summary of what was done

### Optional Outputs

- `changelog.md` - Detailed log of actions taken
- `issues.md` - Problems encountered and how resolved
- `metadata.json` - Structured data about outputs

### Output Naming Convention

```
outbox/
├── {primary_deliverable}.{ext}
├── summary.md
├── data/           # If multiple data outputs
│   ├── file1.csv
│   └── file2.json
└── metadata.json
```

## Workspace Protocol

The `workspace/` directory is the agent's private area:

- **Agent can create** any files needed for processing
- **Orchestrator ignores** this directory during collection
- **Cleanup optional** - agents may leave or clean workspace
- **Useful for** intermediate results, caches, temp files

## Error Handling

### Failure Protocol

When an agent fails:

1. Update `status.json`:
```json
{
  "state": "failed",
  "error": {
    "type": "ValidationError",
    "message": "Input file format invalid",
    "details": "Expected CSV, got JSON",
    "recoverable": true
  }
}
```

2. Write `outbox/error_report.md`:
```markdown
# Error Report

## Error Type
ValidationError

## Description
Input file format was invalid. Expected CSV format but received JSON.

## Attempted Recovery
Tried to convert JSON to CSV but data structure incompatible.

## Suggested Resolution
Provide input as CSV with columns: id, name, value

## Partial Work
Any completed work before failure is in outbox/partial/
```

### Recovery Options

Orchestrator can:
1. **Retry** - Re-run with same inputs
2. **Fix and retry** - Correct inputs and re-run
3. **Skip** - Mark as failed, continue with other agents
4. **Escalate** - Request human intervention

## Dependency Handling

When agents depend on each other's outputs:

### Manifest File

Orchestrator creates `inbox/dependencies.json`:

```json
{
  "depends_on": [
    {
      "agent": "data-collector",
      "outputs": ["outbox/data.json", "outbox/sources.md"],
      "copy_to": "inbox/source_data/"
    }
  ],
  "wait_for": ["data-collector", "schema-validator"]
}
```

### Sequential Execution

```python
# Orchestrator pattern for dependencies
def execute_with_dependencies(agent, dependencies):
    # Wait for all dependencies
    for dep in dependencies:
        while not is_completed(dep):
            wait()

    # Copy dependency outputs to agent inbox
    for dep in dependencies:
        copy_outputs(dep.outbox, agent.inbox)

    # Start agent
    spawn_agent(agent)
```

## Parallel Execution

Independent agents can run simultaneously:

```python
# Spawn all independent agents at once
parallel_agents = identify_independent_agents(task_graph)
for agent in parallel_agents:
    spawn_agent(agent)  # Non-blocking

# Wait for all to complete
while not all_completed(parallel_agents):
    check_status_periodically()
```

## Message Passing Pattern

For complex inter-agent communication:

### Shared Message Queue (Optional)

```
orchestrator-workspace/
└── messages/
    ├── {agent-a}_to_{agent-b}_001.json
    └── {agent-b}_to_{agent-a}_002.json
```

Message format:
```json
{
  "from": "agent-a",
  "to": "agent-b",
  "timestamp": "2024-01-15T10:30:00Z",
  "type": "data_ready|question|answer|update",
  "content": { ... }
}
```

Note: For fully autonomous agents, prefer one-directional communication via inbox/outbox over message passing.
