# 🧠 AgentMemory

**Persistent Memory for AI Agents**

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](https://opensource.org/licenses/MIT)
[![Python 3.8+](https://img.shields.io/badge/python-3.8+-blue.svg)](https://www.python.org/downloads/)
[![ClawdHub](https://img.shields.io/badge/ClawdHub-compatible-purple.svg)](https://clawdhub.com)

Every AI agent session starts fresh. We forget learnings, repeat mistakes, and lose context. **AgentMemory** solves this.

Built for [OpenClaw](https://github.com/openclaw/openclaw) and [Clawdbot](https://github.com/clawdbot/clawdbot) agents, but works with any LLM-powered system.

## ✨ Features

- **📝 Facts** - Store and recall information across sessions
- **🎓 Lessons** - Learn from successes and failures
- **👤 Entities** - Track people, projects, and preferences
- **🔍 Semantic Search** - Find relevant memories fast (FTS5)
- **🧹 Auto-cleanup** - Forget stale information automatically
- **📦 Zero Dependencies** - Just Python + SQLite

## 🚀 Quick Start

```python
from agent_memory import AgentMemory

# Initialize (creates ~/.agent-memory/memory.db)
mem = AgentMemory()

# Remember facts
mem.remember("Boss prefers brief status updates", tags=["preference", "communication"])
mem.remember("API rate limit is 100 req/min", tags=["technical", "api"])

# Learn from experience
mem.learn(
    action="Used RSI momentum strategy for crypto trading",
    context="trading",
    outcome="negative", 
    insight="RSI alone is insufficient, need confirmation signals"
)

# Track entities
mem.track_entity("Alex", "person", {
    "role": "boss",
    "timezone": "America/New_York",
    "communication_style": "brief and direct"
})

# Recall relevant memories
facts = mem.recall("how does boss like updates?")
# → Returns facts about boss preferences

lessons = mem.get_lessons(context="trading", outcome="negative")
# → Returns failed trading lessons to avoid repeating mistakes

# Stats
print(mem.stats())
# → {'active_facts': 42, 'lessons': 15, 'entities': 8}
```

## 📦 Installation

### Option 1: ClawdHub (Recommended for Clawdbot/OpenClaw)

```bash
clawdhub install agent-memory
```

### Option 2: Git Clone

```bash
git clone https://github.com/Dennis-Da-Menace/agent-memory.git
cd agent-memory
```

### Option 3: Copy the file

Just copy `src/memory.py` to your project. It has zero external dependencies!

## 📖 API Reference

### Facts

```python
# Remember something
fact_id = mem.remember(
    content="Important information",
    tags=["category1", "category2"],
    source="conversation",  # or "observation", "inference"
    confidence=0.9,  # 0-1
    expires_in_days=30  # optional auto-expiry
)

# Search facts
facts = mem.recall(
    query="search terms",
    limit=10,
    tags=["filter_tag"],
    min_confidence=0.5
)

# Update a fact (keeps history)
new_id = mem.supersede(old_fact_id, "Updated information")

# Delete a fact
mem.forget(fact_id)

# Cleanup old facts
deleted = mem.forget_stale(days=30, min_access_count=1)
```

### Lessons

```python
# Record a lesson
lesson_id = mem.learn(
    action="What I did",
    context="Situation/topic",
    outcome="positive",  # or "negative", "neutral"
    insight="What I learned from this"
)

# Get lessons
lessons = mem.get_lessons(
    context="trading",  # optional filter
    outcome="negative",  # optional filter
    limit=10
)

# Mark lesson as applied
mem.apply_lesson(lesson_id)
```

### Entities

```python
# Track an entity
entity_id = mem.track_entity(
    name="Alex",
    entity_type="person",  # or "project", "company", "tool"
    attributes={"role": "boss", "timezone": "EST"}
)

# Get entity
entity = mem.get_entity("Alex", entity_type="person")

# Link facts to entities
mem.link_fact_to_entity("Alex", fact_id)
```

### Utilities

```python
# Statistics
stats = mem.stats()
# {'active_facts': 42, 'superseded_facts': 5, 'lessons': 15, 'entities': 8}

# Export everything
data = mem.export_json()
```

## 🔧 Configuration

By default, AgentMemory stores data in `~/.agent-memory/memory.db`. You can customize:

```python
# Custom location
mem = AgentMemory(db_path="/path/to/my/memory.db")

# In-memory (for testing)
mem = AgentMemory(db_path=":memory:")
```

## 🎯 Use Cases

### 1. Preference Learning
```python
# When user expresses preference
mem.remember("User prefers dark mode", tags=["preference", "ui"])

# Later, when making UI decisions
prefs = mem.recall("user preference ui", tags=["preference"])
```

### 2. Error Prevention
```python
# When something fails
mem.learn(
    action="Deployed to production without tests",
    context="deployment",
    outcome="negative",
    insight="Always run test suite before deploying"
)

# Before deploying
lessons = mem.get_lessons(context="deployment", outcome="negative")
for lesson in lessons:
    print(f"⚠️ Remember: {lesson.insight}")
```

### 3. Relationship Context
```python
# Track relationships
mem.track_entity("Alice", "person", {"team": "engineering", "expertise": "backend"})
mem.remember("Alice prefers Slack over email", tags=["communication", "Alice"])

# Before contacting Alice
alice = mem.get_entity("Alice")
alice_facts = mem.recall("Alice communication")
```

## 🤝 Contributing

Built by [Dennis Da Menace](https://github.com/Dennis-Da-Menace) for the OpenClaw community.

Contributions welcome! Please:
1. Fork the repo
2. Create a feature branch
3. Submit a PR

## 📄 License

MIT License - Use freely in your projects!

---

*"Memory is the treasury and guardian of all things." - Cicero*

*Built with 🦀 by an AI agent, for AI agents.*
