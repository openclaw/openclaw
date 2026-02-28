#!/usr/bin/env python3
"""
github_release_monitor.py — GitHub Releases 모니터 → 텔레그램 지식사랑방 전달

Usage:
  python3 github_release_monitor.py --notify        # 릴리즈 조회 + 텔레그램 전달
  python3 github_release_monitor.py --dry-run       # 조회만 (저장/전달 없음)
  python3 github_release_monitor.py --max-new 1     # 신규 릴리즈 최신 1개만 처리
  python3 github_release_monitor.py --limit 20      # 최근 20개 조회
"""

import argparse
import json
import os
import re
import subprocess
import sys
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from shared.log import make_logger
from shared.llm import llm_chat_direct, DIRECT_DEFAULT_CHAIN
from shared.gateway_guard import guarded_gateway_restart, gateway_preflight_error, get_gateway_status
from shared.telegram import send_dm_chunked, send_group_chunked, RON_TOPIC_ID

REPO = "openclaw/openclaw"
WORKSPACE = Path(os.path.expanduser("~/.openclaw/workspace"))
OUTPUT_DIR = WORKSPACE / "memory" / "github-releases"
PROCESSED_FILE = OUTPUT_DIR / ".processed_releases.json"
LOGS_DIR = WORKSPACE / "logs"
LOG_FILE = LOGS_DIR / "github_release_monitor.log"

log = make_logger(log_file=LOG_FILE)

TRANSLATE_MODELS = list(DIRECT_DEFAULT_CHAIN)
VERSION_RE = re.compile(r"v?(\d+(?:\.\d+)+)")


# ── 한글 요약 ──────────────────────────────────────────────────────

def summarize_release(body):
    """Summarize release notes in Korean, Twitter-style highlights."""
    if not body or not body.strip():
        return ""

    text = body[:3000]

    messages = [
        {"role": "system", "content": (
            "GitHub 릴리즈 노트를 한국어로 요약해주세요.\n\n"
            "규칙:\n"
            "1. 주요 변경사항 3~5개만 선별하여 한줄씩 요약\n"
            "2. 각 항목은 이모지 + 카테고리 + 핵심 내용 형식\n"
            "3. 마지막에 버그 수정이 있으면 한줄로 통합\n"
            "4. 기술 용어(API, CLI, SDK, Gateway 등)는 원문 유지\n"
            "5. 설명 없이 요약만 출력\n\n"
            "예시 출력:\n"
            "🆕 새 Provider — Mistral 지원 추가 (메모리 임베딩 + 음성)\n"
            "⚡ 자동 업데이트 — 패키지 설치용 빌트인 auto-updater (기본 꺼짐)\n"
            "🌏 메모리 검색 — 한국어/일본어/스페인어/아랍어 불용어 필터링\n"
            "🔐 보안 — CLI config 출력에서 민감 정보 자동 마스킹\n"
            "🐛 버그 수정 2건 포함"
        )},
        {"role": "user", "content": text},
    ]

    for attempt in range(2):
        content, model, err = llm_chat_direct(
            messages, TRANSLATE_MODELS, temperature=0.3, max_tokens=800, timeout=120,
        )
        if not content:
            log(f"Summary attempt {attempt + 1} failed: {err}")
            continue
        if len(content) < 50:
            log(f"Summary attempt {attempt + 1} too short: {len(content)} chars, retrying")
            continue
        log(f"Summarized via {model} ({len(text)}→{len(content)} chars)")
        return content

    log(f"Summary failed after retries, using original")
    return body


# ── gh CLI ──────────────────────────────────────────────────────────

def gh_cmd(args):
    """Run gh CLI command and return parsed JSON."""
    cmd = ["gh"] + args
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
        if result.returncode != 0:
            log(f"gh error: {result.stderr.strip()}")
            return None
        return json.loads(result.stdout) if result.stdout.strip() else None
    except (subprocess.TimeoutExpired, json.JSONDecodeError) as e:
        log(f"gh cmd failed: {e}")
        return None


def fetch_releases(limit):
    """Fetch recent releases from GitHub."""
    data = gh_cmd([
        "release", "list", "--repo", REPO,
        "--limit", str(limit),
        "--json", "tagName,name,publishedAt,isDraft,isPrerelease",
    ])
    if not data:
        return []
    # 드래프트 제외
    return [r for r in data if not r.get("isDraft")]


