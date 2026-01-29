# PRD Analysis for Extension Opportunities

When reviewing or writing a PRD, analyze each feature for extension system opportunities.

## PRD Section Analysis Framework

### 1. Features Section

For each feature, ask:

| Question | If Yes → |
|----------|----------|
| Does it teach the agent a new workflow? | SKILL |
| Does it need to react to user commands? | HOOK |
| Does it add a new agent capability (tool)? | PLUGIN |
| Does it need to run on a schedule? | CRON |
| Does it involve device interaction? | NODE |

### 2. User Stories Section

Pattern match user stories:

```
"As a user, I want the agent to know how to..."
→ SKILL (documentation/instructions)

"As a user, when I run /new, I want..."
→ HOOK (event interception)

"As a user, I want the agent to be able to..."
→ PLUGIN (new tool capability)

"As a user, I want to be reminded every..."
→ CRON/HEARTBEAT (scheduled task)

"As a user, I want to take photos from..."
→ NODE (device interaction)
```

### 3. Technical Requirements Section

Map requirements to systems:

| Requirement Type | Extension System |
|------------------|------------------|
| "Agent must understand X" | Skill |
| "System must track/log Y" | Hook |
| "Agent must have tool Z" | Plugin |
| "Must run at time T" | Cron |
| "Must integrate with platform P" | Plugin (channel) |
| "Must use model M" | Provider config |
| "Must control device D" | Node |

### 4. Integration Points

Check for cross-system needs:

```
Feature needs knowledge + event response?
→ SKILL + HOOK combo

Feature needs new tool + usage guidance?
→ PLUGIN + bundled SKILL

Feature needs scheduled + periodic checks?
→ CRON (precise) + HEARTBEAT (batched)
```

## PRD Annotation Template

Add this section to PRDs:

```markdown
## Extension Architecture

### Extension Points Identified

| Feature | Extension | Rationale |
|---------|-----------|-----------|
| {{Feature 1}} | Skill | {{Why}} |
| {{Feature 2}} | Hook | {{Why}} |
| {{Feature 3}} | Plugin | {{Why}} |

### Implementation Order

1. {{First extension}} - Foundation
2. {{Second extension}} - Depends on 1
3. {{Third extension}} - Enhancement

### Cross-System Dependencies

- {{Extension A}} provides data for {{Extension B}}
- {{Extension C}} triggers {{Extension D}}

### Risk Assessment

| Extension | Complexity | Risk | Mitigation |
|-----------|------------|------|------------|
| {{Name}} | Low/Med/High | {{Risk}} | {{Mitigation}} |
```

## Common PRD Patterns

### Pattern: "Smart Assistant Feature"

```
PRD says: "Agent should intelligently do X based on context"

Analysis:
- Skill: Teaches agent WHEN to do X
- Hook: Injects current context for decisions
- Possibly: Cron for periodic context gathering
```

### Pattern: "Automated Workflow"

```
PRD says: "System should automatically do Y when Z happens"

Analysis:
- Hook: Captures event Z
- Plugin (tool): Executes action Y
- Skill: Documents the workflow
```

### Pattern: "Scheduled Report"

```
PRD says: "Generate report every [time]"

Analysis:
- Cron: Triggers at scheduled time
- Skill: Teaches report format
- Possibly: Hook to capture data continuously
```

### Pattern: "Device Integration"

```
PRD says: "Capture/control [device feature]"

Analysis:
- Node: Use existing capability if available
- Plugin: Add new node command if needed
- Skill: Document usage patterns
```

## Checklist for PRD Review

```
□ Each feature mapped to extension system
□ Cross-system dependencies identified
□ Implementation order determined
□ Complexity estimated
□ No feature requires multiple primary systems (simplify if so)
□ All triggers/events identified for hooks
□ All schedules identified for cron
□ Device capabilities verified for node features
```
