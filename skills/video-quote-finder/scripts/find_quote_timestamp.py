#!/usr/bin/env python3
import argparse
import re
import subprocess
import sys
from difflib import SequenceMatcher

TS_LINE = re.compile(r"^\[(\d{1,2}:\d{2}(?::\d{2})?)\]\s*(.*)$")


def ts_to_seconds(ts: str) -> int:
    parts = [int(x) for x in ts.split(':')]
    if len(parts) == 2:
        m, s = parts
        return m * 60 + s
    h, m, s = parts
    return h * 3600 + m * 60 + s


def with_timestamp_url(url: str, ts: str) -> str:
    sec = ts_to_seconds(ts)
    base_url = url.split('#', 1)[0]  # drop fragment so query params are honored
    joiner = '&' if '?' in base_url else '?'
    return f"{base_url}{joiner}t={sec}s"


def run_extract(url: str) -> str:
    cmd = ["summarize", url, "--extract", "--timestamps"]
    p = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True)
    if p.returncode != 0:
        raise RuntimeError(p.stderr.strip() or "summarize failed")
    return p.stdout


def normalize(s: str) -> str:
    return re.sub(r"\s+", " ", s.lower()).strip()


def score(quote: str, line: str) -> float:
    q = normalize(quote)
    l = normalize(line)
    if not q or not l:
        return 0.0
    if q in l:
        return 1.0

    q_words = set(q.split())
    l_words = set(l.split())
    overlap = len(q_words & l_words) / max(1, len(q_words))
    ratio = SequenceMatcher(None, q, l).ratio()
    return 0.6 * overlap + 0.4 * ratio


def find_matches(text: str, quote: str):
    matches = []
    for line in text.splitlines():
        m = TS_LINE.match(line)
        if not m:
            continue
        ts, body = m.group(1), m.group(2)
        s = score(quote, body)
        if s >= 0.35:
            matches.append((s, ts, body))
    matches.sort(key=lambda x: x[0], reverse=True)
    return matches[:5]


def main():
    ap = argparse.ArgumentParser(description="Find quote timestamp in YouTube transcript")
    ap.add_argument("url")
    ap.add_argument("quote")
    args = ap.parse_args()

    try:
        text = run_extract(args.url)
        matches = find_matches(text, args.quote)
    except Exception as e:
        print(f"ERROR: {e}", file=sys.stderr)
        sys.exit(1)

    if not matches:
        print("No matches found. Try a shorter quote fragment.")
        sys.exit(2)

    best = matches[0]
    best_link = with_timestamp_url(args.url, best[1])
    print(f"best_match: [{best[1]}] score={best[0]:.2f} :: {best[2]}")
    print(f"best_link: {best_link}")
    print("candidates:")
    for s, ts, body in matches:
        print(f"- [{ts}] score={s:.2f} :: {body}")
        print(f"  link: {with_timestamp_url(args.url, ts)}")


if __name__ == "__main__":
    main()
