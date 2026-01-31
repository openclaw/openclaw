#!/usr/bin/env python3
"""
Memory decay system for Steve's knowledge base.

Tracks entity access and calculates hot/warm/cold tiers for memory prioritization.

Usage:
    python memory-decay.py access <entity>     # Log access to an entity
    python memory-decay.py tiers               # Show current tier breakdown
    python memory-decay.py recalc              # Recalculate all tiers based on dates
    python memory-decay.py hot                 # List hot entities
    python memory-decay.py summary             # Generate prioritized summary for context
"""

import json
import sys
from datetime import datetime, timedelta
from pathlib import Path

ACCESS_LOG = Path(__file__).parent.parent / "memory" / "access-log.json"

def load_log():
    if ACCESS_LOG.exists():
        return json.loads(ACCESS_LOG.read_text())
    return {"meta": {}, "entities": {}}

def save_log(data):
    data["meta"]["lastUpdated"] = datetime.now().strftime("%Y-%m-%d")
    ACCESS_LOG.write_text(json.dumps(data, indent=2))

def calculate_tier(last_accessed_str: str, access_count: int) -> str:
    """Calculate tier based on recency and frequency."""
    last_accessed = datetime.strptime(last_accessed_str, "%Y-%m-%d")
    days_ago = (datetime.now() - last_accessed).days
    
    # High frequency facts resist decay
    frequency_bonus = min(access_count // 10, 7)  # Up to 7 days bonus
    effective_days = max(0, days_ago - frequency_bonus)
    
    if effective_days <= 7:
        return "hot"
    elif effective_days <= 30:
        return "warm"
    else:
        return "cold"

def log_access(entity: str):
    """Log an access to an entity, updating count and recalculating tier."""
    data = load_log()
    today = datetime.now().strftime("%Y-%m-%d")
    
    if entity not in data["entities"]:
        data["entities"][entity] = {
            "accessCount": 0,
            "lastAccessed": today,
            "tier": "hot"
        }
    
    data["entities"][entity]["accessCount"] += 1
    data["entities"][entity]["lastAccessed"] = today
    data["entities"][entity]["tier"] = calculate_tier(
        today, 
        data["entities"][entity]["accessCount"]
    )
    
    save_log(data)
    print(f"✓ Logged access to {entity} (count: {data['entities'][entity]['accessCount']}, tier: {data['entities'][entity]['tier']})")

def recalculate_tiers():
    """Recalculate all tiers based on current dates."""
    data = load_log()
    changes = []
    
    for entity, info in data["entities"].items():
        old_tier = info["tier"]
        new_tier = calculate_tier(info["lastAccessed"], info["accessCount"])
        if old_tier != new_tier:
            changes.append((entity, old_tier, new_tier))
        info["tier"] = new_tier
    
    save_log(data)
    
    if changes:
        print("Tier changes:")
        for entity, old, new in changes:
            print(f"  {entity}: {old} → {new}")
    else:
        print("No tier changes.")
    
    return changes

def show_tiers():
    """Show current tier breakdown."""
    data = load_log()
    
    hot = [(e, i) for e, i in data["entities"].items() if i["tier"] == "hot"]
    warm = [(e, i) for e, i in data["entities"].items() if i["tier"] == "warm"]
    cold = [(e, i) for e, i in data["entities"].items() if i["tier"] == "cold"]
    
    # Sort by access count within each tier
    hot.sort(key=lambda x: x[1]["accessCount"], reverse=True)
    warm.sort(key=lambda x: x[1]["accessCount"], reverse=True)
    cold.sort(key=lambda x: x[1]["accessCount"], reverse=True)
    
    print(f"🔥 HOT ({len(hot)}):")
    for e, i in hot:
        print(f"   {e}: {i['accessCount']} accesses, last {i['lastAccessed']}")
    
    print(f"\n🌡️  WARM ({len(warm)}):")
    for e, i in warm:
        print(f"   {e}: {i['accessCount']} accesses, last {i['lastAccessed']}")
    
    print(f"\n❄️  COLD ({len(cold)}):")
    for e, i in cold:
        print(f"   {e}: {i['accessCount']} accesses, last {i['lastAccessed']}")

def list_hot():
    """List just the hot entities."""
    data = load_log()
    hot = [e for e, i in data["entities"].items() if i["tier"] == "hot"]
    hot.sort(key=lambda e: data["entities"][e]["accessCount"], reverse=True)
    for e in hot:
        print(e)

def generate_summary():
    """Generate a prioritized summary for context injection."""
    data = load_log()
    
    # Group by tier
    tiers = {"hot": [], "warm": [], "cold": []}
    for entity, info in data["entities"].items():
        tiers[info["tier"]].append((entity, info["accessCount"]))
    
    # Sort each tier by access count
    for tier in tiers:
        tiers[tier].sort(key=lambda x: x[1], reverse=True)
    
    print("## Active Context (prioritized by recency + frequency)\n")
    
    print("### 🔥 Hot (load these first)")
    for entity, count in tiers["hot"]:
        print(f"- {entity} ({count} accesses)")
    
    print("\n### 🌡️ Warm (load if relevant)")
    for entity, count in tiers["warm"]:
        print(f"- {entity} ({count} accesses)")
    
    print("\n### ❄️ Cold (available via search)")
    for entity, count in tiers["cold"]:
        print(f"- {entity} ({count} accesses)")

def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    
    cmd = sys.argv[1]
    
    if cmd == "access" and len(sys.argv) >= 3:
        log_access(sys.argv[2])
    elif cmd == "tiers":
        show_tiers()
    elif cmd == "recalc":
        recalculate_tiers()
    elif cmd == "hot":
        list_hot()
    elif cmd == "summary":
        generate_summary()
    else:
        print(__doc__)
        sys.exit(1)

if __name__ == "__main__":
    main()
