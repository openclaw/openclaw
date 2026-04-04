# Ontology Schema Reference

Full type definitions and constraint patterns for the ontology graph.

## Core Types

### Agents & People

```yaml
Person:
  required: [name]
  properties:
    name: string
    email: string?
    phone: string?
    organization: ref(Organization)?
    notes: string?
    tags: string[]?

Organization:
  required: [name]
  properties:
    name: string
    type: enum(company, team, community, government, other)?
    website: url?
    members: ref(Person)[]?
```

### Work Management

```yaml
Project:
  required: [name]
  properties:
    name: string
    description: string?
    status: enum(planning, active, paused, completed, archived)
    owner: ref(Person)?
    team: ref(Person)[]?
    goals: ref(Goal)[]?
    start_date: date?
    end_date: date?
    tags: string[]?

Task:
  required: [title, status]
  properties:
    title: string
    description: string?
    status: enum(open, in_progress, blocked, done, cancelled)
    priority: enum(low, medium, high, urgent)?
    assignee: ref(Person)?
    project: ref(Project)?
    due: datetime?
    estimate_hours: number?
    blockers: ref(Task)[]?
    tags: string[]?

Goal:
  required: [description]
  properties:
    description: string
    target_date: date?
    status: enum(active, achieved, abandoned)?
    metrics: object[]?
    key_results: string[]?
```

### Time & Location

```yaml
Event:
  required: [title, start]
  properties:
    title: string
    description: string?
    start: datetime
    end: datetime?
    location: ref(Location)?
    attendees: ref(Person)[]?
    recurrence: object? # iCal RRULE format
    status: enum(confirmed, tentative, cancelled)?
    reminders: object[]?

Location:
  required: [name]
  properties:
    name: string
    address: string?
    city: string?
    country: string?
    coordinates: object? # {lat, lng}
    timezone: string?
```

### Information

```yaml
Document:
  required: [title]
  properties:
    title: string
    path: string? # Local file path
    url: url? # Remote URL
    mime_type: string?
    summary: string?
    content_hash: string?
    tags: string[]?

Message:
  required: [content, sender]
  properties:
    content: string
    sender: ref(Person)
    recipients: ref(Person)[]
    thread: ref(Thread)?
    timestamp: datetime
    platform: string? # email, slack, whatsapp, etc.
    external_id: string?

Thread:
  required: [subject]
  properties:
    subject: string
    participants: ref(Person)[]
    messages: ref(Message)[]
    status: enum(active, archived)?
    last_activity: datetime?

Note:
  required: [content]
  properties:
    content: string
    title: string?
    tags: string[]?
    refs: ref(Entity)[]? # Links to any entity
    created: datetime
```

### Resources

```yaml
Account:
  required: [service, username]
  properties:
    service: string # github, gmail, aws, etc.
    username: string
    url: url?
    credential_ref: ref(Credential)?

Device:
  required: [name, type]
  properties:
    name: string
    type: enum(computer, phone, tablet, server, iot, other)
    os: string?
    identifiers: object? # {mac, serial, etc.}
    owner: ref(Person)?

Credential:
  required: [service, secret_ref]
  forbidden_properties: [password, secret, token, key, api_key]
  properties:
    service: string
    secret_ref: string # Reference to secret store (e.g., "keychain:github-token")
    expires: datetime?
    scope: string[]?
```

### Meta

```yaml
Action:
  required: [type, target, timestamp]
  properties:
    type: string # create, update, delete, send, etc.
    target: ref(Entity)
    timestamp: datetime
    actor: ref(Person|Agent)?
    outcome: enum(success, failure, pending)?
    details: object?

Policy:
  required: [scope, rule]
  properties:
    scope: string # What this policy applies to
    rule: string # The constraint in natural language or code
    enforcement: enum(block, warn, log)
    enabled: boolean
```

## Relation Types

### Ownership & Assignment

```yaml
owns:
  from_types: [Person, Organization]
  to_types: [Account, Device, Document, Project]
  cardinality: one_to_many

has_owner:
  from_types: [Project, Task, Document]
  to_types: [Person]
  cardinality: many_to_one

assigned_to:
  from_types: [Task]
  to_types: [Person]
  cardinality: many_to_one
```

### Hierarchy & Containment

```yaml
has_task:
  from_types: [Project]
  to_types: [Task]
  cardinality: one_to_many

has_goal:
  from_types: [Project]
  to_types: [Goal]
  cardinality: one_to_many

member_of:
  from_types: [Person]
  to_types: [Organization]
  cardinality: many_to_many

part_of:
  from_types: [Task, Document, Event]
  to_types: [Project]
  cardinality: many_to_one
```

### Dependencies

```yaml
blocks:
  from_types: [Task]
  to_types: [Task]
  acyclic: true # Prevents circular dependencies
  cardinality: many_to_many

depends_on:
  from_types: [Task, Project]
  to_types: [Task, Project, Event]
  acyclic: true
  cardinality: many_to_many

requires:
  from_types: [Action]
  to_types: [Credential, Policy]
  cardinality: many_to_many
```

### References

```yaml
mentions:
  from_types: [Document, Message, Note]
  to_types: [Person, Project, Task, Event]
  cardinality: many_to_many

references:
  from_types: [Document, Note]
  to_types: [Document, Note]
  cardinality: many_to_many

follows_up:
  from_types: [Task, Event]
  to_types: [Event, Message]
  cardinality: many_to_one
```

### Events

```yaml
attendee_of:
  from_types: [Person]
  to_types: [Event]
  cardinality: many_to_many
  properties:
    status: enum(accepted, declined, tentative, pending)

located_at:
  from_types: [Event, Person, Device]
  to_types: [Location]
  cardinality: many_to_one
```

## Global Constraints

```yaml
constraints:
  # Credentials must never store secrets directly
  - type: Credential
    rule: "forbidden_properties: [password, secret, token]"
    message: "Credentials must use secret_ref to reference external secret storage"

  # Tasks must have valid status transitions
  - type: Task
    rule: "status transitions: open -> in_progress -> (done|blocked) -> done"
    enforcement: warn

  # Events must have end >= start
  - type: Event
    rule: "if end exists: end >= start"
    message: "Event end time must be after start time"

  # No orphan tasks (should belong to a project or have explicit owner)
  - type: Task
    rule: "has_relation(part_of, Project) OR has_property(owner)"
    enforcement: warn
    message: "Task should belong to a project or have an explicit owner"

  # Circular dependency prevention
  - relation: blocks
    rule: "acyclic"
    message: "Circular task dependencies are not allowed"
```
