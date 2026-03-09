"""Translate only Korean-containing lines in specified files."""
import json, re, sys, urllib.request

KOREAN_RE = re.compile(r"[\uAC00-\uD7A3\u1100-\u11FF\u3130-\u318F]")
OLLAMA_URL = "http://localhost:11434/api/generate"
MODEL = "qwen2.5:14b"


def translate_line(text: str) -> str:
    prompt = (
        "Translate the Korean parts of this Python source line to English. "
        "Keep all Python syntax, variable names, format markers (%s {var}) intact. "
        "Return ONLY the translated line, nothing else.\n\n" + text
    )
    data = json.dumps({"model": MODEL, "prompt": prompt, "stream": False,
                       "options": {"temperature": 0.1}}).encode()
    req = urllib.request.Request(OLLAMA_URL, data=data,
                                  headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.loads(r.read()).get("response", text).strip()
    except Exception as e:
        print(f"    WARN: {e}", flush=True)
        return text


import os
os.chdir(r"C:\TEST\M.AI.UPbit")

targets = ["app.py", "maiupbit/cli.py", "tests/unit/test_analysis.py"]

for path in targets:
    print(f"\n=== {path} ===", flush=True)
    with open(path, encoding="utf-8", errors="replace") as f:
        lines = f.readlines()

    changed = 0
    new_lines = []
    for i, line in enumerate(lines):
        if not KOREAN_RE.search(line):
            new_lines.append(line)
            continue
        stripped = line.rstrip("\r\n")
        eol = line[len(stripped):]
        translated = translate_line(stripped)
        # Verify translation didn't add extra lines
        if "\n" in translated:
            translated = translated.split("\n")[0]
        new_lines.append(translated + eol)
        if translated != stripped:
            changed += 1
            print(f"  L{i+1}: OK", flush=True)

    with open(path, "w", encoding="utf-8") as f:
        f.writelines(new_lines)
    print(f"  {changed} lines translated", flush=True)

print("\nDone.", flush=True)
