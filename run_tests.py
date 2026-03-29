#!/usr/bin/env python3
"""Test Ollama models for code generation capability."""

import json
import subprocess
import sys

PROMPT = """Write a simple Python hello world program. Output ONLY the code, no explanation."""


def test_model(model: str) -> dict:
    """Test a single model with exponential backoff for timeouts."""
    result = {
        "model": model,
        "success": False,
        "output": "",
        "error": None,
        "has_print": False,
    }

    # Exponential backoff timeouts: 60s, 120s, 240s, 480s, 600s (max ~10min)
    timeouts = [60, 120, 240, 480, 600]

    for timeout in timeouts:
        try:
            proc = subprocess.run(
                [
                    "curl",
                    "-s",
                    "http://localhost:11434/api/chat",
                    "-d",
                    json.dumps(
                        {
                            "model": model,
                            "messages": [{"role": "user", "content": PROMPT}],
                            "stream": False,
                            "options": {"num_predict": 200},
                        }
                    ),
                ],
                capture_output=True,
                text=True,
                timeout=timeout,
            )
        except subprocess.TimeoutExpired:
            if timeout == 600:
                result["error"] = "timeout after 10min max"
                return result
            continue

        if proc.returncode != 0:
            result["error"] = f"curl failed: {proc.stderr}"
            return result

        try:
            data = json.loads(proc.stdout)
            output = data.get("message", {}).get("content", "").strip()
            result["output"] = output

            # Check if it generated valid-looking Python code
            if "print(" in output and "hello" in output.lower():
                result["success"] = True
                result["has_print"] = True
            elif "def " in output and "hello" in output.lower():
                result["success"] = True
        except json.JSONDecodeError as e:
            result["error"] = f"json error: {e}"
            return result

        return result

    return result


def main():
    # Get models with sizes
    proc = subprocess.run(
        ["curl", "-s", "http://localhost:11434/api/tags"], capture_output=True, text=True
    )
    data = json.loads(proc.stdout)
    models_with_size = [(m["name"], m.get("size", 0)) for m in data.get("models", [])]

    # Sort by size (smallest first)
    models_with_size.sort(key=lambda x: x[1])
    models = [m[0] for m in models_with_size]

    print(f"Testing {len(models)} models (smallest to largest)...", flush=True)
    print("-" * 60, flush=True)

    success_count = 0
    for model in models:
        result = test_model(model)
        status = "PASS" if result["success"] else "FAIL"
        print(f"{status:4} {model}", flush=True)

        if result["success"]:
            success_count += 1
            # Show snippet
            snippet = result["output"][:80].replace("\n", " ")
            print(f"      → {snippet}...", flush=True)

        if result["error"]:
            print(f"      → error: {result['error']}", flush=True)

    print("-" * 60, flush=True)
    print(f"Success: {success_count}/{len(models)}", flush=True)


if __name__ == "__main__":
    main()
