# Agent Specification: {agent_name}

**Module:** {module_code}
**Status:** Placeholder — To be created via create-agent workflow
**Created:** {date}

---

## Agent Metadata

```yaml
agent:
  metadata:
    id: "_bmad/{module_code}/agents/{agent_file_name}.md"
    name: { agent_human_name }
    title: { agent_title }
    icon: { agent_icon }
    module: { module_code }
    hasSidecar: false
```

---

## Agent Persona

### Role

{agent_role}

### Identity

{agent_identity}

### Communication Style

{agent_communication_style}

### Principles

{agent_principles}

---

## Agent Menu

### Planned Commands

| Trigger | Command | Description | Workflow |
| ------- | ------- | ----------- | -------- |

{agent_menu_table}

---

## Agent Integration

### Shared Context

- References: `{shared_context_files}`
- Collaboration with: {collaborating_agents}

### Workflow References

{workflow_references}

---

## Implementation Notes

**Use the create-agent workflow to build this agent.**

Inputs needed:

- Agent name and human name
- Role and expertise area
- Communication style preferences
- Menu commands and workflow mappings

---

_Spec created on {date} via BMAD Module workflow_
