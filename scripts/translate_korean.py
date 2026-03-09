import glob, json, re, subprocess, sys, urllib.request

KOREAN_RE = re.compile(r"[\uAC00-\uD7A3\u1100-\u11FF\u3130-\u318F]")
OLLAMA_URL = "http://localhost:11434/api/generate"
MODEL = "qwen2.5:14b"

def translate(text):
    prompt = (
        "Translate this Korean Python comment/string to English. "
        "Return ONLY the English translation, no explanation.\n\n" + text
    )
    payload = json.dumps({"model": MODEL, "prompt": prompt, "stream": False}).encode()
    req = urllib.request.Request(OLLAMA_URL, data=payload, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return json.loads(resp.read()).get("response", text).strip()
    except Exception as e:
        print(f"    WARN: {e}", file=sys.stderr)
        return text

def translate_file(path):
    with open(path, encoding="utf-8", errors="replace") as f:
        lines = f.readlines()
    new_lines = []
    changed = 0
    for i, line in enumerate(lines):
        if not KOREAN_RE.search(line):
            new_lines.append(line)
            continue
        stripped = line.rstrip("\r\n")
        eol = line[len(stripped):]
        content = stripped.lstrip()
        indent = stripped[:len(stripped)-len(content)]
        if content.startswith("#"):
            after_hash = content[1:].strip()
            if KOREAN_RE.search(after_hash):
                tr = translate(after_hash)
                new_lines.append(indent + "# " + tr + eol)
                changed += 1
                print(f"  L{i+1} comment: {after_hash[:40]!r} -> {tr[:40]!r}")
                continue
        # inline Korean in string/logger: replace korean segments
        def repl(m):
            seg = m.group(0).strip()
            if not seg or not KOREAN_RE.search(seg):
                return m.group(0)
            tr = translate(seg)
            return m.group(0).replace(seg, tr)
        new_stripped = re.sub(
            r"[\uAC00-\uD7A3\u1100-\u11FF\u3130-\u318F][^\x00-\x7F\"\'\n\r]*",
            repl, stripped
        )
        new_lines.append(new_stripped + eol)
        if new_stripped != stripped:
            changed += 1
            print(f"  L{i+1} string: translated")
        else:
            new_lines[-1] = line  # no change
    if changed > 0:
        with open(path, "w", encoding="utf-8") as f:
            f.writelines(new_lines)
    return changed

def check_syntax(path):
    r = subprocess.run([sys.executable, "-m", "py_compile", path], capture_output=True)
    return r.returncode == 0

import os
os.chdir(r"C:\TEST\M.AI.UPbit")
files = sorted(glob.glob("**/*.py", recursive=True))
total = 0
errors = []
for f in files:
    try:
        content = open(f, encoding="utf-8", errors="replace").read()
    except:
        continue
    if not KOREAN_RE.search(content):
        continue
    print(f"\n=== {f} ===")
    changed = translate_file(f)
    total += changed
    if not check_syntax(f):
        print(f"  [SYNTAX ERROR]")
        errors.append(f)
    else:
        print(f"  OK: {changed} lines changed")

print(f"\nDone. Total lines changed: {total}")
if errors:
    print(f"Syntax errors: {errors}")
else:
    print("All syntax checks passed.")
