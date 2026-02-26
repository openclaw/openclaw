#!/usr/bin/env python3
import csv
import re
import sys
from pathlib import Path

if len(sys.argv) < 2:
    print("Usage: extract_gateway_urls.py <gateway_tail.log> [output.csv]", file=sys.stderr)
    sys.exit(2)

log_path = Path(sys.argv[1])
out_path = Path(sys.argv[2]) if len(sys.argv) > 2 else log_path.with_suffix('.csv')

if not log_path.exists():
    print(f"Missing log file: {log_path}", file=sys.stderr)
    sys.exit(1)

# Matches:
# Web Fetch
# from https://... (max 3000 chars)
fetch_from_re = re.compile(r"^from\s+(https?://\S+)")
# JSON snippets: "url": "...", "status": 200
url_re = re.compile(r'"url"\s*:\s*"(https?://[^"\\]+)"')
status_re = re.compile(r'"status"\s*:\s*(\d{3})')

rows = []
current = {"source": "", "url": "", "status": "", "title": "", "closed": "", "cookie_shell": ""}
collect_json = False
json_buf = []

for raw in log_path.read_text(errors='ignore').splitlines():
    line = raw.strip()

    # Tool block marker lines often look like: "Web Fetch" or "Web Search"
    if line == "Web Fetch":
        current = {"source": "web_fetch", "url": "", "status": "", "title": "", "closed": "", "cookie_shell": ""}
        collect_json = False
        json_buf = []
        continue
    if line == "Web Search":
        current = {"source": "web_search", "url": "", "status": "", "title": "", "closed": "", "cookie_shell": ""}
        collect_json = False
        json_buf = []
        continue

    # Capture one-line fetch source URL line.
    m = fetch_from_re.search(line)
    if m and current.get("source") == "web_fetch":
        current["url"] = m.group(1)
        continue

    # Detect start/end of JSON-ish payloads in pasted logs.
    if line.startswith("{"):
        collect_json = True
        json_buf = [line]
        continue
    if collect_json:
        json_buf.append(line)
        if line.endswith("}"):
            blob = " ".join(json_buf)
            collect_json = False

            u = url_re.search(blob)
            s = status_re.search(blob)
            if u:
                current["url"] = current["url"] or u.group(1)
            if s:
                current["status"] = s.group(1)

            # Lightweight flags from extracted text/title in blob
            title_closed = "You can no longer apply" in blob
            cookie_shell = "Cookies on Find an apprenticeship" in blob
            current["closed"] = "yes" if title_closed else "no"
            current["cookie_shell"] = "yes" if cookie_shell else "no"

            # Keep a short title if present
            t_match = re.search(r'"title"\s*:\s*"([^"]{1,180})"', blob)
            if t_match:
                current["title"] = t_match.group(1)

            # Persist a row when we have at least URL or status
            if current["url"] or current["status"]:
                rows.append(current.copy())
                current = {"source": "", "url": "", "status": "", "title": "", "closed": "", "cookie_shell": ""}

# Deduplicate by (source,url,status)
seen = set()
uniq = []
for r in rows:
    key = (r.get("source",""), r.get("url",""), r.get("status",""))
    if key in seen:
        continue
    seen.add(key)
    uniq.append(r)

with out_path.open('w', newline='', encoding='utf-8') as f:
    w = csv.DictWriter(f, fieldnames=["source", "url", "status", "closed", "cookie_shell", "title"])
    w.writeheader()
    w.writerows(uniq)

print(f"Wrote {len(uniq)} rows -> {out_path}")