def fetch_release_detail(tag):
    """Fetch release body and URL via gh release view."""
    return gh_cmd([
        "release", "view", tag, "--repo", REPO,
        "--json", "body,url,tagName,name",
    ])


# ── 중복 방지 ───────────────────────────────────────────────────────

def load_processed():
    """Load set of processed release tags."""
    if PROCESSED_FILE.exists():
        try:
            with open(PROCESSED_FILE) as f:
                return set(json.load(f))
        except (json.JSONDecodeError, TypeError):
            return set()
    return set()


def save_processed(tags):
    """Save processed tags (keep last 500)."""
    PROCESSED_FILE.parent.mkdir(parents=True, exist_ok=True)
    recent = sorted(tags)[-500:]
    with open(PROCESSED_FILE, "w") as f:
        json.dump(recent, f, indent=2)


# ── 마크다운 저장 ───────────────────────────────────────────────────

def save_release_md(tag, name, published, body, url):
    """Save release as markdown file with frontmatter."""
    date_str = published[:10] if published else datetime.now().strftime("%Y-%m-%d")
    safe_tag = tag.replace("/", "_")
    filepath = OUTPUT_DIR / f"{date_str}_release_{safe_tag}.md"

    lines = [
        "---",
        f"title: \"{name}\"",
        f"date: {date_str}",
        f"source: github_releases",
        f"repo: {REPO}",
        f"tag: {tag}",
        f"url: \"{url}\"",
        "tags: [release, openclaw]",
        "---",
        "",
        f"# {name} ({tag})",
        "",
    ]
    if body:
        lines.append(body[:3000])
    lines.append("")
    lines.append(f"[전체 릴리즈 노트]({url})")

    filepath.write_text("\n".join(lines), encoding="utf-8")
    log(f"Saved: {filepath.name}")
    return filepath


# ── 자동 업데이트 ──────────────────────────────────────────────────

def get_current_version():
    """Get currently installed OpenClaw version."""
    try:
        result = subprocess.run(
            ["openclaw", "--version"], capture_output=True, text=True, timeout=10,
        )
        return result.stdout.strip() if result.returncode == 0 else ""
    except Exception:
        return ""


def parse_version_tuple(raw):
    """Extract numeric dotted version tuple from version/tag text."""
    if not raw:
        return None
    match = VERSION_RE.search(str(raw).strip())
    if not match:
        return None
    try:
        return tuple(int(part) for part in match.group(1).split("."))
    except ValueError:
        return None


def compare_version_tuples(left, right):
    """Compare two integer-version tuples. Returns -1, 0, 1."""
    if left is None or right is None:
        return 0
    width = max(len(left), len(right))
    lvals = left + (0,) * (width - len(left))
    rvals = right + (0,) * (width - len(right))
    if lvals < rvals:
        return -1
    if lvals > rvals:
        return 1
    return 0


def should_auto_update_tag(tag, current_version):
    """Return (should_update, reason) for stable release tags."""
    tag_v = parse_version_tuple(tag)
    if tag_v is None:
        return False, "tag_version_unparseable"
    cur_v = parse_version_tuple(current_version)
    if cur_v is None:
        # Current version unknown: allow latest stable candidate once.
        return True, "current_version_unknown"
    cmp_result = compare_version_tuples(tag_v, cur_v)
    if cmp_result <= 0:
        return False, f"not_newer_than_current ({tag} <= {current_version})"
    return True, "newer_than_current"


def select_auto_update_candidate(releases, current_version):
    """Pick at most one stable release that is newer than current version."""
    skip_reasons = {}
    for rel in releases:
        if rel.get("isPrerelease"):
            continue
        tag = rel.get("tagName", "")
        should, reason = should_auto_update_tag(tag, current_version)
        if should:
            return tag, skip_reasons
        skip_reasons[tag] = reason
    return "", skip_reasons


def check_update_preconditions():
    """Validate runtime config before attempting package update."""
    status = get_gateway_status(timeout_sec=20)
    err = gateway_preflight_error(status=status)
    if err:
        return False, err
    return True, ""


