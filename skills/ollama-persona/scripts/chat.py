#!/usr/bin/env python3
"""
Interactive chat session with an Ollama persona model.
Maintains conversation history for multi-turn dialogue.
"""

import argparse
import json
import sys
import urllib.request


def chat(model: str, host: str = "http://localhost:11434"):
    """Run an interactive chat session."""
    history = []
    
    print(f"💬 Chatting with {model} (type 'quit' to exit, 'clear' to reset)")
    print("-" * 50)
    
    while True:
        try:
            user_input = input("\nYou: ").strip()
        except (EOFError, KeyboardInterrupt):
            print("\n👋 Goodbye!")
            break
            
        if not user_input:
            continue
        if user_input.lower() == "quit":
            print("👋 Goodbye!")
            break
        if user_input.lower() == "clear":
            history = []
            print("🧹 History cleared")
            continue
        
        # Build prompt with history
        history.append({"role": "user", "content": user_input})
        
        # Format conversation for context
        conversation = "\n".join([
            f"{'User' if m['role'] == 'user' else 'Assistant'}: {m['content']}"
            for m in history[-10:]  # Keep last 10 exchanges
        ])
        
        prompt = f"{conversation}\nAssistant:"
        
        # Call Ollama
        try:
            data = json.dumps({
                "model": model,
                "prompt": prompt,
                "stream": False
            }).encode()
            
            req = urllib.request.Request(
                f"{host}/api/generate",
                data=data,
                headers={"Content-Type": "application/json"}
            )
            
            with urllib.request.urlopen(req, timeout=60) as resp:
                result = json.loads(resp.read().decode())
                response = result.get("response", "").strip()
                
            if response:
                print(f"\n{model}: {response}")
                history.append({"role": "assistant", "content": response})
            else:
                print("(no response)")
                
        except Exception as e:
            print(f"Error: {e}", file=sys.stderr)
            history.pop()  # Remove failed user message


def main():
    parser = argparse.ArgumentParser(
        description="Interactive chat with Ollama persona"
    )
    parser.add_argument(
        "model",
        help="Name of the Ollama model to chat with"
    )
    parser.add_argument(
        "--host",
        default="http://localhost:11434",
        help="Ollama server URL (default: http://localhost:11434)"
    )
    
    args = parser.parse_args()
    chat(args.model, args.host)


if __name__ == "__main__":
    main()
