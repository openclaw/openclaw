#!/usr/bin/env python3
"""
Cortex Client - Connects to embeddings daemon for instant search
Falls back to direct model loading if daemon is down
"""
import requests
import json

DAEMON_URL = "http://localhost:8030"

def daemon_available():
    try:
        r = requests.get(f"{DAEMON_URL}/health", timeout=1)
        return r.status_code == 200
    except:
        return False

def search(query, limit=5):
    """Search via daemon"""
    if daemon_available():
        r = requests.post(f"{DAEMON_URL}/search", json={"query": query, "limit": limit})
        return r.json().get("results", [])
    else:
        # Fallback to direct
        from local_embeddings import search as local_search
        return local_search(query, limit)

def store(content, category=None, importance=1.0, timestamp=None):
    """Store via daemon"""
    if daemon_available():
        r = requests.post(f"{DAEMON_URL}/store", json={
            "content": content, 
            "category": category,
            "importance": importance,
            "timestamp": timestamp
        })
        return r.json().get("id")
    else:
        from local_embeddings import store as local_store
        return local_store(content, category, importance, timestamp)

def stats():
    """Get stats via daemon"""
    if daemon_available():
        r = requests.get(f"{DAEMON_URL}/stats")
        return r.json()
    else:
        from local_embeddings import stats as local_stats
        return local_stats()

if __name__ == "__main__":
    if daemon_available():
        print("✅ Daemon connected!")
        print(f"   Stats: {stats()}")
    else:
        print("⚠️ Daemon not available, would use direct mode")