def run_update(tag):
    """Run openclaw update --yes --json. Returns (success, detail_msg)."""
    before = get_current_version()
    log(f"Auto-update: {before} → {tag}")
    try:
        result = subprocess.run(
            ["openclaw", "update", "--yes", "--json"],
            capture_output=True, text=True, timeout=600,
        )
        after = get_current_version()
        if result.returncode == 0:
            log(f"Update succeeded: {before} → {after}")
            return True, f"{before} → {after}"
        log(f"Update failed (rc={result.returncode}): {result.stderr.strip()[:200]}")
        return False, result.stderr.strip()[:200]
    except subprocess.TimeoutExpired:
        log("Update timed out (600s)")
        return False, "타임아웃 (600초)"
    except Exception as e:
        log(f"Update error: {e}")
        return False, str(e)[:200]


def restart_gateway_after_update(tag):
    """Restart gateway through the shared guarded pathway."""
    result = guarded_gateway_restart(
        reason=f"github_release_monitor:{tag}",
        attempts=2,
        probe_wait_sec=30,
        lock_timeout_sec=120,
    )
    if result.get("ok"):
        return True, result.get("result", "restarted")
    detail = result.get("reason") or result.get("result") or "restart_failed"
    return False, detail


# ── 텔레그램 ─────────────────────────────────────────────────────────

def notify_telegram(tag, name, body, url):
    """Send release summary to Telegram Bot API (그룹 론 토픽 + DM)."""
    # 핵심 요약 생성
    summary_text = summarize_release(body) if body else ""

    summary_lines = [
        f"🦞 *{name}* 출시",
        "",
    ]
    if summary_text:
        summary_lines.append(summary_text)
    summary_lines.extend(["", f"📎 {url}"])
    summary = "\n".join(summary_lines)

    # 론 토픽에 전달
    ok_group = send_group_chunked(
        summary, topic_id=RON_TOPIC_ID, parse_mode="Markdown",
    )
    # DM에도 전달
    ok_dm = send_dm_chunked(summary, parse_mode="Markdown")

    if ok_group or ok_dm:
        log(f"Telegram notification sent for {tag} (group={ok_group}, dm={ok_dm})")
        return True
    log(f"Telegram notification failed for {tag}")
    return False


