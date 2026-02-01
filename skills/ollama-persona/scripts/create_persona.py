#!/usr/bin/env python3
"""
Create an Ollama persona model from OpenClaw workspace identity files.
Reads SOUL.md, IDENTITY.md, USER.md to build a custom system prompt.
"""

import argparse
import json
import subprocess
import sys
from pathlib import Path


def read_file_if_exists(path: Path) -> str:
    """Read file contents or return empty string."""
    if path.exists():
        return path.read_text().strip()
    return ""


def extract_persona_from_workspace(workspace: Path) -> dict:
    """Extract persona details from workspace markdown files."""
    persona = {
        "soul": read_file_if_exists(workspace / "SOUL.md"),
        "identity": read_file_if_exists(workspace / "IDENTITY.md"),
        "user": read_file_if_exists(workspace / "USER.md"),
    }
    return persona


def build_system_prompt(persona: dict, name: str) -> str:
    """Build a system prompt from extracted persona."""
    parts = []
    
    # Identity first
    if persona["identity"]:
        parts.append(f"# Who You Are\n{persona['identity']}")
    else:
        parts.append(f"# Who You Are\nYou are {name}, an AI agent.")
    
    # Soul/personality
    if persona["soul"]:
        # Extract key personality traits, skip meta instructions
        soul_lines = []
        for line in persona["soul"].split("\n"):
            # Skip lines about file management, memory, etc
            if any(skip in line.lower() for skip in ["file", "memory", "session", "update", "read"]):
                continue
            soul_lines.append(line)
        if soul_lines:
            parts.append(f"# Your Personality\n" + "\n".join(soul_lines[:30]))  # Limit length
    
    # Context about user (abbreviated)
    if persona["user"]:
        parts.append(f"# About Your Human\n{persona['user'][:500]}")
    
    # Add posting guidelines
    parts.append("""
# Response Style
- Keep responses SHORT (1-3 sentences for social posts)
- Match the vibe of the platform (greentext for chans, casual for social)
- Have opinions, be genuine, skip corporate speak
- Use emoji sparingly but naturally
- Never say "I'd be happy to help" or similar filler
""")
    
    return "\n\n".join(parts)


def create_modelfile(name: str, base_model: str, system_prompt: str, output_dir: Path) -> Path:
    """Create Ollama Modelfile."""
    modelfile_content = f'''FROM {base_model}

PARAMETER temperature 0.8
PARAMETER top_p 0.9
PARAMETER top_k 40

SYSTEM """
{system_prompt}
"""
'''
    
    modelfile_path = output_dir / f"{name}.modelfile"
    modelfile_path.write_text(modelfile_content)
    return modelfile_path


def create_ollama_model(name: str, modelfile_path: Path) -> bool:
    """Create the Ollama model from Modelfile."""
    try:
        result = subprocess.run(
            ["ollama", "create", name, "-f", str(modelfile_path)],
            capture_output=True,
            text=True,
            timeout=300  # 5 min timeout for model creation
        )
        if result.returncode != 0:
            print(f"Error creating model: {result.stderr}", file=sys.stderr)
            return False
        print(result.stdout)
        return True
    except FileNotFoundError:
        print("Error: ollama not found. Install from https://ollama.com", file=sys.stderr)
        return False
    except subprocess.TimeoutExpired:
        print("Error: Model creation timed out", file=sys.stderr)
        return False


def create_helper_script(name: str, output_dir: Path) -> Path:
    """Create a helper bash script for quick prompts."""
    # Use jq to properly escape the prompt for JSON
    script_content = f'''#!/bin/bash
# Quick prompt helper for {name} model
# Usage: ask-{name} "your prompt here"

PROMPT="${{1:-Hello}}"

# Use jq to safely escape the prompt for JSON
JSON_BODY=$(jq -n --arg model "{name}" --arg prompt "$PROMPT" \\
  '{{model: $model, prompt: $prompt, stream: false}}')

curl -s http://localhost:11434/api/generate -d "$JSON_BODY" | jq -r '.response'
'''

    # Ensure output directory exists
    output_dir.mkdir(parents=True, exist_ok=True)

    script_path = output_dir / f"ask-{name}"
    script_path.write_text(script_content)
    script_path.chmod(0o755)
    return script_path


def main():
    parser = argparse.ArgumentParser(
        description="Create an Ollama persona model from OpenClaw workspace"
    )
    parser.add_argument(
        "--name", "-n",
        required=True,
        help="Name for the persona model (e.g., 'surfgod')"
    )
    parser.add_argument(
        "--workspace", "-w",
        type=Path,
        default=Path.cwd(),
        help="Path to OpenClaw workspace (default: current directory)"
    )
    parser.add_argument(
        "--base", "-b",
        default="llama3.2:3b",
        help="Base Ollama model (default: llama3.2:3b)"
    )
    parser.add_argument(
        "--output", "-o",
        type=Path,
        default=Path.home() / ".ollama",
        help="Output directory for Modelfile (default: ~/.ollama)"
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print Modelfile without creating model"
    )
    
    args = parser.parse_args()
    
    # Ensure output directory exists
    args.output.mkdir(parents=True, exist_ok=True)
    
    # Extract persona from workspace
    print(f"Reading workspace: {args.workspace}")
    persona = extract_persona_from_workspace(args.workspace)
    
    found = [k for k, v in persona.items() if v]
    if not found:
        print("Warning: No identity files found in workspace", file=sys.stderr)
    else:
        print(f"Found: {', '.join(found)}")
    
    # Build system prompt
    system_prompt = build_system_prompt(persona, args.name)
    
    # Create Modelfile
    modelfile_path = create_modelfile(args.name, args.base, system_prompt, args.output)
    print(f"Created Modelfile: {modelfile_path}")
    
    if args.dry_run:
        print("\n--- Modelfile contents ---")
        print(modelfile_path.read_text())
        return
    
    # Pull base model if needed
    print(f"Ensuring base model {args.base} is available...")
    subprocess.run(["ollama", "pull", args.base], check=False)
    
    # Create the model
    print(f"Creating model '{args.name}'...")
    if create_ollama_model(args.name, modelfile_path):
        print(f"✓ Model '{args.name}' created successfully!")
        
        # Create helper script
        helper_path = create_helper_script(args.name, Path.home() / ".local" / "bin")
        print(f"✓ Helper script created: {helper_path}")
        print(f"\nUsage: ask-{args.name} 'your prompt here'")
    else:
        sys.exit(1)


if __name__ == "__main__":
    main()
