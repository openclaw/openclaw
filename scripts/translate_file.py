import glob, json, re, subprocess, sys, urllib.request, os

os.chdir(r"C:\TEST\M.AI.UPbit")
KOREAN_RE = re.compile(r"[\uAC00-\uD7A3\u1100-\u11FF\u3130-\u318F]")
OLLAMA_URL = "http://localhost:11434/api/generate"
MODEL = "qwen2.5:14b"


def ollama(prompt):
    data = json.dumps({
        "model": MODEL, "prompt": prompt, "stream": False,
        "options": {"temperature": 0.1}
    }).encode()
    req = urllib.request.Request(
        OLLAMA_URL, data=data,
        headers={"Content-Type": "application/json"}
    )
    try:
        with urllib.request.urlopen(req, timeout=180) as r:
            return json.loads(r.read()).get("response", "").strip()
    except Exception as e:
        print(f"  OLLAMA ERR: {e}", flush=True)
        return None


def translate_file(path, content):
    prompt = (
        "Translate ALL Korean comments, docstrings, and string literals to English "
        "in this Python source file.\n"
        "Rules:\n"
        "- Translate: # comments, docstring text, logger messages, string values\n"
        "- Do NOT translate: variable names, function names, class names, import paths\n"
        "- Keep intact: %s %d {var} format markers, coin names (BTC ETH KRW), API keys\n"
        "- Common terms: 매매=trading, 잔고=balance, 지표=indicator, 분석=analysis,\n"
        "  실행=execution, 기록=record, 시즌=season, 돌파=breakout, 모멘텀=momentum,\n"
        "  거래=trade, 주문=order, 가격=price, 종목=symbol, 체크=check, 설정=config\n"
        "Return ONLY the complete translated Python file. No markdown blocks, no explanation.\n\n"
        f"File: {path}\n\n{content}"
    )
    return ollama(prompt)


def syntax_ok(path):
    return subprocess.run(
        [sys.executable, "-m", "py_compile", path],
        capture_output=True
    ).returncode == 0


changed = 0
errors = []
skipped = []

for f in sorted(glob.glob("**/*.py", recursive=True)):
    try:
        c = open(f, encoding="utf-8", errors="replace").read()
    except Exception:
        continue
    if not KOREAN_RE.search(c):
        continue

    print(f"\n=== {f} ===", flush=True)
    tr = translate_file(f, c)

    if not tr:
        skipped.append(f)
        print("  SKIP (no response)", flush=True)
        continue

    # Strip markdown code fences if present
    if "```python" in tr[:20]:
        tr = tr[tr.index("```python") + 9:]
    elif tr.startswith("```"):
        tr = tr[3:]
    if tr.rstrip().endswith("```"):
        tr = tr.rstrip()[:-3]
    tr = tr.strip()

    if not tr:
        print("  BAD RESPONSE - skip", flush=True)
        skipped.append(f)
        continue

    # Save with backup
    with open(f + ".bak", "w", encoding="utf-8") as b:
        b.write(c)
    with open(f, "w", encoding="utf-8") as o:
        o.write(tr)

    if syntax_ok(f):
        print("  OK", flush=True)
        changed += 1
    else:
        print("  SYNTAX ERR - reverting", flush=True)
        os.replace(f + ".bak", f)
        errors.append(f)

    if os.path.exists(f + ".bak"):
        os.remove(f + ".bak")

print(f"\nDone: {changed} files changed", flush=True)
if errors:
    print(f"Syntax errors (reverted): {errors}", flush=True)
if skipped:
    print(f"Skipped: {skipped}", flush=True)
