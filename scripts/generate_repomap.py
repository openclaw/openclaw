#!/usr/bin/env python3
"""
RepoMap Generator
Creates a dense map of the repository structure to help AI agents understand
the codebase without blowing up their context window.
"""
import os
import sys

IGNORE_DIRS = {
    ".git", ".venv", "venv", "__pycache__", "node_modules", 
    ".mypy_cache", ".ruff_cache", "build", "dist"
}

def generate_repomap(startpath: str, max_depth: int = 4) -> str:
    """Walks the directory and creates a tree-like string representation."""
    repomap = []
    
    for root, dirs, files in os.walk(startpath):
        # Filter ignored directories in-place (modifying 'dirs' affects os.walk)
        dirs[:] = [d for d in dirs if d not in IGNORE_DIRS]
        
        # Calculate current depth relative to startpath
        rel_path = os.path.relpath(root, startpath)
        if rel_path == ".":
            level = 0
            repomap.append(f"📦 {os.path.basename(os.path.abspath(startpath))}/")
        else:
            level = rel_path.count(os.sep) + 1
            if level > max_depth:
                continue
            indent = '│   ' * (level - 1) + '├── '
            repomap.append(f"{indent}📂 {os.path.basename(root)}/")
        
        # Stop printing files if we've hit max depth
        if level >= max_depth:
            continue
            
        # Sort files to ensure deterministic output
        files.sort()
        subindent = '│   ' * level + '├── '
        for f in files:
            # Skip hidden files or specific extensions if needed
            if f.startswith('.'):
                continue
            repomap.append(f"{subindent}📄 {f}")
            
    return "\n".join(repomap)

if __name__ == "__main__":
    target = sys.argv[1] if len(sys.argv) > 1 else "."
    depth = int(sys.argv[2]) if len(sys.argv) > 2 else 4
    
    print(f"Generating RepoMap for {target} (Max Depth: {depth})")
    print("=" * 40)
    print(generate_repomap(target, depth))
    print("=" * 40)
