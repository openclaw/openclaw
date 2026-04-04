# Query Reference

Query patterns and graph traversal examples.

## Basic Queries

### Get by ID

```bash
python3 scripts/ontology.py get --id task_001
```

### List by Type

```bash
# All tasks
python3 scripts/ontology.py list --type Task

# All people
python3 scripts/ontology.py list --type Person
```

### Filter by Properties

```bash
# Open tasks
python3 scripts/ontology.py query --type Task --where '{"status":"open"}'

# High priority tasks
python3 scripts/ontology.py query --type Task --where '{"priority":"high"}'

# Tasks assigned to specific person (by property)
python3 scripts/ontology.py query --type Task --where '{"assignee":"p_001"}'
```

## Relation Queries

### Get Related Entities

```bash
# Tasks belonging to a project (outgoing)
python3 scripts/ontology.py related --id proj_001 --rel has_task

# What projects does this task belong to (incoming)
python3 scripts/ontology.py related --id task_001 --rel part_of --dir incoming

# All relations for an entity (both directions)
python3 scripts/ontology.py related --id p_001 --dir both
```

### Common Patterns

```bash
# Who owns this project?
python3 scripts/ontology.py related --id proj_001 --rel has_owner

# What events is this person attending?
python3 scripts/ontology.py related --id p_001 --rel attendee_of --dir outgoing

# What's blocking this task?
python3 scripts/ontology.py related --id task_001 --rel blocked_by --dir incoming
```

## Programmatic Queries

### Python API

```python
from scripts.ontology import load_graph, query_entities, get_related

# Load the graph
entities, relations = load_graph("memory/ontology/graph.jsonl")

# Query entities
open_tasks = query_entities("Task", {"status": "open"}, "memory/ontology/graph.jsonl")

# Get related
project_tasks = get_related("proj_001", "has_task", "memory/ontology/graph.jsonl")
```

### Complex Queries

```python
# Find all tasks blocked by incomplete dependencies
def find_blocked_tasks(graph_path):
    entities, relations = load_graph(graph_path)
    blocked = []

    for entity in entities.values():
        if entity["type"] != "Task":
            continue
        if entity["properties"].get("status") == "blocked":
            # Find what's blocking it
            blockers = get_related(entity["id"], "blocked_by", graph_path, "incoming")
            incomplete_blockers = [
                b for b in blockers
                if b["entity"]["properties"].get("status") != "done"
            ]
            if incomplete_blockers:
                blocked.append({
                    "task": entity,
                    "blockers": incomplete_blockers
                })

    return blocked
```

### Path Queries

```python
# Find path between two entities
def find_path(from_id, to_id, graph_path, max_depth=5):
    entities, relations = load_graph(graph_path)

    visited = set()
    queue = [(from_id, [])]

    while queue:
        current, path = queue.pop(0)

        if current == to_id:
            return path

        if current in visited or len(path) >= max_depth:
            continue

        visited.add(current)

        for rel in relations:
            if rel["from"] == current and rel["to"] not in visited:
                queue.append((rel["to"], path + [rel]))
            if rel["to"] == current and rel["from"] not in visited:
                queue.append((rel["from"], path + [{**rel, "direction": "incoming"}]))

    return None  # No path found
```

## Query Patterns by Use Case

### Task Management

```bash
# All my open tasks
python3 scripts/ontology.py query --type Task --where '{"status":"open","assignee":"p_me"}'

# Overdue tasks (requires custom script for date comparison)
# See references/schema.md for date handling

# Tasks with no blockers
python3 scripts/ontology.py query --type Task --where '{"status":"open"}'
# Then filter in code for those with no incoming "blocks" relations
```

### Project Overview

```bash
# All tasks in project
python3 scripts/ontology.py related --id proj_001 --rel has_task

# Project team members
python3 scripts/ontology.py related --id proj_001 --rel has_member

# Project goals
python3 scripts/ontology.py related --id proj_001 --rel has_goal
```

### People & Contacts

```bash
# All people
python3 scripts/ontology.py list --type Person

# People in an organization
python3 scripts/ontology.py related --id org_001 --rel has_member

# What's assigned to this person
python3 scripts/ontology.py related --id p_001 --rel assigned_to --dir incoming
```

### Events & Calendar

```bash
# All events
python3 scripts/ontology.py list --type Event

# Events at a location
python3 scripts/ontology.py related --id loc_001 --rel located_at --dir incoming

# Event attendees
python3 scripts/ontology.py related --id event_001 --rel attendee_of --dir incoming
```

## Aggregations

For complex aggregations, use Python:

```python
from collections import Counter

def task_status_summary(project_id, graph_path):
    """Count tasks by status for a project."""
    tasks = get_related(project_id, "has_task", graph_path)
    statuses = Counter(t["entity"]["properties"].get("status", "unknown") for t in tasks)
    return dict(statuses)

def workload_by_person(graph_path):
    """Count open tasks per person."""
    open_tasks = query_entities("Task", {"status": "open"}, graph_path)
    workload = Counter(t["properties"].get("assignee") for t in open_tasks)
    return dict(workload)
```
