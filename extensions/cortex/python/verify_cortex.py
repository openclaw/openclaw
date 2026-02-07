#!/usr/bin/env python3
"""
Cortex Integrity Verification

Verifies that core Cortex files haven't been tampered with.
Run this before making changes to the memory system.
"""
import hashlib
import json
from pathlib import Path

MEMORY_DIR = Path(__file__).parent
INTEGRITY_FILE = MEMORY_DIR / "CORTEX_INTEGRITY.json"

CRITICAL_FILES = [
    "CORTEX_PRINCIPLES.md",
    "stm_manager.py",
    "collections_manager.py",
    "embeddings_manager.py",
    "verify_cortex.py"
]

def compute_hash(filepath):
    """Compute SHA256 hash of a file"""
    sha256 = hashlib.sha256()
    with open(filepath, 'rb') as f:
        while True:
            data = f.read(65536)  # 64KB chunks
            if not data:
                break
            sha256.update(data)
    return sha256.hexdigest()

def generate_integrity():
    """Generate integrity hashes for all critical files"""
    integrity = {
        "version": "1.0",
        "generated_at": "2026-02-03T07:40:00",
        "files": {}
    }
    
    for filename in CRITICAL_FILES:
        filepath = MEMORY_DIR / filename
        if filepath.exists():
            integrity["files"][filename] = compute_hash(filepath)
        else:
            print(f"Warning: {filename} not found")
    
    with open(INTEGRITY_FILE, 'w') as f:
        json.dump(integrity, f, indent=2)
    
    print(f"✅ Generated integrity hashes for {len(integrity['files'])} files")
    return integrity

def verify_integrity():
    """Verify integrity of critical files"""
    if not INTEGRITY_FILE.exists():
        print("❌ CORTEX_INTEGRITY.json not found")
        print("   Run with --generate to create it")
        return False
    
    with open(INTEGRITY_FILE, 'r') as f:
        expected = json.load(f)
    
    print(f"Verifying Cortex integrity (version {expected['version']})...")
    all_valid = True
    
    for filename, expected_hash in expected["files"].items():
        filepath = MEMORY_DIR / filename
        
        if not filepath.exists():
            print(f"❌ {filename}: FILE MISSING")
            all_valid = False
            continue
        
        actual_hash = compute_hash(filepath)
        
        if actual_hash == expected_hash:
            print(f"✅ {filename}: OK")
        else:
            print(f"❌ {filename}: HASH MISMATCH")
            print(f"   Expected: {expected_hash[:16]}...")
            print(f"   Actual:   {actual_hash[:16]}...")
            all_valid = False
    
    if all_valid:
        print("\n✅ All integrity checks passed")
        return True
    else:
        print("\n❌ Integrity verification FAILED")
        print("   Do NOT proceed with memory operations until this is resolved")
        return False

def verify_database():
    """Verify embeddings database schema"""
    import sqlite3
    
    db_path = MEMORY_DIR / ".embeddings.db"
    if not db_path.exists():
        print("⚠️  Embeddings database not found (will be created on first use)")
        return True
    
    conn = sqlite3.connect(db_path)
    c = conn.cursor()
    
    # Check table exists
    c.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='memories'")
    if not c.fetchone():
        print("❌ Database schema invalid: 'memories' table missing")
        conn.close()
        return False
    
    # Check required columns
    c.execute("PRAGMA table_info(memories)")
    columns = {row[1] for row in c.fetchall()}
    required = {'id', 'content', 'source', 'category', 'timestamp', 'importance', 'access_count'}
    
    if not required.issubset(columns):
        missing = required - columns
        print(f"❌ Database schema invalid: missing columns {missing}")
        conn.close()
        return False
    
    print("✅ Database schema valid")
    conn.close()
    return True

if __name__ == "__main__":
    import sys
    
    if "--generate" in sys.argv:
        generate_integrity()
    else:
        print("=" * 60)
        print("CORTEX INTEGRITY VERIFICATION")
        print("=" * 60)
        print()
        
        files_ok = verify_integrity()
        print()
        db_ok = verify_database()
        print()
        
        if files_ok and db_ok:
            print("✅ Cortex system verified - safe to proceed")
            sys.exit(0)
        else:
            print("❌ Verification failed - DO NOT PROCEED")
            sys.exit(1)
