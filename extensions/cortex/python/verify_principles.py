#!/usr/bin/env python3
"""
Verify PRINCIPLES.md integrity before loading.
Run this before trusting the principles file.
"""

import hashlib
import json
import sys
from pathlib import Path

def verify_principles(memory_dir: Path = Path(__file__).parent) -> bool:
    """
    Verify PRINCIPLES.md hasn't been tampered with.
    
    Returns:
        True if hash matches, False if modified
    """
    integrity_file = memory_dir / 'INTEGRITY.json'
    principles_file = memory_dir / 'PRINCIPLES.md'
    
    if not integrity_file.exists():
        print("❌ INTEGRITY.json not found - cannot verify")
        return False
    
    if not principles_file.exists():
        print("❌ PRINCIPLES.md not found")
        return False
    
    # Load expected hash
    with open(integrity_file) as f:
        manifest = json.load(f)
    
    expected_hash = manifest['files']['PRINCIPLES.md']['hash']
    
    # Calculate current hash
    with open(principles_file, 'rb') as f:
        current_hash = hashlib.sha256(f.read()).hexdigest()
    
    if current_hash == expected_hash:
        print("✅ PRINCIPLES.md verified - integrity intact")
        print(f"   Hash: {current_hash[:32]}...")
        return True
    else:
        print("⚠️  WARNING: PRINCIPLES.md has been MODIFIED")
        print(f"   Expected: {expected_hash[:32]}...")
        print(f"   Current:  {current_hash[:32]}...")
        print("\n   Do NOT trust principles without investigating changes.")
        return False

if __name__ == '__main__':
    verified = verify_principles()
    sys.exit(0 if verified else 1)