# ── main ─────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="GitHub Release Monitor → 텔레그램 전달")
    parser.add_argument("--notify", action="store_true", help="텔레그램으로 릴리즈 전달")
    parser.add_argument("--auto-update", action="store_true", help="새 안정 릴리즈 감지 시 자동 업데이트 + DM")
    parser.add_argument("--limit", type=int, default=10, help="조회 릴리즈 수 (기본: 10)")
    parser.add_argument("--max-new", type=int, default=0, help="처리할 신규 릴리즈 최대 개수 (0=전체)")
    parser.add_argument("--dry-run", action="store_true", help="조회만, 저장/전달 없음")
    args = parser.parse_args()

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    LOGS_DIR.mkdir(parents=True, exist_ok=True)

    log(f"Fetching releases from {REPO} (limit={args.limit})")
    releases = fetch_releases(args.limit)
    if not releases:
        log("No releases found")
        result = {"source": "github_releases", "repo": REPO,
                  "collected_at": datetime.now().isoformat(),
                  "status": "ok", "new_releases": 0, "total_processed": 0}
        print(json.dumps(result, ensure_ascii=False))
        return result

    log(f"Found {len(releases)} releases")
    processed = load_processed()
    new_releases = [r for r in releases if r["tagName"] not in processed]

    if not new_releases:
        log("No new releases")
        result = {"source": "github_releases", "repo": REPO,
                  "collected_at": datetime.now().isoformat(),
                  "status": "ok", "new_releases": 0,
                  "total_processed": len(processed)}
        print(json.dumps(result, ensure_ascii=False))
        return result

    # 최신 릴리즈부터 처리해 오래된 태그 재알림/재업데이트를 방지
    new_releases.sort(key=lambda r: r.get("publishedAt", ""), reverse=True)
    if args.auto_update:
        # auto-update 모드에서는 안정 릴리즈를 우선 처리
        stable = [r for r in new_releases if not r.get("isPrerelease")]
        prerelease = [r for r in new_releases if r.get("isPrerelease")]
        new_releases = stable + prerelease
    if args.max_new > 0 and len(new_releases) > args.max_new:
        original_count = len(new_releases)
        skipped = new_releases[args.max_new:]
        log(f"New releases truncated: {original_count} -> {args.max_new} (latest first)")
        if not args.dry_run and skipped:
            # 잘린 백로그를 처리완료로 즉시 기록해 다음 실행에서 과거 태그를 반복 처리하지 않음
            for r in skipped:
                processed.add(r["tagName"])
            save_processed(processed)
            log(f"Backlog marked as processed: {len(skipped)} tags")
        new_releases = new_releases[:args.max_new]

    log(f"New releases: {len(new_releases)}")

    current_version = get_current_version() if args.auto_update else ""
    auto_update_candidate = ""
    auto_update_skip_reasons = {}
    if args.auto_update:
        auto_update_candidate, auto_update_skip_reasons = select_auto_update_candidate(
            new_releases,
            current_version=current_version,
        )
        if auto_update_candidate:
            log(
                "Auto-update candidate selected: "
                f"{auto_update_candidate} (current={current_version or 'unknown'})"
            )
        else:
            log(
                "Auto-update skipped: no stable newer release "
                f"(current={current_version or 'unknown'})"
            )

    if args.dry_run:
        for r in new_releases:
            log(f"  [DRY-RUN] {r['tagName']} — {r['name']} ({r['publishedAt']})")
        result = {"source": "github_releases", "repo": REPO,
                  "collected_at": datetime.now().isoformat(),
                  "status": "dry_run", "new_releases": len(new_releases),
                  "tags": [r["tagName"] for r in new_releases]}
        print(json.dumps(result, ensure_ascii=False))
        return result

    saved = 0
    notified = 0
    updated = 0
    for r in new_releases:
        tag = r["tagName"]
        name = r.get("name", tag)
        published = r.get("publishedAt", "")

        # 상세 정보 가져오기
        detail = fetch_release_detail(tag)
        body = detail.get("body", "") if detail else ""
        url = detail.get("url", f"https://github.com/{REPO}/releases/tag/{tag}") if detail else f"https://github.com/{REPO}/releases/tag/{tag}"

        save_release_md(tag, name, published, body, url)
        saved += 1

        # 태그 단위로 즉시 저장해 중간 실패/타임아웃 시에도 재처리 루프를 방지
        processed.add(tag)
        save_processed(processed)

        if args.notify:
            if notify_telegram(tag, name, body, url):
                notified += 1

        # 안정 릴리즈 자동 업데이트: "현재 버전보다 최신" 1건만 처리 (다운그레이드 방지)
        if args.auto_update and not r.get("isPrerelease"):
            if tag != auto_update_candidate:
                reason = auto_update_skip_reasons.get(tag, "not_selected")
                log(f"Auto-update skipped for {tag}: {reason}")
                continue

            preflight_ok, preflight_reason = check_update_preconditions()
            if not preflight_ok:
                log(f"Auto-update blocked for {tag}: {preflight_reason}")
                send_dm_chunked(
                    f"⛔ *OpenClaw 자동 업데이트 차단*\n\n"
                    f"📦 `{tag}`\n"
                    f"원인: {preflight_reason}\n"
                    f"📎 {url}",
                    parse_mode="Markdown",
                )
                continue

            ok, detail = run_update(tag)
            if ok:
                restart_ok, restart_detail = restart_gateway_after_update(tag)
                if restart_ok:
                    dm_text = (
                        f"✅ *OpenClaw 자동 업데이트 완료*\n\n"
                        f"📦 `{tag}` ({detail})\n"
                        f"🔁 Gateway: {restart_detail}\n"
                        f"📎 {url}"
                    )
                else:
                    dm_text = (
                        f"⚠️ *OpenClaw 업데이트는 완료, Gateway 재시작 실패*\n\n"
                        f"📦 `{tag}` ({detail})\n"
                        f"재시작 오류: {restart_detail}\n"
                        f"📎 {url}"
                    )
                send_dm_chunked(dm_text, parse_mode="Markdown")
                updated += 1
            else:
                send_dm_chunked(
                    f"❌ *OpenClaw 자동 업데이트 실패*\n\n"
                    f"📦 `{tag}`\n"
                    f"원인: {detail}\n"
                    f"📎 {url}",
                    parse_mode="Markdown",
                )

    save_processed(processed)
    log(f"Done: {saved} saved, {notified} notified, {updated} updated")

    result = {"source": "github_releases", "repo": REPO,
              "collected_at": datetime.now().isoformat(),
              "status": "ok", "new_releases": saved,
              "notified": notified, "updated": updated,
              "total_processed": len(processed)}
    print(json.dumps(result, ensure_ascii=False))
    return result


if __name__ == "__main__":
    main()
