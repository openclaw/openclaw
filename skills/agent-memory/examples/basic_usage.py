"""
Basic usage example for AgentMemory
"""

import sys
import os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from src.memory import AgentMemory

# Initialize memory (creates ~/.agent-memory/memory.db by default)
# Use a temporary path for this example
mem = AgentMemory(db_path="/tmp/agent-memory-example.db")

print("🧠 AgentMemory Example\n")

# ==================== FACTS ====================
print("📝 Storing facts...")

mem.remember(
    "Boss prefers brief status updates over long explanations",
    tags=["preference", "communication", "boss"]
)

mem.remember(
    "API rate limit for the trading service is 100 requests per minute",
    tags=["technical", "api", "trading"]
)

mem.remember(
    "Weekly standup is every Monday at 9am EST",
    tags=["schedule", "meeting"]
)

# ==================== LESSONS ====================
print("🎓 Recording lessons...")

mem.learn(
    action="Deployed code directly to production without testing",
    context="deployment",
    outcome="negative",
    insight="Always run the full test suite before deploying, no matter how small the change"
)

mem.learn(
    action="Used quarter-Kelly position sizing for trades",
    context="trading",
    outcome="positive",
    insight="Conservative position sizing prevents large drawdowns and allows recovery from bad streaks"
)

# ==================== ENTITIES ====================
print("👤 Tracking entities...")

mem.track_entity("Alex", "person", {
    "role": "boss",
    "timezone": "America/New_York",
    "communication_style": "direct",
    "interests": ["AI", "trading", "automation"]
})

mem.track_entity("DataDeck", "project", {
    "type": "SaaS",
    "status": "completed",
    "features": 59,
    "url": "https://datadeck-preview.vercel.app"
})

# ==================== RECALL ====================
print("\n🔍 Recalling memories...\n")

# Search for communication preferences
print("Q: How does boss like updates?")
facts = mem.recall("boss communication updates")
for f in facts[:3]:
    print(f"  → {f.content}")

print()

# Get negative lessons about deployment
print("Q: What went wrong with deployments?")
lessons = mem.get_lessons(context="deployment", outcome="negative")
for l in lessons:
    print(f"  → Action: {l.action}")
    print(f"    Lesson: {l.insight}")

print()

# Get entity info
print("Q: What do I know about Alex?")
alex = mem.get_entity("Alex", "person")
if alex:
    print(f"  → Name: {alex.name}")
    print(f"  → Type: {alex.entity_type}")
    print(f"  → Attributes: {alex.attributes}")

# ==================== STATS ====================
print("\n📊 Memory stats:")
stats = mem.stats()
print(f"  Active facts: {stats['active_facts']}")
print(f"  Lessons: {stats['lessons']}")
print(f"  Entities: {stats['entities']}")

print("\n✅ Example complete!")
