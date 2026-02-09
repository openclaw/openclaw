#!/usr/bin/env python3
"""
Journal - Simple event logging with topic extraction and date tracking
"""
import sqlite3
import sys
import os
from datetime import datetime
from pathlib import Path

# DB location relative to script
DB_PATH = Path(__file__).parent.parent / "journal.db"


def init_db():
    """Initialize the database with the journal table."""
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS journal_entries (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            topic TEXT NOT NULL,
            date TEXT NOT NULL,
            message TEXT NOT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
    """)
    conn.commit()
    conn.close()


def add_entry(topic: str, date: str, message: str) -> dict:
    """Add a journal entry to the database."""
    init_db()
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    cursor.execute(
        "INSERT INTO journal_entries (topic, date, message) VALUES (?, ?, ?)",
        (topic, date, message)
    )
    conn.commit()
    entry_id = cursor.lastrowid
    conn.close()
    return {"id": entry_id, "topic": topic, "date": date, "message": message}


def search_entries(topic: str = None, date: str = None, limit: int = 50) -> list:
    """Search journal entries by topic and/or date."""
    init_db()
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    
    query = "SELECT id, topic, date, message, created_at FROM journal_entries WHERE 1=1"
    params = []
    
    if topic:
        query += " AND topic LIKE ?"
        params.append(f"%{topic}%")
    
    if date:
        query += " AND date = ?"
        params.append(date)
    
    query += " ORDER BY date DESC, created_at DESC LIMIT ?"
    params.append(limit)
    
    cursor.execute(query, params)
    results = cursor.fetchall()
    conn.close()
    
    return [
        {
            "id": r[0],
            "topic": r[1],
            "date": r[2],
            "message": r[3],
            "created_at": r[4]
        }
        for r in results
    ]


def main():
    """CLI interface for journal operations."""
    if len(sys.argv) < 2:
        print("Usage: journal.py <command> [args]")
        print("Commands:")
        print("  add <topic> <date> <message>  - Add a journal entry")
        print("  search [--topic TOPIC] [--date DATE] [--limit N]  - Search entries")
        sys.exit(1)
    
    command = sys.argv[1]
    
    if command == "add":
        if len(sys.argv) != 5:
            print("Usage: journal.py add <topic> <date> <message>")
            sys.exit(1)
        
        topic = sys.argv[2]
        date = sys.argv[3]
        message = sys.argv[4]
        
        entry = add_entry(topic, date, message)
        print(f"Added journaling event. Topic: {entry['topic']} ; date: {entry['date']} ; {entry['message']}")
    
    elif command == "search":
        topic = None
        date = None
        limit = 50
        
        i = 2
        while i < len(sys.argv):
            if sys.argv[i] == "--topic" and i + 1 < len(sys.argv):
                topic = sys.argv[i + 1]
                i += 2
            elif sys.argv[i] == "--date" and i + 1 < len(sys.argv):
                date = sys.argv[i + 1]
                i += 2
            elif sys.argv[i] == "--limit" and i + 1 < len(sys.argv):
                limit = int(sys.argv[i + 1])
                i += 2
            else:
                i += 1
        
        results = search_entries(topic, date, limit)
        
        if not results:
            print("No entries found.")
        else:
            for entry in results:
                print(f"[{entry['id']}] {entry['date']} - {entry['topic']}: {entry['message']}")
    
    else:
        print(f"Unknown command: {command}")
        sys.exit(1)


if __name__ == "__main__":
    main()
