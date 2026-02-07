#!/usr/bin/env python3
import os
import sys
import yaml
import argparse
import re

def parse_skill_metadata(skill_path):
    """Parses name and description from SKILL.md frontmatter."""
    skill_md = os.path.join(skill_path, "SKILL.md")
    if not os.path.exists(skill_md):
        return None

    try:
        with open(skill_md, 'r', encoding='utf-8') as f:
            content = f.read()
            
        # Extract YAML frontmatter
        match = re.match(r'^---\s*\n(.*?)\n---\s*\n', content, re.DOTALL)
        if match:
            yaml_content = match.group(1)
            metadata = yaml.safe_load(yaml_content)
            return {
                "name": metadata.get("name", os.path.basename(skill_path)),
                "description": metadata.get("description", "No description provided."),
                "path": skill_md
            }
    except Exception as e:
        # Silently fail on bad parsing to keep search robust
        pass
    
    return None

def search_skills(query, skills_root):
    """Searches skills for the query string."""
    results = []
    query = query.lower()
    
    if not os.path.exists(skills_root):
        print(f"Error: Skills root not found at {skills_root}")
        return []

    for entry in os.scandir(skills_root):
        if entry.is_dir() and not entry.name.startswith('.'):
            metadata = parse_skill_metadata(entry.path)
            if metadata:
                # Score: Name match is prioritized over description
                score = 0
                name_match = query in metadata['name'].lower()
                desc_match = query in metadata['description'].lower()
                
                if name_match:
                    score += 10
                if desc_match:
                    score += 5
                
                if score > 0:
                    results.append((score, metadata))

    # Sort by score descending
    results.sort(key=lambda x: x[0], reverse=True)
    return [r[1] for r in results]

def main():
    parser = argparse.ArgumentParser(description="Search available OpenClaw skills.")
    parser.add_argument("query", help="Search query (keywords)")
    parser.add_argument("--root", default="../..", help="Root skills directory (relative to script)")
    args = parser.parse_args()

    # Resolve absolute path
    # If using typical project structure, ../.. is correct.
    # Allow env var override for robustness in unusual setups.
    env_root = os.getenv("OPENCLAW_SKILLS_ROOT")
    if env_root:
       skills_root = os.path.abspath(env_root)
    else:
       script_dir = os.path.dirname(os.path.abspath(__file__))
       skills_root = os.path.abspath(os.path.join(script_dir, args.root))

    results = search_skills(args.query, skills_root)

    if results:
        print(f"Found {len(results)} matching skills:\n")
        for skill in results:
            print(f"Skill: {skill['name']}")
            print(f"Path: {skill['path']}")
            print(f"Description: {skill['description']}")
            print("-" * 40)
    else:
        print("No matching skills found.")

if __name__ == "__main__":
    main()
