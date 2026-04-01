#!/usr/bin/env python3
"""OpenClaw harness utilities inspired by Claude-style workflow scaffolding.

This script turns the workspace protocol into runnable local helpers:

- session-context: assemble context in bootstrap order
- route: triage an incoming request to the right role
- permission: classify action risk with simple guardrails
- verify-report: lint a completion report for verification hygiene
- extract-memory: pull stable facts and preferences out of conversation text
- recall-memory: search layered memory files with lightweight scoring
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shlex
import string
import subprocess
import sys
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any


CONTEXT_FILES = [
    "context/SESSION_PROTOCOL.md",
    "context/PERMISSIONS.md",
    "context/CHANNEL_POLICIES.md",
    "context/VERIFICATION.md",
    "context/MODEL_ROUTING.md",
]

REPORT_SECTIONS = [
    "Verified",
    "Not verified",
    "Risks",
    "Recommended next step",
]

COMPACTION_FIELDS = [
    "Goal",
    "Decisions",
    "Verified facts",
    "Failed attempts",
    "Current blocker",
    "Next exact step",
    "Key files",
]

CLOSURE_FIELDS = [
    "Verified",
    "Not verified",
    "Risks",
    "Recommended next step",
]

MEMORY_SEARCH_FILES = [
    "memory/current-task.md",
    "memory/preferences.json",
    "memory/facts.json",
    "MEMORY.md",
]

DREAM_PREFERENCE_MARKERS = (
    "默认",
    "优先",
    "不要",
    "别",
    "固定",
    "习惯",
    "风格",
    "长期",
    "规则",
    "以后",
)

DREAM_FACT_MARKERS = (
    "已配置",
    "网址",
    "网站",
    "地址",
    "城市",
    "工作",
    "称呼",
    "用户名",
    "主题",
    "路径",
    "时间",
)

ROLE_AGENT_DEFAULTS = {
    "coordinator": "main",
    "Explore": "main",
    "Plan": "main",
    "general-purpose": "main",
    "Verification": "main",
    "main": "main",
}

ROLE_THINKING_DEFAULTS = {
    "coordinator": "low",
    "Explore": "low",
    "Plan": "medium",
    "general-purpose": "medium",
    "Verification": "high",
    "main": "low",
}


@dataclass(frozen=True)
class MatchGroup:
    name: str
    patterns: tuple[str, ...]


ROUTE_GROUPS = [
    MatchGroup(
        "verification",
        (
            r"\bverify\b",
            r"\bvalidation\b",
            r"\btest\b",
            r"验收",
            r"验证",
            r"确认(一下)?(有没有|是否)?成功",
            r"能不能用",
            r"过一遍",
        ),
    ),
    MatchGroup(
        "review",
        (
            r"\breview\b",
            r"审查",
            r"复查",
            r"检查.*风险",
            r"有没有问题",
            r"是否冲突",
            r"把关",
        ),
    ),
    MatchGroup(
        "synthesis",
        (
            r"汇总",
            r"总结成",
            r"整理成稿",
            r"最终建议",
            r"最后给我",
            r"统一输出",
        ),
    ),
    MatchGroup(
        "code_exploration",
        (
            r"代码库",
            r"哪个文件",
            r"搜索代码",
            r"查.*代码",
            r"\bgrep\b",
            r"\brg\b",
            r"find file",
            r"where is",
            r"pattern",
        ),
    ),
    MatchGroup(
        "data_query",
        (
            r"价格",
            r"行情",
            r"赛程",
            r"赔率",
            r"新闻",
            r"数据",
            r"排名",
            r"天气",
            r"ETH",
            r"比赛",
        ),
    ),
    MatchGroup(
        "complex_task",
        (
            r"先.*再",
            r"然后",
            r"并且",
            r"拆解",
            r"规划",
            r"搭建",
            r"集成",
            r"修复",
            r"优化",
            r"自动化",
            r"继续之前",
        ),
    ),
    MatchGroup(
        "direct_answer",
        (
            r"^\s*(ok|okay|好的|行|嗯|记住|收到|谢谢|在吗)\s*$",
            r"^\s*(hi|hello|你好)\s*$",
        ),
    ),
]

RISK_GROUPS = [
    MatchGroup(
        "L3",
        (
            r"泄露.*(密钥|token|秘钥|密码)",
            r"(密钥|token|秘钥|密码).*(泄露|外发|发送)",
            r"(绕过|bypass).*(安全|限制|权限)",
            r"(木马|病毒|勒索|恶意软件)",
            r"(盗号|窃取|偷取).*(账号|数据|cookie)",
            r"违法",
        ),
    ),
    MatchGroup(
        "L2",
        (
            r"发送",
            r"publish",
            r"发布",
            r"重启",
            r"restart",
            r"安装",
            r"install",
            r"升级",
            r"update",
            r"删除",
            r"\brm\b",
            r"交易",
            r"buy",
            r"sell",
            r"下单",
            r"对外",
            r"发给",
        ),
    ),
    MatchGroup(
        "L1",
        (
            r"编辑",
            r"修改",
            r"写入",
            r"创建",
            r"生成文件",
            r"update file",
            r"local",
            r"workspace",
        ),
    ),
    MatchGroup(
        "L0",
        (
            r"读取",
            r"查看",
            r"搜索",
            r"总结",
            r"解释",
            r"列出",
            r"status",
            r"diff",
            r"show",
        ),
    ),
]


def read_text(path: Path) -> str | None:
    if not path.exists():
        return None
    return path.read_text(encoding="utf-8")


def read_json(path: Path) -> Any:
    if not path.exists():
        return None
    return json.loads(path.read_text(encoding="utf-8"))


def read_env_file(path: Path) -> dict[str, str]:
    if not path.exists():
        return {}
    values: dict[str, str] = {}
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        if not key:
            continue
        cleaned = value.strip()
        if len(cleaned) >= 2 and cleaned[0] == cleaned[-1] and cleaned[0] in {"'", '"'}:
            cleaned = cleaned[1:-1]
        values[key] = cleaned
    return values


def parse_text_signature(raw: str | None) -> dict[str, Any]:
    if not raw:
        return {}
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        return {}
    return parsed if isinstance(parsed, dict) else {}


def is_approval_text(text: str | None) -> bool:
    if not text:
        return False
    stripped = text.strip()
    if not stripped:
        return False
    lowered = stripped.lower()
    if re.search(r"(?m)^\s*/approve\s+\S+", stripped):
        nonempty_lines = [line.strip() for line in stripped.splitlines() if line.strip()]
        if nonempty_lines and all(line.startswith("/approve ") for line in nonempty_lines):
            return True
        approval_markers = (
            "approval required",
            "reply with:",
            "请回复",
            "批准",
            "审批",
            "allow-once",
            "allow-always",
        )
        if any(marker in lowered for marker in approval_markers):
            return True
    return False


def date_candidates(today: date, recent_days: int) -> list[Path]:
    return [
        Path("memory") / f"{(today - timedelta(days=offset)).isoformat()}.md"
        for offset in range(recent_days)
    ]


def build_session_context(workspace: Path, mode: str, recent_days: int) -> dict[str, Any]:
    today = date.today()
    core_paths = [
        Path("SOUL.md"),
        Path("USER.md"),
        Path("memory/current-task.md"),
        Path("memory/preferences.json"),
        Path("memory/facts.json"),
    ]
    file_order = core_paths + date_candidates(today, recent_days) + [Path(p) for p in CONTEXT_FILES]
    if mode == "main":
        file_order.append(Path("MEMORY.md"))

    files = []
    for rel_path in file_order:
        abs_path = workspace / rel_path
        entry: dict[str, Any] = {
            "path": str(rel_path),
            "exists": abs_path.exists(),
            "kind": "json" if rel_path.suffix == ".json" else "markdown",
        }
        if abs_path.exists():
            if rel_path.suffix == ".json":
                entry["content"] = read_json(abs_path)
            else:
                entry["content"] = read_text(abs_path)
        files.append(entry)

    return {
        "workspace": str(workspace),
        "mode": mode,
        "generated_at": datetime.now().isoformat(timespec="seconds"),
        "bootstrap_order": [entry["path"] for entry in files],
        "files": files,
    }


def normalize_line(line: str) -> str:
    return re.sub(r"\s+", " ", line.strip())


def is_placeholder_value(text: str | None) -> bool:
    if text is None:
        return True
    stripped = normalize_line(text).strip("`").strip()
    if not stripped:
        return True
    lowered = stripped.lower()
    if lowered in {"_missing_", "_none_"}:
        return True
    if re.search(r":\s*(_missing_|_none_)\s*$", lowered):
        return True
    return False


def clean_memory_line(line: str) -> str | None:
    cleaned = normalize_line(line)
    if not cleaned:
        return None
    if cleaned.startswith("```"):
        return None
    lowered = cleaned.lower()
    if is_approval_text(cleaned):
        return None
    if any(
        marker in lowered
        for marker in (
            "approval required",
            "reply with:",
            "allow-once",
            "allow-always",
            "mode: foreground",
            "background mode requires",
            "host:",
            "cwd:",
            "command:",
        )
    ):
        return None
    section_match = re.match(
        r"^(?:[-*]\s*)?(Verified|Not verified|Risks|Recommended next step|Goal)\s*:\s*(.+)$",
        cleaned,
        flags=re.IGNORECASE,
    )
    if section_match:
        label = section_match.group(1).lower()
        value = section_match.group(2).strip()
        if label == "goal" or is_placeholder_value(value):
            return None
        if label == "recommended next step":
            cleaned = f"next step: {value}"
        else:
            cleaned = value
    if is_placeholder_value(cleaned):
        return None
    return cleaned


def extract_memory_payload(text: str) -> dict[str, Any]:
    lines = [clean_memory_line(line) for line in text.splitlines()]
    lines = [line for line in lines if line]
    preference_markers = ("喜欢", "优先", "默认", "不要", "别", "习惯", "风格", "倾向", "回复要", "以后")
    fact_markers = ("是", "位于", "当前", "已配置", "路径", "网址", "网站", "账号", "价格", "时间", "城市", "工作", "规则")
    task_markers = (
        "先",
        "继续",
        "下一步",
        "next step",
        "recommended next step",
        "follow-up",
        "要做",
        "处理",
        "修复",
        "优化",
        "实现",
        "补",
        "接入",
        "unfinished edges",
    )

    preferences: list[str] = []
    facts: list[str] = []
    tasks: list[str] = []
    urls: list[str] = []

    for line in lines:
        if any(marker in line for marker in preference_markers):
            preferences.append(line)
        if any(marker in line for marker in fact_markers) or re.search(r"https?://", line):
            facts.append(line)
        if any(marker in line for marker in task_markers):
            tasks.append(line)
        urls.extend(re.findall(r"https?://\S+", line))

    if not facts and lines:
        facts = lines[:2]

    summary_parts = []
    if facts:
        summary_parts.append(f"facts:{len(facts)}")
    if preferences:
        summary_parts.append(f"preferences:{len(preferences)}")
    if tasks:
        summary_parts.append(f"tasks:{len(tasks)}")
    summary = "auto-memory capture " + ", ".join(summary_parts or ["empty"])

    def dedupe(values: list[str]) -> list[str]:
        output: list[str] = []
        for value in values:
            if value not in output:
                output.append(value)
        return output

    return {
        "summary": summary,
        "facts": dedupe(facts)[:12],
        "preferences": dedupe(preferences)[:12],
        "tasks": dedupe(tasks)[:12],
        "urls": dedupe(urls)[:12],
    }


def _ensure_parent(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)


def _append_unique(items: list[str], new_items: list[str]) -> list[str]:
    merged = items[:]
    for item in new_items:
        if item not in merged:
            merged.append(item)
    return merged


def _update_json_file(path: Path, updater) -> Any:
    data: Any
    if path.exists():
        data = json.loads(path.read_text(encoding="utf-8"))
    else:
        data = {}
    updated = updater(data)
    _ensure_parent(path)
    path.write_text(json.dumps(updated, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return updated


def apply_memory_capture(workspace: Path, payload: dict[str, Any]) -> dict[str, Any]:
    today_path = workspace / "memory" / f"{date.today().isoformat()}.md"
    now_label = datetime.now().strftime("%H:%M")
    note_lines = [
        f"## Auto Memory Capture {now_label}",
        f"- Summary: {payload['summary']}",
    ]
    if payload["facts"]:
        note_lines.append("- Facts:")
        note_lines.extend([f"  - {item}" for item in payload["facts"]])
    if payload["preferences"]:
        note_lines.append("- Preferences:")
        note_lines.extend([f"  - {item}" for item in payload["preferences"]])
    if payload["tasks"]:
        note_lines.append("- Tasks:")
        note_lines.extend([f"  - {item}" for item in payload["tasks"]])
    if payload["urls"]:
        note_lines.append("- URLs:")
        note_lines.extend([f"  - {item}" for item in payload["urls"]])
    note_block = "\n".join(note_lines) + "\n\n"
    _ensure_parent(today_path)
    existing_note = today_path.read_text(encoding="utf-8") if today_path.exists() else f"# {date.today().isoformat()}\n\n"
    today_path.write_text(existing_note.rstrip() + "\n\n" + note_block, encoding="utf-8")

    facts_path = workspace / "memory/facts.json"
    preferences_path = workspace / "memory/preferences.json"

    _update_json_file(
        facts_path,
        lambda data: {
            **data,
            "auto_memory": {
                **(data.get("auto_memory", {}) if isinstance(data, dict) else {}),
                "last_capture_at": datetime.now().isoformat(timespec="seconds"),
                "captured_facts": _append_unique(
                    list((data.get("auto_memory", {}) if isinstance(data, dict) else {}).get("captured_facts", [])),
                    payload["facts"],
                ),
                "captured_tasks": _append_unique(
                    list((data.get("auto_memory", {}) if isinstance(data, dict) else {}).get("captured_tasks", [])),
                    payload["tasks"],
                ),
                "captured_urls": _append_unique(
                    list((data.get("auto_memory", {}) if isinstance(data, dict) else {}).get("captured_urls", [])),
                    payload["urls"],
                ),
            },
        },
    )
    _update_json_file(
        preferences_path,
        lambda data: {
            **data,
            "auto_memory": {
                **(data.get("auto_memory", {}) if isinstance(data, dict) else {}),
                "last_capture_at": datetime.now().isoformat(timespec="seconds"),
                "captured_preferences": _append_unique(
                    list((data.get("auto_memory", {}) if isinstance(data, dict) else {}).get("captured_preferences", [])),
                    payload["preferences"],
                ),
            },
        },
    )

    return {
        "applied": True,
        "daily_note": str(today_path),
        "facts_file": str(facts_path),
        "preferences_file": str(preferences_path),
    }


def run_auto_memory_turn(workspace: Path, text: str, min_items: int, apply: bool) -> dict[str, Any]:
    if is_approval_text(text):
        result = {
            "summary": "auto-memory capture skipped: approval prompt",
            "facts": [],
            "preferences": [],
            "tasks": [],
            "urls": [],
            "counts": {
                "facts": 0,
                "preferences": 0,
                "tasks": 0,
                "urls": 0,
            },
            "total_items": 0,
            "buckets_with_signal": 0,
            "min_items": min_items,
            "recommended_apply": False,
        }
        if apply:
            result["apply_skipped_reason"] = "approval_prompt"
        return result

    payload = extract_memory_payload(text)
    counts = {
        "facts": len(payload["facts"]),
        "preferences": len(payload["preferences"]),
        "tasks": len(payload["tasks"]),
        "urls": len(payload["urls"]),
    }
    total_items = sum(counts.values())
    buckets_with_signal = sum(1 for key in ("facts", "preferences", "tasks") if counts[key] > 0)
    recommended_apply = total_items >= min_items and buckets_with_signal >= 1
    result = {
        **payload,
        "counts": counts,
        "total_items": total_items,
        "buckets_with_signal": buckets_with_signal,
        "min_items": min_items,
        "recommended_apply": recommended_apply,
    }
    if apply:
        if recommended_apply:
            result["apply_result"] = apply_memory_capture(workspace, payload)
        else:
            result["apply_skipped_reason"] = "below_threshold"
    return result


def render_extract_memory_markdown(payload: dict[str, Any]) -> str:
    lines = [
        "# Memory Extraction",
        "",
        f"- Summary: {payload['summary']}",
        "- Facts:",
    ]
    lines.extend([f"  - {item}" for item in payload["facts"]] or ["  - `_none_`"])
    lines.append("- Preferences:")
    lines.extend([f"  - {item}" for item in payload["preferences"]] or ["  - `_none_`"])
    lines.append("- Tasks:")
    lines.extend([f"  - {item}" for item in payload["tasks"]] or ["  - `_none_`"])
    lines.append("- URLs:")
    lines.extend([f"  - {item}" for item in payload["urls"]] or ["  - `_none_`"])
    if "apply_result" in payload:
        lines.append("- Apply result:")
        for key, value in payload["apply_result"].items():
            lines.append(f"  - {key}: `{value}`")
    return "\n".join(lines) + "\n"


def render_auto_memory_turn_markdown(payload: dict[str, Any]) -> str:
    lines = [
        "# Auto Memory Turn",
        "",
        f"- Summary: {payload['summary']}",
        f"- Recommended apply: `{str(payload['recommended_apply']).lower()}`",
        f"- Total items: `{payload['total_items']}`",
        f"- Buckets with signal: `{payload['buckets_with_signal']}`",
        f"- Min items: `{payload['min_items']}`",
        "- Counts:",
    ]
    for key, value in payload["counts"].items():
        lines.append(f"  - `{key}`: `{value}`")
    lines.append("- Facts:")
    lines.extend([f"  - {item}" for item in payload["facts"]] or ["  - `_none_`"])
    lines.append("- Preferences:")
    lines.extend([f"  - {item}" for item in payload["preferences"]] or ["  - `_none_`"])
    lines.append("- Tasks:")
    lines.extend([f"  - {item}" for item in payload["tasks"]] or ["  - `_none_`"])
    if "apply_result" in payload:
        lines.append("- Apply result:")
        for key, value in payload["apply_result"].items():
            lines.append(f"  - {key}: `{value}`")
    if "apply_skipped_reason" in payload:
        lines.append(f"- Apply skipped: `{payload['apply_skipped_reason']}`")
    return "\n".join(lines) + "\n"


def search_blob(text: str, query_words: list[str]) -> tuple[int, list[str]]:
    matches: list[str] = []
    lowered = text.lower()
    score = 0
    for word in query_words:
        if word and word in lowered:
            score += 3
    for line in text.splitlines():
        normalized = normalize_line(line)
        if not normalized:
            continue
        line_lower = normalized.lower()
        if any(word in line_lower for word in query_words if word):
            matches.append(normalized)
    deduped = []
    for line in matches:
        if line not in deduped:
            deduped.append(line)
    return score, deduped[:6]


def recall_memory(workspace: Path, query: str, recent_days: int) -> dict[str, Any]:
    query_words = [word.lower() for word in re.split(r"\s+", query) if word.strip()]
    candidates = [Path(rel) for rel in MEMORY_SEARCH_FILES]
    candidates.extend(date_candidates(date.today(), recent_days))
    results = []

    for rel_path in candidates:
        abs_path = workspace / rel_path
        if not abs_path.exists():
            continue
        if abs_path.suffix == ".json":
            content = json.dumps(read_json(abs_path), ensure_ascii=False, indent=2)
        else:
            content = read_text(abs_path) or ""
        score, matches = search_blob(content, query_words)
        if score > 0 or matches:
            results.append(
                {
                    "path": str(rel_path),
                    "score": score,
                    "matches": matches[:6],
                }
            )
    results.sort(key=lambda item: (-item["score"], item["path"]))
    return {
        "query": query,
        "results": results[:8],
    }


def render_recall_memory_markdown(payload: dict[str, Any]) -> str:
    lines = [
        "# Memory Recall",
        "",
        f"- Query: {payload['query']}",
        "- Results:",
    ]
    if not payload["results"]:
        lines.append("  - `_none_`")
        return "\n".join(lines) + "\n"
    for result in payload["results"]:
        lines.append(f"  - `{result['path']}` score={result['score']}")
        for match in result["matches"]:
            lines.append(f"    {match}")
    return "\n".join(lines) + "\n"


def _dedupe(values: list[str]) -> list[str]:
    output: list[str] = []
    for value in values:
        if value not in output:
            output.append(value)
    return output


def _is_dream_noise(line: str) -> bool:
    stripped = normalize_line(line)
    if not stripped:
        return True
    if stripped.startswith("## "):
        return True
    if re.match(r"^[0-9]+\.\s", stripped):
        return True
    if any(token in stripped for token in ("打开", "输入邮箱", "输入密码", "点“下一步”", "获取 6 位")):
        return True
    return False


def _extract_focus_terms(text: str) -> list[str]:
    raw_terms = re.findall(r"[A-Za-z][A-Za-z0-9._/-]{2,}|[\u4e00-\u9fff]{2,}", text)
    stop_terms = {
        "当前主任务",
        "当前状态",
        "正在处理",
        "下一步",
        "已经",
        "已",
        "继续",
        "处理",
        "支持",
        "新增",
        "做",
        "把",
        "这条",
        "一样",
        "风格",
        "任务",
        "流程",
        "默认",
        "当前",
    }
    terms: list[str] = []
    for term in raw_terms:
        normalized = term.strip("`").strip()
        if len(normalized) < 2:
            continue
        if normalized.lower() in {"the", "and", "for", "with", "from", "this"}:
            continue
        if normalized in stop_terms:
            continue
        if normalized not in terms:
            terms.append(normalized)
    return terms[:16]


def get_dream_focus_terms(workspace: Path, focus_query: str | None, focus_current_task: bool) -> list[str]:
    seeds: list[str] = []
    if focus_query:
        seeds.append(focus_query)
    if focus_current_task:
        current_task = read_text(workspace / "memory/current-task.md") or ""
        compacted = compact_task_text(current_task)
        seeds.extend(compacted["Goal"])
        seeds.extend(compacted["Next exact step"])
        seeds.extend(compacted["Key files"][:6])
    return _extract_focus_terms("\n".join(seeds))


def _matches_focus(line: str, focus_terms: list[str]) -> bool:
    if not focus_terms:
        return True
    lowered = line.lower()
    matched_terms = [term for term in focus_terms if term.lower() in lowered]
    threshold = 1 if len(focus_terms) < 4 else 2
    return len(matched_terms) >= threshold


def _select_dream_candidates(lines: list[str], predicate, focus_terms: list[str]) -> list[str]:
    base = [line for line in lines if not _is_dream_noise(line) and predicate(line)]
    if not focus_terms:
        return base
    return [line for line in base if _matches_focus(line, focus_terms)]


def evaluate_dream_gate(
    workspace: Path,
    days: int,
    min_hours: int,
    min_sources: int,
    now: datetime | None = None,
) -> dict[str, Any]:
    now_dt = now or datetime.now()
    facts_json = read_json(workspace / "memory/facts.json") or {}
    dream_meta = facts_json.get("dream_memory", {}) if isinstance(facts_json, dict) else {}
    last_run_at = dream_meta.get("last_run_at")
    source_count = sum(1 for rel in date_candidates(date.today(), days) if (workspace / rel).exists())
    gate_open = True
    reasons: list[str] = []
    hours_since_last_run: float | None = None

    if last_run_at:
        try:
            parsed = datetime.fromisoformat(last_run_at)
            hours_since_last_run = (now_dt - parsed).total_seconds() / 3600
            if min_hours > 0 and hours_since_last_run < min_hours:
                gate_open = False
                reasons.append(f"min_hours_not_reached:{hours_since_last_run:.1f}<{min_hours}")
        except ValueError:
            reasons.append("last_run_at_invalid")

    if source_count < min_sources:
        gate_open = False
        reasons.append(f"not_enough_sources:{source_count}<{min_sources}")

    if gate_open:
        reasons.append("gate_open")

    return {
        "open": gate_open,
        "days": days,
        "min_hours": min_hours,
        "min_sources": min_sources,
        "hours_since_last_run": None if hours_since_last_run is None else round(hours_since_last_run, 2),
        "source_count": source_count,
        "reasons": reasons,
    }


def build_dream_memory(workspace: Path, days: int, focus_terms: list[str] | None = None) -> dict[str, Any]:
    focus_terms = focus_terms or []
    daily_paths = [workspace / rel for rel in date_candidates(date.today(), days)]
    sources: list[str] = []
    lines: list[str] = []

    for path in daily_paths:
        if not path.exists():
            continue
        sources.append(str(path.relative_to(workspace)))
        lines.extend(
            normalize_line(line)
            for line in path.read_text(encoding="utf-8").splitlines()
            if normalize_line(line)
        )

    prefs_json = read_json(workspace / "memory/preferences.json") or {}
    facts_json = read_json(workspace / "memory/facts.json") or {}

    auto_prefs = list(((prefs_json.get("auto_memory") or {}).get("captured_preferences") or []))
    auto_facts = list(((facts_json.get("auto_memory") or {}).get("captured_facts") or []))
    auto_tasks = list(((facts_json.get("auto_memory") or {}).get("captured_tasks") or []))

    preference_candidates = _select_dream_candidates(
        lines,
        lambda line: any(marker in line for marker in DREAM_PREFERENCE_MARKERS),
        focus_terms,
    ) + [item for item in auto_prefs if _matches_focus(item, focus_terms)]
    fact_candidates = _select_dream_candidates(
        lines,
        lambda line: any(marker in line for marker in DREAM_FACT_MARKERS) or re.search(r"https?://", line),
        focus_terms,
    ) + [item for item in auto_facts if _matches_focus(item, focus_terms)]
    task_candidates = _select_dream_candidates(
        lines,
        lambda line: any(token in line for token in ("下一步", "以后", "待", "持续", "检查", "推进", "需要")),
        focus_terms,
    ) + [item for item in auto_tasks if _matches_focus(item, focus_terms)]

    preference_candidates = _dedupe(preference_candidates)[:20]
    fact_candidates = _dedupe(fact_candidates)[:20]
    task_candidates = _dedupe(task_candidates)[:20]

    suggested_actions = []
    if preference_candidates:
        suggested_actions.append("review_preference_candidates")
    if fact_candidates:
        suggested_actions.append("review_fact_candidates")
    if task_candidates:
        suggested_actions.append("review_open_loops")
    suggested_actions.append("do_not_auto_merge_into_MEMORY_md")

    return {
        "window_days": days,
        "generated_at": datetime.now().isoformat(timespec="seconds"),
        "sources": sources,
        "focus_terms": focus_terms,
        "preference_candidates": preference_candidates,
        "fact_candidates": fact_candidates,
        "task_candidates": task_candidates,
        "suggested_actions": suggested_actions,
    }


def render_dream_memory_markdown(payload: dict[str, Any]) -> str:
    lines = [
        "# Dream Memory",
        "",
        f"- Window days: `{payload['window_days']}`",
        f"- Generated at: `{payload['generated_at']}`",
    ]
    if payload.get("focus_terms"):
        lines.extend(
            [
                "- Focus terms:",
                *[f"  - `{item}`" for item in payload["focus_terms"]],
            ]
        )
    if payload.get("gate"):
        gate = payload["gate"]
        lines.extend(
            [
                f"- Gate open: `{str(gate['open']).lower()}`",
                f"- Gate hours since last run: `{gate['hours_since_last_run']}`",
                f"- Gate source count: `{gate['source_count']}`",
                "- Gate reasons:",
                *[f"  - `{item}`" for item in gate["reasons"]],
            ]
        )
    lines.extend(
        [
        "- Sources:",
        ]
    )
    lines.extend([f"  - `{item}`" for item in payload["sources"]] or ["  - `_none_`"])
    lines.append("- Preference candidates:")
    lines.extend([f"  - {item}" for item in payload["preference_candidates"]] or ["  - `_none_`"])
    lines.append("- Fact candidates:")
    lines.extend([f"  - {item}" for item in payload["fact_candidates"]] or ["  - `_none_`"])
    lines.append("- Task candidates:")
    lines.extend([f"  - {item}" for item in payload["task_candidates"]] or ["  - `_none_`"])
    lines.append("- Suggested actions:")
    lines.extend([f"  - `{item}`" for item in payload["suggested_actions"]] or ["  - `_none_`"])
    if "apply_result" in payload:
        lines.append("- Apply result:")
        for key, value in payload["apply_result"].items():
            lines.append(f"  - {key}: `{value}`")
    return "\n".join(lines) + "\n"


def apply_dream_memory(workspace: Path, payload: dict[str, Any]) -> dict[str, Any]:
    dreams_dir = workspace / "memory/dreams"
    _ensure_parent(dreams_dir / "placeholder")
    report_path = dreams_dir / f"{date.today().isoformat()}.md"
    report_json_path = dreams_dir / f"{date.today().isoformat()}.json"
    report_path.write_text(render_dream_memory_markdown(payload), encoding="utf-8")
    report_json_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    facts_path = workspace / "memory/facts.json"
    _update_json_file(
        facts_path,
        lambda data: {
            **data,
            "dream_memory": {
                **(data.get("dream_memory", {}) if isinstance(data, dict) else {}),
                "last_run_at": datetime.now().isoformat(timespec="seconds"),
                "last_report": str(report_path.relative_to(workspace)),
                "last_payload_json": str(report_json_path.relative_to(workspace)),
                "last_window_days": payload["window_days"],
                "last_focus_terms": payload.get("focus_terms", []),
                "candidate_counts": {
                    "preferences": len(payload["preference_candidates"]),
                    "facts": len(payload["fact_candidates"]),
                    "tasks": len(payload["task_candidates"]),
                },
            },
        },
    )

    return {
        "applied": True,
        "report": str(report_path),
        "report_json": str(report_json_path),
        "facts_file": str(facts_path),
    }


def _clean_dream_candidate(line: str) -> str:
    cleaned = normalize_line(line)
    cleaned = re.sub(r"^\s*[-*]+\s*", "", cleaned)
    cleaned = re.sub(r"^\s*\d+\.\s*", "", cleaned)
    return cleaned.strip()


def _allow_dream_promotion(item: str, kind: str) -> bool:
    if not item:
        return False
    if _is_dream_noise(item):
        return False
    ephemeral_goal_markers = (
        "当前目标",
        "当前主任务",
        "参考公开的多 agent 设计",
        "让 OpenClaw 和 Claude 一样好用",
    )
    if kind in {"fact", "preference"} and any(marker in item for marker in ephemeral_goal_markers):
        return False
    if kind == "task" and any(token in item for token in ("输入邮箱", "输入密码", "打开网址", "打开谷歌登录页面")):
        return False
    return True


def load_latest_dream_payload(workspace: Path, report_json: str | None = None) -> dict[str, Any]:
    candidate_paths: list[Path] = []
    if report_json:
        report_path = Path(report_json)
        candidate_paths.append(report_path if report_path.is_absolute() else workspace / report_path)
    facts_json = read_json(workspace / "memory/facts.json") or {}
    dream_meta = facts_json.get("dream_memory", {}) if isinstance(facts_json, dict) else {}
    last_payload_json = dream_meta.get("last_payload_json")
    last_report = dream_meta.get("last_report")
    if last_payload_json:
        candidate_paths.append(workspace / last_payload_json)
    if last_report:
        candidate_paths.append(workspace / Path(str(last_report)).with_suffix(".json"))
    candidate_paths.append(workspace / "memory/dreams" / f"{date.today().isoformat()}.json")

    for path in candidate_paths:
        if path.exists():
            return json.loads(path.read_text(encoding="utf-8"))
    markdown_candidates: list[Path] = []
    if last_report:
        markdown_candidates.append(workspace / last_report)
    markdown_candidates.append(workspace / "memory/dreams" / f"{date.today().isoformat()}.md")
    for path in markdown_candidates:
        if path.exists():
            return parse_dream_markdown(path)
    raise FileNotFoundError("No dream payload json found")


def parse_dream_markdown(path: Path) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "window_days": None,
        "generated_at": None,
        "focus_terms": [],
        "sources": [],
        "preference_candidates": [],
        "fact_candidates": [],
        "task_candidates": [],
        "suggested_actions": [],
    }
    section_map = {
        "- Focus terms:": "focus_terms",
        "- Sources:": "sources",
        "- Preference candidates:": "preference_candidates",
        "- Fact candidates:": "fact_candidates",
        "- Task candidates:": "task_candidates",
        "- Suggested actions:": "suggested_actions",
    }
    current_section: str | None = None
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.rstrip()
        if line.startswith("- Window days:"):
            match = re.search(r"`?([0-9]+)`?", line)
            if match:
                payload["window_days"] = int(match.group(1))
            continue
        if line.startswith("- Generated at:"):
            match = re.search(r"`([^`]+)`", line)
            if match:
                payload["generated_at"] = match.group(1)
            continue
        if line in section_map:
            current_section = section_map[line]
            continue
        if current_section and line.startswith("  - "):
            value = line[4:].strip().strip("`")
            if value != "_none_":
                payload[current_section].append(value)
            continue
        if current_section and line.startswith("- ") and current_section in {"preference_candidates", "fact_candidates", "task_candidates"}:
            value = line[2:].strip().strip("`")
            if value:
                payload[current_section].append(value)
            continue
        if current_section and not line.strip():
            current_section = None
    return payload


def build_dream_promotion_plan(payload: dict[str, Any], max_items: int) -> dict[str, Any]:
    preferences = _dedupe(
        [
            item
            for item in (_clean_dream_candidate(line) for line in payload.get("preference_candidates", []))
            if _allow_dream_promotion(item, "preference")
        ]
    )[:max_items]
    facts = _dedupe(
        [
            item
            for item in (_clean_dream_candidate(line) for line in payload.get("fact_candidates", []))
            if _allow_dream_promotion(item, "fact")
        ]
    )[:max_items]
    tasks = _dedupe(
        [
            item
            for item in (_clean_dream_candidate(line) for line in payload.get("task_candidates", []))
            if _allow_dream_promotion(item, "task")
        ]
    )[:max_items]

    notes = [
        "promotion_is_explicit_and_structured",
        "structured_memory_is_updated_first",
        "MEMORY_md_write_is_optional",
    ]
    return {
        "report_generated_at": payload.get("generated_at"),
        "window_days": payload.get("window_days"),
        "focus_terms": payload.get("focus_terms", []),
        "preferences_to_promote": preferences,
        "facts_to_promote": facts,
        "tasks_to_promote": tasks,
        "notes": notes,
    }


def render_dream_promotion_markdown(payload: dict[str, Any]) -> str:
    lines = [
        "# Dream Promotion",
        "",
        f"- Report generated at: `{payload['report_generated_at']}`",
        f"- Window days: `{payload['window_days']}`",
    ]
    if payload.get("focus_terms"):
        lines.append("- Focus terms:")
        lines.extend([f"  - `{item}`" for item in payload["focus_terms"]])
    lines.append("- Preferences to promote:")
    lines.extend([f"  - {item}" for item in payload["preferences_to_promote"]] or ["  - `_none_`"])
    lines.append("- Facts to promote:")
    lines.extend([f"  - {item}" for item in payload["facts_to_promote"]] or ["  - `_none_`"])
    lines.append("- Tasks to promote:")
    lines.extend([f"  - {item}" for item in payload["tasks_to_promote"]] or ["  - `_none_`"])
    lines.append("- Notes:")
    lines.extend([f"  - `{item}`" for item in payload["notes"]] or ["  - `_none_`"])
    if "apply_result" in payload:
        lines.append("- Apply result:")
        for key, value in payload["apply_result"].items():
            lines.append(f"  - {key}: `{value}`")
    return "\n".join(lines) + "\n"


def apply_dream_promotion(workspace: Path, payload: dict[str, Any], write_memory_md: bool) -> dict[str, Any]:
    promoted_at = datetime.now().isoformat(timespec="seconds")
    preferences_path = workspace / "memory/preferences.json"
    facts_path = workspace / "memory/facts.json"

    _update_json_file(
        preferences_path,
        lambda data: {
            **data,
            "dream_promoted": {
                **(data.get("dream_promoted", {}) if isinstance(data, dict) else {}),
                "last_promoted_at": promoted_at,
                "promoted_preferences": _append_unique(
                    list((data.get("dream_promoted", {}) if isinstance(data, dict) else {}).get("promoted_preferences", [])),
                    payload["preferences_to_promote"],
                ),
            },
        },
    )
    _update_json_file(
        facts_path,
        lambda data: {
            **data,
            "dream_promoted": {
                **(data.get("dream_promoted", {}) if isinstance(data, dict) else {}),
                "last_promoted_at": promoted_at,
                "promoted_facts": _append_unique(
                    list((data.get("dream_promoted", {}) if isinstance(data, dict) else {}).get("promoted_facts", [])),
                    payload["facts_to_promote"],
                ),
                "promoted_open_loops": _append_unique(
                    list((data.get("dream_promoted", {}) if isinstance(data, dict) else {}).get("promoted_open_loops", [])),
                    payload["tasks_to_promote"],
                ),
            },
        },
    )

    memory_md_path = workspace / "MEMORY.md"
    memory_md_written = False
    if write_memory_md:
        lines = [
            f"## Dream Promotion {date.today().isoformat()}",
            "",
        ]
        if payload["preferences_to_promote"]:
            lines.append("### Stable preferences")
            lines.extend([f"- {item}" for item in payload["preferences_to_promote"]])
            lines.append("")
        if payload["facts_to_promote"]:
            lines.append("### Durable facts")
            lines.extend([f"- {item}" for item in payload["facts_to_promote"]])
            lines.append("")
        if payload["tasks_to_promote"]:
            lines.append("### Open loops to review")
            lines.extend([f"- {item}" for item in payload["tasks_to_promote"]])
            lines.append("")
        existing = memory_md_path.read_text(encoding="utf-8") if memory_md_path.exists() else "# MEMORY.md\n\n"
        memory_md_path.write_text(existing.rstrip() + "\n\n" + "\n".join(lines).rstrip() + "\n", encoding="utf-8")
        memory_md_written = True

    return {
        "applied": True,
        "preferences_file": str(preferences_path),
        "facts_file": str(facts_path),
        "memory_md_written": str(memory_md_written).lower(),
    }


def _format_timestamp_ms(value: Any) -> str | None:
    if not isinstance(value, (int, float)):
        return None
    return datetime.fromtimestamp(value / 1000).astimezone().isoformat(timespec="seconds")


def _load_jsonl_records(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    records: list[dict[str, Any]] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        try:
            records.append(json.loads(stripped))
        except json.JSONDecodeError:
            continue
    return records


def build_dream_status(
    workspace: Path,
    jobs_file: Path,
    runs_dir: Path,
    job_name: str,
    max_runs: int,
) -> dict[str, Any]:
    jobs_payload = read_json(jobs_file) or {}
    jobs = jobs_payload.get("jobs", []) if isinstance(jobs_payload, dict) else []
    job = next((item for item in jobs if item.get("name") == job_name), None)
    if not job:
        return {
            "job_found": False,
            "job_name": job_name,
            "jobs_file": str(jobs_file),
        }

    job_id = job.get("id")
    run_log_path = runs_dir / f"{job_id}.jsonl"
    run_records = _load_jsonl_records(run_log_path)
    finished_runs = [record for record in run_records if record.get("action") == "finished"]
    recent_runs = []
    for record in finished_runs[-max_runs:][::-1]:
        recent_runs.append(
            {
                "status": record.get("status"),
                "error": record.get("error"),
                "delivery_status": record.get("deliveryStatus"),
                "run_at": _format_timestamp_ms(record.get("runAtMs")),
                "finished_at": _format_timestamp_ms(record.get("ts")),
                "next_run_at": _format_timestamp_ms(record.get("nextRunAtMs")),
                "duration_ms": record.get("durationMs"),
                "session_id": record.get("sessionId"),
            }
        )

    facts_json = read_json(workspace / "memory/facts.json") or {}
    prefs_json = read_json(workspace / "memory/preferences.json") or {}
    dream_memory = facts_json.get("dream_memory", {}) if isinstance(facts_json, dict) else {}
    dream_promoted_facts = facts_json.get("dream_promoted", {}) if isinstance(facts_json, dict) else {}
    dream_promoted_prefs = prefs_json.get("dream_promoted", {}) if isinstance(prefs_json, dict) else {}

    return {
        "job_found": True,
        "job_name": job_name,
        "job_id": job_id,
        "enabled": job.get("enabled", False),
        "schedule_expr": ((job.get("schedule") or {}).get("expr")),
        "schedule_tz": ((job.get("schedule") or {}).get("tz")),
        "next_run_at": _format_timestamp_ms(((job.get("state") or {}).get("nextRunAtMs"))),
        "last_run_at": _format_timestamp_ms(((job.get("state") or {}).get("lastRunAtMs"))),
        "last_status": (job.get("state") or {}).get("lastStatus"),
        "last_error": (job.get("state") or {}).get("lastError"),
        "run_log_path": str(run_log_path),
        "run_log_exists": run_log_path.exists(),
        "recent_runs": recent_runs,
        "dream_report": dream_memory.get("last_report"),
        "dream_payload_json": dream_memory.get("last_payload_json"),
        "dream_last_run_at": dream_memory.get("last_run_at"),
        "dream_last_verification_report": dream_memory.get("last_verification_report"),
        "dream_last_verification_payload": dream_memory.get("last_verification_payload"),
        "dream_candidate_counts": dream_memory.get("candidate_counts", {}),
        "dream_last_promoted_at": dream_promoted_facts.get("last_promoted_at") or dream_promoted_prefs.get("last_promoted_at"),
        "promoted_counts": {
            "preferences": len(dream_promoted_prefs.get("promoted_preferences", [])),
            "facts": len(dream_promoted_facts.get("promoted_facts", [])),
            "tasks": len(dream_promoted_facts.get("promoted_open_loops", [])),
        },
    }


def render_dream_status_markdown(payload: dict[str, Any]) -> str:
    lines = [
        "# Dream Status",
        "",
        f"- Job found: `{str(payload['job_found']).lower()}`",
        f"- Job name: `{payload['job_name']}`",
    ]
    if not payload["job_found"]:
        lines.append(f"- Jobs file: `{payload['jobs_file']}`")
        return "\n".join(lines) + "\n"
    lines.extend(
        [
            f"- Job id: `{payload['job_id']}`",
            f"- Enabled: `{str(payload['enabled']).lower()}`",
            f"- Schedule: `{payload['schedule_expr']}`",
            f"- Timezone: `{payload['schedule_tz']}`",
            f"- Next run at: `{payload['next_run_at']}`",
            f"- Last run at: `{payload['last_run_at']}`",
            f"- Last status: `{payload['last_status']}`",
            f"- Last error: `{payload['last_error']}`",
            f"- Run log path: `{payload['run_log_path']}`",
            f"- Run log exists: `{str(payload['run_log_exists']).lower()}`",
            f"- Dream last run at: `{payload['dream_last_run_at']}`",
            f"- Dream report: `{payload['dream_report']}`",
            f"- Dream payload json: `{payload['dream_payload_json']}`",
            f"- Dream verification report: `{payload['dream_last_verification_report']}`",
            f"- Dream verification payload: `{payload['dream_last_verification_payload']}`",
            f"- Dream last promoted at: `{payload['dream_last_promoted_at']}`",
            "- Dream candidate counts:",
        ]
    )
    for key, value in payload["dream_candidate_counts"].items():
        lines.append(f"  - `{key}`: `{value}`")
    lines.append("- Promoted counts:")
    for key, value in payload["promoted_counts"].items():
        lines.append(f"  - `{key}`: `{value}`")
    lines.append("- Recent finished runs:")
    if payload["recent_runs"]:
        for item in payload["recent_runs"]:
            lines.append(
                f"  - status=`{item['status']}` run_at=`{item['run_at']}` finished_at=`{item['finished_at']}` duration_ms=`{item['duration_ms']}`"
            )
            if item["error"]:
                lines.append(f"    error: {item['error']}")
    else:
        lines.append("  - `_none_`")
    return "\n".join(lines) + "\n"


def build_dream_verification(
    workspace: Path,
    jobs_file: Path,
    runs_dir: Path,
    job_name: str,
    max_runs: int,
    report_json: str | None = None,
) -> dict[str, Any]:
    status = build_dream_status(workspace, jobs_file, runs_dir, job_name, max_runs)
    payload = None
    payload_error = None
    latest_payload_path = None

    try:
        payload = load_latest_dream_payload(workspace, report_json)
        if report_json:
            report_path = Path(report_json)
            latest_payload_path = str(report_path if report_path.is_absolute() else workspace / report_path)
        else:
            facts_json = read_json(workspace / "memory/facts.json") or {}
            dream_meta = facts_json.get("dream_memory", {}) if isinstance(facts_json, dict) else {}
            latest_payload_path = dream_meta.get("last_payload_json")
            if latest_payload_path:
                latest_payload_path = str(workspace / latest_payload_path)
    except FileNotFoundError as exc:
        payload_error = str(exc)

    candidate_counts = {
        "preferences": len((payload or {}).get("preference_candidates", [])),
        "facts": len((payload or {}).get("fact_candidates", [])),
        "tasks": len((payload or {}).get("task_candidates", [])),
    }
    promoted_counts = status.get("promoted_counts", {})

    verified: list[str] = []
    not_verified: list[str] = []
    risks: list[str] = []
    next_steps: list[str] = []

    if status.get("job_found"):
        enabled = status.get("enabled")
        verified.append(
            f"Nightly Dream Memory cron is {'enabled' if enabled else 'installed but disabled'}."
        )
        if enabled and status.get("next_run_at"):
            verified.append(f"Next dream run is scheduled at {status['next_run_at']}.")
        if status.get("recent_runs"):
            latest_run = status["recent_runs"][0]
            if latest_run.get("status") == "success":
                verified.append(f"Latest recorded dream run succeeded at {latest_run.get('finished_at') or latest_run.get('run_at')}.")
            else:
                not_verified.append(
                    f"Latest recorded dream run status is {latest_run.get('status') or 'unknown'}."
                )
                if latest_run.get("error"):
                    risks.append(f"Latest dream run error: {latest_run['error']}")
        else:
            not_verified.append("No finished nightly dream run has been recorded yet.")
    else:
        not_verified.append("Nightly Dream Memory cron job is not installed.")
        next_steps.append("Install or re-check the nightly dream cron job before relying on automatic consolidation.")

    if payload:
        verified.append(
            f"Latest dream snapshot is available with {sum(candidate_counts.values())} total candidates across {len(payload.get('sources', []))} sources."
        )
        if latest_payload_path:
            verified.append(f"Latest dream payload path resolved to {latest_payload_path}.")
        if payload.get("focus_terms"):
            verified.append(f"Dream snapshot kept focus terms for the active task ({len(payload['focus_terms'])} terms).")
        if not payload.get("sources"):
            risks.append("Latest dream snapshot has no recorded sources.")
        if sum(candidate_counts.values()) == 0:
            risks.append("Latest dream snapshot produced zero candidates.")
            next_steps.append("Review the dream gate and source daily notes before trusting nightly consolidation quality.")
    else:
        not_verified.append("Latest dream snapshot could not be loaded.")
        if payload_error:
            risks.append(payload_error)
        next_steps.append("Run `dream-memory --apply` or wait for the nightly cron to generate a snapshot before verification.")

    if promoted_counts.get("preferences", 0) or promoted_counts.get("facts", 0) or promoted_counts.get("tasks", 0):
        verified.append(
            "Dream promotion has written structured-memory items."
        )
    else:
        not_verified.append("No promoted dream items are present in structured memory yet.")
        if payload and sum(candidate_counts.values()) > 0:
            next_steps.append("Review the latest dream snapshot and run `promote-dream --apply` if the candidates are worth keeping.")

    for key in ("preferences", "facts", "tasks"):
        promoted = int(promoted_counts.get(key, 0) or 0)
        candidates = int(candidate_counts.get(key, 0) or 0)
        if payload and promoted > candidates and candidates > 0:
            risks.append(f"Promoted {key} count exceeds current candidate count; verify that the latest snapshot matches the promoted state.")

    if status.get("job_found") and status.get("enabled") and not status.get("recent_runs"):
        next_steps.append("Wait for the first scheduled dream run or trigger a manual `nightly-dream-cycle --apply` once before relying on cron state.")
    if not next_steps:
        next_steps.append("Keep watching `dream-status` after the next automatic run and only promote candidates that remain stable.")

    report = {
        "goal": "verify nightly dream consolidation and promotion health",
        "Verified": _dedupe(verified) or ["_missing_"],
        "Not verified": _dedupe(not_verified) or ["_none_"],
        "Risks": _dedupe(risks) or ["_none_"],
        "Recommended next step": _dedupe(next_steps) or ["_missing_"],
        "job_status": status,
        "candidate_counts": candidate_counts,
        "promoted_counts": promoted_counts,
        "latest_payload_path": latest_payload_path,
    }
    report["lint"] = lint_report(
        "\n".join(f"- {field}: {', '.join(report[field])}" for field in CLOSURE_FIELDS),
        strict=True,
    )
    return report


def render_dream_verification_markdown(payload: dict[str, Any]) -> str:
    lines = [
        "# Dream Verification",
        "",
        f"- Goal: {payload['goal']}",
        f"- Latest payload path: `{payload.get('latest_payload_path') or '_none_'}`",
        "- Candidate counts:",
    ]
    for key, value in payload["candidate_counts"].items():
        lines.append(f"  - `{key}`: `{value}`")
    lines.append("- Promoted counts:")
    for key, value in payload["promoted_counts"].items():
        lines.append(f"  - `{key}`: `{value}`")
    lines.append("")
    for field in CLOSURE_FIELDS:
        lines.append(f"- {field}: {', '.join(payload[field])}")
    lines.extend(
        [
            "",
            f"- Lint decision: `{payload['lint']['decision']}`",
            "- Lint warnings:",
        ]
    )
    lines.extend([f"  - `{item}`" for item in payload["lint"]["warnings"]] or ["  - `_none_`"])
    return "\n".join(lines) + "\n"


def build_dream_cycle_verification(payload: dict[str, Any]) -> dict[str, Any]:
    gate = payload["gate"]
    candidate_counts = payload.get("candidate_counts", {})
    promotion_counts = payload.get("promotion_counts", {})
    verified: list[str] = []
    not_verified: list[str] = []
    risks: list[str] = []
    next_steps: list[str] = []

    if gate["open"]:
        verified.append(f"Nightly dream gate opened with {gate['source_count']} sources.")
    else:
        not_verified.append("Nightly dream gate did not open for this cycle.")
        next_steps.append("Wait for more daily-note sources or the minimum hour window before rerunning nightly dream.")

    status = payload.get("status")
    if status in {"review_required", "applied", "ready_for_review", "no_candidates"}:
        verified.append(f"Nightly dream cycle reached status {status}.")
    else:
        not_verified.append(f"Nightly dream cycle status is {status}.")

    total_candidates = sum(int(candidate_counts.get(key, 0) or 0) for key in ("preferences", "facts", "tasks"))
    if total_candidates > 0:
        verified.append(f"Cycle produced {total_candidates} candidate items for review.")
    elif gate["open"]:
        not_verified.append("Gate opened but the cycle produced zero candidates.")
        risks.append("Extraction markers may be too narrow for the current daily notes.")
        next_steps.append("Inspect the latest daily notes and widen dream markers only where real signal was missed.")

    promoted_total = sum(int(promotion_counts.get(key, 0) or 0) for key in ("preferences", "facts", "tasks"))
    if payload.get("promotion_apply_result"):
        verified.append(f"Structured-memory promotion wrote {promoted_total} items.")
    elif total_candidates > 0:
        not_verified.append("Candidates exist but structured-memory promotion was not applied in this cycle.")

    if candidate_counts.get("facts", 0) == 1 and candidate_counts.get("preferences", 0) == 0 and candidate_counts.get("tasks", 0) == 0:
        risks.append("Current dream output is still too thin; it mainly captures one fact and misses preferences/tasks.")
        next_steps.append("Keep observing real nightly runs and tighten or widen markers based on missed task-like lines, not synthetic examples.")

    report = {
        "goal": "verify nightly dream cycle output and promotion quality",
        "Verified": _dedupe(verified) or ["_missing_"],
        "Not verified": _dedupe(not_verified) or ["_none_"],
        "Risks": _dedupe(risks) or ["_none_"],
        "Recommended next step": _dedupe(next_steps) or ["_missing_"],
    }
    report["lint"] = lint_report(
        "\n".join(f"- {field}: {', '.join(report[field])}" for field in CLOSURE_FIELDS),
        strict=True,
    )
    return report


def apply_dream_cycle_verification(workspace: Path, payload: dict[str, Any], verification: dict[str, Any]) -> dict[str, Any]:
    dreams_dir = workspace / "memory" / "dreams"
    _ensure_parent(dreams_dir / "placeholder")
    report_path = dreams_dir / f"{date.today().isoformat()}-verification.md"
    report_json_path = dreams_dir / f"{date.today().isoformat()}-verification.json"
    report_path.write_text(render_dream_verification_markdown({
        **verification,
        "candidate_counts": payload.get("candidate_counts", {}),
        "promoted_counts": payload.get("promotion_counts", {}),
        "latest_payload_path": (payload.get("dream_apply_result") or {}).get("report_json"),
    }), encoding="utf-8")
    report_json_path.write_text(json.dumps({
        "cycle": payload,
        "verification": verification,
    }, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    facts_path = workspace / "memory/facts.json"
    _update_json_file(
        facts_path,
        lambda data: {
            **data,
            "dream_memory": {
                **(data.get("dream_memory", {}) if isinstance(data, dict) else {}),
                "last_verification_report": str(report_path.relative_to(workspace)),
                "last_verification_payload": str(report_json_path.relative_to(workspace)),
            },
        },
    )
    return {
        "applied": True,
        "report": str(report_path),
        "report_json": str(report_json_path),
        "facts_file": str(facts_path),
    }


def run_nightly_dream_cycle(
    workspace: Path,
    days: int,
    focus_query: str | None,
    focus_current_task: bool,
    min_hours: int,
    min_sources: int,
    max_items: int,
    apply: bool,
    write_memory_md: bool,
) -> dict[str, Any]:
    gate = evaluate_dream_gate(workspace, days, min_hours, min_sources)
    focus_terms = get_dream_focus_terms(workspace, focus_query, focus_current_task)
    payload: dict[str, Any] = {
        "generated_at": datetime.now().isoformat(timespec="seconds"),
        "status": "skipped",
        "workspace": str(workspace),
        "gate": gate,
        "focus_terms": focus_terms,
        "candidate_counts": {
            "preferences": 0,
            "facts": 0,
            "tasks": 0,
        },
        "promotion_counts": {
            "preferences": 0,
            "facts": 0,
            "tasks": 0,
        },
        "notes": [],
    }

    if not gate["open"]:
        payload["notes"] = ["dream_gate_closed", *gate["reasons"]]
        payload["verification_report"] = build_dream_cycle_verification(payload)
        if apply:
            payload["verification_apply_result"] = apply_dream_cycle_verification(workspace, payload, payload["verification_report"])
        return payload

    dream_payload = build_dream_memory(workspace, days, focus_terms)
    dream_payload["gate"] = gate
    payload["status"] = "ready_for_review"
    payload["dream_payload"] = dream_payload
    payload["candidate_counts"] = {
        "preferences": len(dream_payload["preference_candidates"]),
        "facts": len(dream_payload["fact_candidates"]),
        "tasks": len(dream_payload["task_candidates"]),
    }

    if apply:
        payload["dream_apply_result"] = apply_dream_memory(workspace, dream_payload)

    if not any(payload["candidate_counts"].values()):
        payload["status"] = "no_candidates"
        payload["notes"] = ["gate_open_but_no_candidates"]
        payload["verification_report"] = build_dream_cycle_verification(payload)
        if apply:
            payload["verification_apply_result"] = apply_dream_cycle_verification(workspace, payload, payload["verification_report"])
        return payload

    promotion_plan = build_dream_promotion_plan(dream_payload, max_items)
    payload["promotion_plan"] = promotion_plan
    payload["promotion_counts"] = {
        "preferences": len(promotion_plan["preferences_to_promote"]),
        "facts": len(promotion_plan["facts_to_promote"]),
        "tasks": len(promotion_plan["tasks_to_promote"]),
    }
    if apply:
        payload["promotion_apply_result"] = apply_dream_promotion(workspace, promotion_plan, write_memory_md)
        payload["status"] = "applied"
    else:
        payload["status"] = "review_required"
    payload["notes"] = [
        "structured_memory_promotion_only",
        "MEMORY_md_write_is_optional" if not write_memory_md else "MEMORY_md_write_enabled",
    ]
    payload["verification_report"] = build_dream_cycle_verification(payload)
    if apply:
        payload["verification_apply_result"] = apply_dream_cycle_verification(workspace, payload, payload["verification_report"])
    return payload


def render_nightly_dream_cycle_markdown(payload: dict[str, Any]) -> str:
    lines = [
        "# Nightly Dream Cycle",
        "",
        f"- Status: `{payload['status']}`",
        f"- Workspace: `{payload['workspace']}`",
        f"- Generated at: `{payload['generated_at']}`",
        f"- Gate open: `{str(payload['gate']['open']).lower()}`",
        f"- Gate source count: `{payload['gate']['source_count']}`",
        f"- Gate hours since last run: `{payload['gate']['hours_since_last_run']}`",
        "- Gate reasons:",
    ]
    lines.extend([f"  - `{item}`" for item in payload["gate"]["reasons"]] or ["  - `_none_`"])
    if payload.get("focus_terms"):
        lines.append("- Focus terms:")
        lines.extend([f"  - `{item}`" for item in payload["focus_terms"]])
    lines.append("- Candidate counts:")
    for key, value in payload["candidate_counts"].items():
        lines.append(f"  - `{key}`: `{value}`")
    lines.append("- Promotion counts:")
    for key, value in payload["promotion_counts"].items():
        lines.append(f"  - `{key}`: `{value}`")
    if "dream_apply_result" in payload:
        lines.append("- Dream apply result:")
        for key, value in payload["dream_apply_result"].items():
            lines.append(f"  - {key}: `{value}`")
    if "promotion_apply_result" in payload:
        lines.append("- Promotion apply result:")
        for key, value in payload["promotion_apply_result"].items():
            lines.append(f"  - {key}: `{value}`")
    if "verification_report" in payload:
        lines.append("- Verification report:")
        for field in CLOSURE_FIELDS:
            lines.append(f"  - {field}: {', '.join(payload['verification_report'][field])}")
    if "verification_apply_result" in payload:
        lines.append("- Verification apply result:")
        for key, value in payload["verification_apply_result"].items():
            lines.append(f"  - {key}: `{value}`")
    lines.append("- Notes:")
    lines.extend([f"  - `{item}`" for item in payload["notes"]] or ["  - `_none_`"])
    return "\n".join(lines) + "\n"


def build_nightly_dream_cron_message(
    workspace: Path,
    days: int,
    min_hours: int,
    min_sources: int,
    max_items: int,
    focus_query: str | None,
    focus_current_task: bool,
    write_memory_md: bool,
) -> str:
    command_parts = [
        "python3",
        str(workspace / "scripts/openclaw_harness.py"),
        "nightly-dream-cycle",
        "--workspace",
        str(workspace),
        "--days",
        str(days),
        "--min-hours",
        str(min_hours),
        "--min-sources",
        str(min_sources),
        "--max-items",
        str(max_items),
        "--apply",
        "--format",
        "json",
    ]
    if focus_current_task:
        command_parts.append("--focus-current-task")
    if focus_query:
        command_parts.extend(["--focus-query", focus_query])
    if write_memory_md:
        command_parts.append("--write-memory-md")
    command = shlex.join(command_parts)
    return "\n".join(
        [
            f"You are the nightly dream maintenance worker for `{workspace}`.",
            "",
            "Run this command exactly once:",
            command,
            "",
            "Then report only these fields:",
            "- status",
            "- gate.reasons",
            "- candidate_counts",
            "- promotion_counts",
            "- any blocker or risk",
            "",
            "Rules:",
            "- Keep the reply concise.",
            "- Do not edit MEMORY.md unless the command explicitly includes --write-memory-md.",
            "- Do not send outbound delivery unless a real blocker needs human attention.",
        ]
    )


def build_nightly_dream_cron_spec(
    workspace: Path,
    cron_expr: str,
    tz: str,
    days: int,
    min_hours: int,
    min_sources: int,
    max_items: int,
    focus_query: str | None,
    focus_current_task: bool,
    write_memory_md: bool,
    thinking: str,
    model: str | None,
    disabled: bool,
) -> dict[str, Any]:
    message = build_nightly_dream_cron_message(
        workspace=workspace,
        days=days,
        min_hours=min_hours,
        min_sources=min_sources,
        max_items=max_items,
        focus_query=focus_query,
        focus_current_task=focus_current_task,
        write_memory_md=write_memory_md,
    )
    command_parts = [
        "openclaw",
        "cron",
        "add",
        "--name",
        "Nightly Dream Memory",
        "--description",
        "Claude-style nightly memory consolidation and structured promotion.",
        "--cron",
        cron_expr,
        "--tz",
        tz,
        "--session",
        "isolated",
        "--thinking",
        thinking,
        "--message",
        message,
    ]
    if disabled:
        command_parts.append("--disabled")
    if model:
        command_parts.extend(["--model", model])
    return {
        "name": "Nightly Dream Memory",
        "description": "Claude-style nightly memory consolidation and structured promotion.",
        "schedule": {
            "kind": "cron",
            "expr": cron_expr,
            "tz": tz,
        },
        "sessionTarget": "isolated",
        "wakeMode": "now",
        "payload": {
            "kind": "agentTurn",
            "message": message,
            **({"model": model} if model else {}),
            "thinking": thinking,
        },
        "delivery": None,
        "disabled": disabled,
        "install_command": shlex.join(command_parts),
    }


def render_nightly_dream_cron_spec_markdown(payload: dict[str, Any]) -> str:
    lines = [
        "# Nightly Dream Cron Spec",
        "",
        f"- Name: `{payload['name']}`",
        f"- Disabled: `{str(payload['disabled']).lower()}`",
        f"- Session target: `{payload['sessionTarget']}`",
        f"- Wake mode: `{payload['wakeMode']}`",
        f"- Schedule: `{payload['schedule']['expr']}`",
        f"- Timezone: `{payload['schedule']['tz']}`",
        "- Install command:",
        f"  - `{payload['install_command']}`",
        "- Agent message:",
        "",
        "```text",
        payload["payload"]["message"],
        "```",
    ]
    return "\n".join(lines) + "\n"


def render_session_context_markdown(payload: dict[str, Any]) -> str:
    lines = [
        "# Session Context",
        "",
        f"- Workspace: `{payload['workspace']}`",
        f"- Mode: `{payload['mode']}`",
        f"- Generated at: `{payload['generated_at']}`",
        "",
    ]
    for entry in payload["files"]:
        lines.append(f"## {entry['path']}")
        lines.append("")
        if not entry["exists"]:
            lines.append("_Missing_")
            lines.append("")
            continue
        if entry["kind"] == "json":
            lines.append("```json")
            lines.append(json.dumps(entry["content"], ensure_ascii=False, indent=2))
            lines.append("```")
        else:
            lines.append(entry["content"] or "")
        lines.append("")
    return "\n".join(lines).rstrip() + "\n"


def classify_patterns(text: str, groups: list[MatchGroup]) -> tuple[str | None, list[str]]:
    reasons: list[str] = []
    lowered = text.lower()
    for group in groups:
        matched_patterns = [pattern for pattern in group.patterns if re.search(pattern, lowered, re.IGNORECASE)]
        if matched_patterns:
            reasons.extend(matched_patterns)
            return group.name, reasons
    return None, reasons


def classify_route(message: str) -> dict[str, Any]:
    matched_group, reasons = classify_patterns(message, ROUTE_GROUPS)
    route_type = matched_group or "complex_task"
    role_map = {
        "verification": "verification",
        "review": "verification",
        "synthesis": "coordinator",
        "code_exploration": "Explore",
        "data_query": "general-purpose",
        "complex_task": "Plan",
        "direct_answer": "main",
    }
    risk_level = "medium" if route_type in {"verification", "review", "complex_task", "synthesis"} else "low"
    if route_type == "synthesis":
        risk_level = "medium"
    if len(message) > 120 and route_type in {"data_query", "code_exploration"}:
        route_type = "complex_task"
        reasons.append("length>120")
    needs_decomposition = route_type == "complex_task"
    needs_verification = route_type in {"complex_task", "verification", "review", "synthesis"}
    return {
        "type": route_type,
        "goal": message.strip(),
        "next_actor": role_map[route_type],
        "risk_level": risk_level,
        "needs_decomposition": needs_decomposition,
        "needs_verification": needs_verification,
        "matched_rules": reasons,
    }


def render_route_markdown(payload: dict[str, Any]) -> str:
    lines = [
        "# Route",
        "",
        f"- Type: `{payload['type']}`",
        f"- Goal: {payload['goal']}",
        f"- Next actor: `{payload['next_actor']}`",
        f"- Risk level: `{payload['risk_level']}`",
        f"- Needs decomposition: `{str(payload['needs_decomposition']).lower()}`",
        f"- Needs verification: `{str(payload['needs_verification']).lower()}`",
        "- Matched rules:",
    ]
    if payload["matched_rules"]:
        lines.extend([f"  - `{rule}`" for rule in payload["matched_rules"]])
    else:
        lines.append("  - `_none_`")
    return "\n".join(lines) + "\n"


def classify_permission(text: str) -> dict[str, Any]:
    matched_level, reasons = classify_patterns(text, RISK_GROUPS)
    level = matched_level or "L1"
    action_map = {
        "L0": "proceed",
        "L1": "proceed_with_local_write",
        "L2": "confirm_first",
        "L3": "block",
    }
    return {
        "level": level,
        "action": action_map[level],
        "requires_confirmation": level == "L2",
        "blocked": level == "L3",
        "matched_rules": reasons,
        "input": text.strip(),
    }


def render_permission_markdown(payload: dict[str, Any]) -> str:
    lines = [
        "# Permission",
        "",
        f"- Input: {payload['input']}",
        f"- Level: `{payload['level']}`",
        f"- Action: `{payload['action']}`",
        f"- Requires confirmation: `{str(payload['requires_confirmation']).lower()}`",
        f"- Blocked: `{str(payload['blocked']).lower()}`",
        "- Matched rules:",
    ]
    if payload["matched_rules"]:
        lines.extend([f"  - `{rule}`" for rule in payload["matched_rules"]])
    else:
        lines.append("  - `_none_`")
    return "\n".join(lines) + "\n"


def choose_stage_model_tier(actor: str, mode: str, risk_level: str) -> str:
    if actor in {"Plan", "Verification"}:
        return "strong"
    if mode in {"execute", "verify"} and risk_level in {"medium", "high"}:
        return "strong"
    if actor == "Explore":
        return "fast"
    return "balanced"


def build_task_orchestration(workspace: Path, message: str) -> dict[str, Any]:
    route = classify_route(message)
    permission = classify_permission(message)
    current_task_text = read_text(workspace / "memory/current-task.md") or ""
    current_task = compact_task_text(current_task_text) if current_task_text else None
    blockers: list[str] = []
    stages: list[dict[str, Any]] = []

    stages.append(
        {
            "id": "intake",
            "actor": "coordinator",
            "mode": "orchestrate",
            "goal": route["goal"],
            "depends_on": [],
            "exit_criteria": "request type, risk, and best next actor are explicit",
            "model_tier": choose_stage_model_tier("coordinator", "orchestrate", route["risk_level"]),
        }
    )

    if permission["blocked"]:
        blockers.append("permission_blocked_L3")
    elif permission["requires_confirmation"]:
        blockers.append("user_confirmation_required_L2")

    composite_request = bool(re.search(r"并且|然后|先.*再|链接起来|接起来|串起来", message))
    implementation_intent = bool(re.search(r"优化|修复|实现|接入|改|推进|链接起来|串起来", message))
    needs_explore = route["type"] in {"code_exploration", "complex_task", "review", "synthesis"} or (implementation_intent and composite_request)
    needs_plan = route["needs_decomposition"] or route["type"] in {"synthesis", "complex_task"} or (implementation_intent and composite_request)
    primary_actor = route["next_actor"]
    primary_mode = "execute"

    if route["type"] in {"code_exploration", "review"}:
        primary_actor = "Explore"
        primary_mode = "read-only"
    elif route["type"] == "verification" and not implementation_intent:
        primary_actor = "Verification"
        primary_mode = "verify"
    elif route["type"] == "verification" and implementation_intent:
        primary_actor = "general-purpose"
        primary_mode = "execute"
    elif route["type"] == "direct_answer":
        primary_actor = "coordinator"
        primary_mode = "respond"

    if needs_explore:
        stages.append(
            {
                "id": "evidence",
                "actor": "Explore",
                "mode": "read-only",
                "goal": "gather local evidence, relevant files, and current constraints",
                "depends_on": ["intake"],
                "exit_criteria": "key files and concrete evidence are listed",
                "model_tier": choose_stage_model_tier("Explore", "read-only", route["risk_level"]),
            }
        )

    if needs_plan:
        stages.append(
            {
                "id": "plan",
                "actor": "Plan",
                "mode": "read-only",
                "goal": "design the implementation sequence and critical files",
                "depends_on": ["evidence" if needs_explore else "intake"],
                "exit_criteria": "step order, ownership, and verification hooks are explicit",
                "model_tier": choose_stage_model_tier("Plan", "read-only", route["risk_level"]),
            }
        )

    if not permission["blocked"] and route["type"] != "direct_answer":
        stages.append(
            {
                "id": "execution",
                "actor": primary_actor,
                "mode": primary_mode,
                "goal": "complete the main task outcome",
                "depends_on": [stages[-1]["id"]],
                "exit_criteria": "requested outcome exists in inspectable form",
                "model_tier": choose_stage_model_tier(primary_actor, primary_mode, route["risk_level"]),
            }
        )

    if route["needs_verification"] and not permission["blocked"] and primary_actor != "Verification":
        stages.append(
            {
                "id": "verification",
                "actor": "Verification",
                "mode": "verify",
                "goal": "try to break the result and separate verified from unverified claims",
                "depends_on": ["execution" if any(stage["id"] == "execution" for stage in stages) else stages[-1]["id"]],
                "exit_criteria": "verified, not verified, risks, and next step are explicit",
                "model_tier": choose_stage_model_tier("Verification", "verify", route["risk_level"]),
            }
        )

    stages.append(
        {
            "id": "closure",
            "actor": "coordinator",
            "mode": "synthesize",
            "goal": "return a coherent user-facing closeout without hiding uncertainty",
            "depends_on": [stages[-1]["id"]],
            "exit_criteria": "final answer matches verification state and outstanding risks",
            "model_tier": choose_stage_model_tier("coordinator", "synthesize", route["risk_level"]),
        }
    )

    return {
        "goal": route["goal"],
        "route": route,
        "permission": permission,
        "blockers": blockers,
        "stages": stages,
        "current_task": current_task,
    }


def render_task_orchestration_markdown(payload: dict[str, Any]) -> str:
    lines = [
        "# Task Orchestration",
        "",
        f"- Goal: {payload['goal']}",
        f"- Route type: `{payload['route']['type']}`",
        f"- Risk level: `{payload['route']['risk_level']}`",
        f"- Permission level: `{payload['permission']['level']}`",
        f"- Confirmation required: `{str(payload['permission']['requires_confirmation']).lower()}`",
        "- Blockers:",
    ]
    lines.extend([f"  - `{item}`" for item in payload["blockers"]] or ["  - `_none_`"])
    lines.append("- Stages:")
    for stage in payload["stages"]:
        lines.append(
            f"  - `{stage['id']}` actor=`{stage['actor']}` mode=`{stage['mode']}` model_tier=`{stage['model_tier']}` depends_on=`{','.join(stage['depends_on']) or '_none_'}`"
        )
        lines.append(f"    goal: {stage['goal']}")
        lines.append(f"    exit: {stage['exit_criteria']}")
    if payload.get("current_task"):
        lines.append("- Current task context:")
        for field in ("Goal", "Current blocker", "Next exact step", "Key files"):
            values = payload["current_task"].get(field, [])
            if values:
                lines.append(f"  - {field}: {values[0]}")
    return "\n".join(lines) + "\n"


def _extract_report_lines(text: str, patterns: tuple[str, ...]) -> list[str]:
    lines: list[str] = []
    for raw_line in text.splitlines():
        line = normalize_line(raw_line)
        if not line:
            continue
        if any(re.search(pattern, line, re.IGNORECASE) for pattern in patterns):
            lines.append(line)
    return _dedupe(lines)[:6]


def _extract_prefixed_report_lines(text: str, prefixes: tuple[str, ...]) -> list[str]:
    lines: list[str] = []
    for raw_line in text.splitlines():
        line = normalize_line(raw_line)
        if not line:
            continue
        lowered = line.lower()
        if any(lowered.startswith(prefix.lower()) for prefix in prefixes):
            lines.append(line)
    return _dedupe(lines)[:6]


def build_closure_report(goal: str, text: str) -> dict[str, Any]:
    verified = _extract_prefixed_report_lines(text, ("Verified:", "已验证：", "已验证:"))
    not_verified = _extract_prefixed_report_lines(text, ("Not verified:", "未验证：", "未验证:"))
    risks = _extract_prefixed_report_lines(text, ("Risks:", "Risk:", "风险：", "风险:"))
    next_step = _extract_prefixed_report_lines(text, ("Recommended next step:", "Next step:", "下一步：", "下一步:"))

    if not verified:
        verified = _extract_report_lines(
            text,
            (
                r"(?<!not )\bverified\b",
                r"\bran\b",
                r"\btested\b",
                r"\bchecked\b",
                r"\bconfirmed\b",
                r"已验证",
                r"已确认",
                r"已执行",
                r"通过",
            ),
        )
    if not not_verified:
        not_verified = _extract_report_lines(
            text,
            (
                r"not verified",
                r"未验证",
                r"未检查",
                r"没跑",
                r"assum",
                r"unknown",
                r"待确认",
            ),
        )
    if not risks:
        risks = _extract_report_lines(
            text,
            (
                r"\brisk\b",
                r"\bwarning\b",
                r"\bblocker\b",
                r"\berror\b",
                r"风险",
                r"注意",
                r"可能",
                r"失败",
            ),
        )
    if not next_step:
        next_step = _extract_report_lines(
            text,
            (
                r"next step",
                r"follow[- ]?up",
                r"monitor",
                r"观察",
                r"下一步",
                r"接下来",
                r"建议",
            ),
        )

    if not verified:
        verified = ["_missing_"]
    if not not_verified:
        not_verified = ["_none_"]
    if not risks:
        risks = ["_none_"]
    if not next_step:
        next_step = ["_missing_"]

    report = {
        "goal": goal,
        "Verified": verified,
        "Not verified": not_verified,
        "Risks": risks,
        "Recommended next step": next_step,
    }
    report["lint"] = lint_report(
        "\n".join(f"- {field}: {', '.join(report[field])}" for field in CLOSURE_FIELDS),
        strict=True,
    )
    return report


def render_closure_report_markdown(payload: dict[str, Any]) -> str:
    lines = [
        "# Closure Report",
        "",
        f"- Goal: {payload['goal']}",
        "",
    ]
    for field in CLOSURE_FIELDS:
        lines.append(f"- {field}: {', '.join(payload[field])}")
    lines.extend(
        [
            "",
            f"- Lint decision: `{payload['lint']['decision']}`",
            "- Lint warnings:",
        ]
    )
    lines.extend([f"  - `{item}`" for item in payload["lint"]["warnings"]] or ["  - `_none_`"])
    return "\n".join(lines) + "\n"


def build_closeout_turn(workspace: Path, goal: str, text: str, min_items: int, apply_memory: bool) -> dict[str, Any]:
    closure = build_closure_report(goal, text)

    def _join_field(field: str) -> str:
        values = closure[field]
        cleaned: list[str] = []
        prefix = f"{field}:".lower()
        for value in values:
            normalized = value.strip()
            if normalized.lower().startswith(prefix):
                cleaned.append(normalized)
            else:
                cleaned.append(f"{field}: {normalized}")
        return " | ".join(cleaned)

    memory_text = "\n".join(
        [
            f"Goal: {goal}",
            text,
            _join_field("Verified"),
            _join_field("Not verified"),
            _join_field("Risks"),
            _join_field("Recommended next step"),
        ]
    )
    auto_memory = run_auto_memory_turn(workspace, memory_text, min_items=min_items, apply=apply_memory)
    return {
        "goal": goal,
        "closure_report": closure,
        "auto_memory": auto_memory,
    }


def apply_closeout_turn(
    workspace: Path,
    payload: dict[str, Any],
    stage_id: str | None = None,
    run_id: str | None = None,
    source: str = "manual",
) -> dict[str, Any]:
    closeouts_dir = workspace / "memory" / "closeouts"
    closeouts_dir.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    slug_parts = [timestamp]
    if run_id:
        slug_parts.append(_slugify(run_id, limit=40))
    if stage_id:
        slug_parts.append(_slugify(stage_id, limit=24))
    basename = "-".join(part for part in slug_parts if part)
    json_path = closeouts_dir / f"{basename}.json"
    md_path = closeouts_dir / f"{basename}.md"

    persisted = {
        **payload,
        "source": source,
        "stage_id": stage_id,
        "run_id": run_id,
        "persisted_at": datetime.now().isoformat(timespec="seconds"),
    }
    json_path.write_text(json.dumps(persisted, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    md_path.write_text(render_closeout_turn_markdown(persisted), encoding="utf-8")
    return {
        "applied": True,
        "json": str(json_path),
        "markdown": str(md_path),
    }


def render_closeout_turn_markdown(payload: dict[str, Any]) -> str:
    lines = [
        "# Closeout Turn",
        "",
        f"- Goal: {payload['goal']}",
        "",
        "## Closure Report",
        "",
    ]
    for field in CLOSURE_FIELDS:
        lines.append(f"- {field}: {', '.join(payload['closure_report'][field])}")
    lines.extend(
        [
            "",
            "## Auto Memory",
            "",
            f"- Recommended apply: `{str(payload['auto_memory']['recommended_apply']).lower()}`",
            f"- Total items: `{payload['auto_memory']['total_items']}`",
            f"- Buckets with signal: `{payload['auto_memory']['buckets_with_signal']}`",
            "- Counts:",
        ]
    )
    for key, value in payload["auto_memory"]["counts"].items():
        lines.append(f"  - `{key}`: `{value}`")
    if "apply_result" in payload["auto_memory"]:
        lines.append("- Apply result:")
        for key, value in payload["auto_memory"]["apply_result"].items():
            lines.append(f"  - {key}: `{value}`")
    if "apply_skipped_reason" in payload["auto_memory"]:
        lines.append(f"- Apply skipped: `{payload['auto_memory']['apply_skipped_reason']}`")
    if payload.get("source"):
        lines.append(f"- Source: `{payload['source']}`")
    if payload.get("run_id"):
        lines.append(f"- Run id: `{payload['run_id']}`")
    if payload.get("stage_id"):
        lines.append(f"- Stage id: `{payload['stage_id']}`")
    if payload.get("persisted_at"):
        lines.append(f"- Persisted at: `{payload['persisted_at']}`")
    if payload.get("persist_result"):
        lines.append("- Persist result:")
        for key, value in payload["persist_result"].items():
            lines.append(f"  - {key}: `{value}`")
    return "\n".join(lines) + "\n"


def render_session_closeout_markdown(payload: dict[str, Any]) -> str:
    lines = [
        "# Session Closeout",
        "",
        f"- Found: `{str(payload['found']).lower()}`",
        f"- Agent id: `{payload['agent_id']}`",
    ]
    if not payload["found"]:
        lines.append(f"- Reason: `{payload.get('reason', '_none_')}`")
        if payload.get("session_path"):
            lines.append(f"- Session path: `{payload['session_path']}`")
        return "\n".join(lines) + "\n"

    lines.extend(
        [
            f"- Session id: `{payload['session_id']}`",
            f"- Session path: `{payload['session_path']}`",
            f"- Prompt timestamp: `{payload.get('prompt_timestamp')}`",
            f"- Internal prompt: `{str(payload['internal_prompt']).lower()}`",
            f"- Considered turns: `{payload['considered_turns']}`",
            f"- Goal: {payload['goal']}",
            "",
            "## Prompt",
            "",
            payload["prompt_text"] or "_none_",
            "",
            "## Reply",
            "",
            payload["reply_text"] or "_none_",
        ]
    )
    if payload.get("commentary_text"):
        lines.extend(
            [
                "",
                "## Commentary",
                "",
                payload["commentary_text"],
            ]
        )
    if payload.get("approval_requests"):
        lines.extend(
            [
                "",
                "## Approval Requests Seen",
                "",
            ]
        )
        lines.extend([f"- {item}" for item in payload["approval_requests"]])
    if payload.get("error_messages"):
        lines.extend(
            [
                "",
                "## Error Messages",
                "",
            ]
        )
        lines.extend([f"- {item}" for item in payload["error_messages"]])

    lines.extend(
        [
            "",
            "## Closeout",
            "",
            render_closeout_turn_markdown(payload["closeout_turn"]).rstrip(),
        ]
    )
    if payload.get("persist_result"):
        lines.extend(
            [
                "",
                "## Persist Result",
                "",
            ]
        )
        for key, value in payload["persist_result"].items():
            lines.append(f"- {key}: `{value}`")
    return "\n".join(lines) + "\n"


def _slugify(text: str, limit: int = 48) -> str:
    allowed = string.ascii_lowercase + string.digits + "-"
    lowered = text.lower()
    replaced = re.sub(r"[^a-z0-9]+", "-", lowered)
    cleaned = replaced.strip("-")
    compact = re.sub(r"-{2,}", "-", cleaned)
    if not compact:
        return "task"
    return "".join(ch for ch in compact if ch in allowed)[:limit].strip("-") or "task"


def stage_tool_policy(actor: str) -> dict[str, list[str]]:
    policies = {
        "Explore": {
            "prefer": [
                "rg --files",
                "rg -n",
                "sed -n",
                "cat",
                "git diff --stat",
                "git show --stat",
            ],
            "avoid": [
                "find",
                "ls -la",
                "python",
                "node",
                "bash loops",
                "anything that asks for approval",
            ],
        },
        "Plan": {
            "prefer": [
                "reuse evidence already gathered",
                "rg -n",
                "sed -n",
                "cat",
                "git diff --stat",
            ],
            "avoid": [
                "find",
                "ls -la",
                "python",
                "node",
                "tests",
                "anything that asks for approval",
            ],
        },
        "Verification": {
            "prefer": [
                "deterministic checks first",
                "targeted test commands",
                "existing verification scripts",
                "diff and log inspection",
            ],
            "avoid": [
                "broad exploratory shell commands",
                "destructive writes",
                "public or external actions",
            ],
        },
    }
    return policies.get(actor, {"prefer": [], "avoid": []})


def build_stage_handoff(stage: dict[str, Any], orchestration: dict[str, Any]) -> dict[str, Any]:
    goal = orchestration["goal"]
    current_task = orchestration.get("current_task") or {}
    current_goal = "; ".join(current_task.get("Goal", [])[:2]) or "_none_"
    current_next = "; ".join(current_task.get("Next exact step", [])[:2]) or "_none_"
    key_files = ", ".join(current_task.get("Key files", [])[:8]) or "_none_"
    dependency_note = ", ".join(stage["depends_on"]) or "_none_"
    actor = stage["actor"]

    actor_instructions = {
        "coordinator": "Orchestrate the next move, keep scope tight, and avoid hiding uncertainty.",
        "Explore": "Stay read-only. Prefer read/search/status tools and avoid commands that need approval, writes, or execution side effects.",
        "Plan": "Stay read-only. Produce sequencing, ownership, and verification hooks without invoking commands that need approval or writes.",
        "general-purpose": "Execute the bounded implementation without gold-plating.",
        "Verification": "Try to break the result and separate verified from unverified claims.",
    }
    output_contract = {
        "coordinator": ["decision", "blockers", "next actor", "why now"],
        "Explore": ["files", "evidence", "open questions"],
        "Plan": ["step order", "critical files", "verification hooks"],
        "general-purpose": ["what changed", "key findings", "unfinished edges"],
        "Verification": ["Verified", "Not verified", "Risks", "Recommended next step"],
    }
    tool_policy = stage_tool_policy(actor)

    prompt_lines = [
        f"Role: {actor}",
        f"Stage id: {stage['id']}",
        f"Task goal: {goal}",
        f"Stage goal: {stage['goal']}",
        f"Depends on: {dependency_note}",
        f"Current task goal: {current_goal}",
        f"Current next step: {current_next}",
        f"Key files: {key_files}",
        f"Risk level: {orchestration['route']['risk_level']}",
        f"Permission level: {orchestration['permission']['level']}",
        f"Instruction: {actor_instructions.get(actor, 'Do the stage carefully.')}",
        "Output contract:",
    ]
    prompt_lines.extend([f"- {item}" for item in output_contract.get(actor, ["concise result"])])
    if tool_policy["prefer"]:
        prompt_lines.append("Prefer commands:")
        prompt_lines.extend([f"- {item}" for item in tool_policy["prefer"]])
    if tool_policy["avoid"]:
        prompt_lines.append("Avoid commands:")
        prompt_lines.extend([f"- {item}" for item in tool_policy["avoid"]])
    prompt_lines.extend(
        [
            f"Exit criteria: {stage['exit_criteria']}",
            "If a command asks for approval, stop and report the blocker instead of requesting approval.",
            "Do not pretend later stages are complete.",
        ]
    )
    return {
        "id": stage["id"],
        "actor": actor,
        "mode": stage["mode"],
        "model_tier": stage["model_tier"],
        "depends_on": stage["depends_on"],
        "goal": stage["goal"],
        "exit_criteria": stage["exit_criteria"],
        "prompt": "\n".join(prompt_lines),
        "output_contract": output_contract.get(actor, ["concise result"]),
    }


def render_dispatch_bundle_markdown(payload: dict[str, Any]) -> str:
    lines = [
        "# Dispatch Bundle",
        "",
        f"- Goal: {payload['goal']}",
        f"- Blocked: `{str(payload['blocked']).lower()}`",
        f"- Launchable stage: `{payload['launchable_stage']}`",
        f"- Bundle id: `{payload['bundle_id']}`",
        "- Blockers:",
    ]
    lines.extend([f"  - `{item}`" for item in payload["blockers"]] or ["  - `_none_`"])
    lines.append("- Stages:")
    for stage in payload["handoffs"]:
        lines.append(
            f"  - `{stage['id']}` actor=`{stage['actor']}` mode=`{stage['mode']}` model_tier=`{stage['model_tier']}` depends_on=`{','.join(stage['depends_on']) or '_none_'}`"
        )
    lines.append("- Closure skeleton:")
    for field in CLOSURE_FIELDS:
        lines.append(f"  - `{field}`")
    if "apply_result" in payload:
        lines.append("- Apply result:")
        for key, value in payload["apply_result"].items():
            lines.append(f"  - {key}: `{value}`")
    return "\n".join(lines) + "\n"


def apply_dispatch_bundle(workspace: Path, payload: dict[str, Any]) -> dict[str, Any]:
    dispatch_dir = workspace / "memory" / "dispatch"
    dispatch_dir.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    prefix = f"{timestamp}-{payload['bundle_id']}"
    json_path = dispatch_dir / f"{prefix}.json"
    md_path = dispatch_dir / f"{prefix}.md"
    json_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    md_path.write_text(render_dispatch_bundle_markdown(payload), encoding="utf-8")
    return {
        "json": str(json_path),
        "markdown": str(md_path),
    }


def build_dispatch_bundle(workspace: Path, message: str) -> dict[str, Any]:
    orchestration = build_task_orchestration(workspace, message)
    handoffs = [build_stage_handoff(stage, orchestration) for stage in orchestration["stages"]]
    blocked = bool(orchestration["blockers"])
    launchable_stage = None if blocked else next(
        (stage["id"] for stage in handoffs if stage["id"] != "closure"),
        "closure",
    )
    return {
        "bundle_id": _slugify(message),
        "goal": orchestration["goal"],
        "route": orchestration["route"],
        "permission": orchestration["permission"],
        "blockers": orchestration["blockers"],
        "blocked": blocked,
        "launchable_stage": launchable_stage,
        "handoffs": handoffs,
        "closure_skeleton": {field: "" for field in CLOSURE_FIELDS},
    }


def render_dispatch_run_markdown(payload: dict[str, Any]) -> str:
    lines = [
        "# Dispatch Run",
        "",
        f"- Run id: `{payload['run_id']}`",
        f"- Goal: {payload['goal']}",
        f"- Status: `{payload['status']}`",
        f"- Current stage: `{payload['current_stage']}`",
        f"- Created at: `{payload['created_at']}`",
        "- Stages:",
    ]
    for stage in payload["stages"]:
        lines.append(
            f"  - `{stage['id']}` actor=`{stage['actor']}` status=`{stage['status']}` depends_on=`{','.join(stage['depends_on']) or '_none_'}`"
        )
    if payload.get("verification_report"):
        lines.append("- Verification report:")
        for field in CLOSURE_FIELDS:
            lines.append(f"  - {field}: {', '.join(payload['verification_report'][field])}")
    if payload.get("latest_closeout_turn"):
        lines.append("- Latest closeout:")
        lines.append(f"  - stage: `{payload['latest_closeout_turn']['stage_id']}`")
        lines.append(
            f"  - recommended_apply: `{str(payload['latest_closeout_turn']['closeout_turn']['auto_memory']['recommended_apply']).lower()}`"
        )
        auto_memory = payload["latest_closeout_turn"]["closeout_turn"]["auto_memory"]
        if auto_memory.get("apply_result"):
            lines.append(f"  - memory_applied: `true`")
            lines.append(f"  - daily_note: `{auto_memory['apply_result']['daily_note']}`")
        if auto_memory.get("apply_skipped_reason"):
            lines.append(f"  - apply_skipped: `{auto_memory['apply_skipped_reason']}`")
    if "apply_result" in payload:
        lines.append("- Apply result:")
        for key, value in payload["apply_result"].items():
            lines.append(f"  - {key}: `{value}`")
    return "\n".join(lines) + "\n"


def _dispatch_runs_dir(workspace: Path) -> Path:
    return workspace / "memory" / "dispatch_runs"


def _write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def initialize_dispatch_run(bundle: dict[str, Any]) -> dict[str, Any]:
    stages = []
    current_stage = None if bundle["blocked"] else bundle["launchable_stage"]
    for stage in bundle["handoffs"]:
        status = "pending"
        if bundle["blocked"]:
            status = "blocked"
        elif stage["id"] == current_stage:
            status = "ready"
        stages.append(
            {
                **stage,
                "status": status,
                "result_text": None,
                "completed_at": None,
            }
        )
    return {
        "run_id": f"{datetime.now().strftime('%Y%m%d-%H%M%S')}-{bundle['bundle_id']}",
        "bundle_id": bundle["bundle_id"],
        "goal": bundle["goal"],
        "status": "blocked" if bundle["blocked"] else "active",
        "blocked": bundle["blocked"],
        "blockers": bundle["blockers"],
        "created_at": datetime.now().isoformat(timespec="seconds"),
        "current_stage": current_stage,
        "route": bundle["route"],
        "permission": bundle["permission"],
        "stages": stages,
        "closure_skeleton": bundle["closure_skeleton"],
        "verification_report": None,
        "latest_closeout_turn": None,
    }


def apply_dispatch_run(workspace: Path, payload: dict[str, Any]) -> dict[str, Any]:
    runs_dir = _dispatch_runs_dir(workspace)
    json_path = runs_dir / f"{payload['run_id']}.json"
    md_path = runs_dir / f"{payload['run_id']}.md"
    _write_json(json_path, payload)
    md_path.write_text(render_dispatch_run_markdown(payload), encoding="utf-8")
    return {
        "json": str(json_path),
        "markdown": str(md_path),
    }


def _resolve_dispatch_run_file(workspace: Path, run_file: str | None) -> Path:
    if run_file:
        return Path(run_file)
    runs_dir = _dispatch_runs_dir(workspace)
    candidates = sorted(runs_dir.glob("*.json"))
    if not candidates:
        raise FileNotFoundError("No dispatch run json found")
    return candidates[-1]


def load_dispatch_run(workspace: Path, run_file: str | None) -> tuple[Path, dict[str, Any]]:
    path = _resolve_dispatch_run_file(workspace, run_file)
    payload = read_json(path)
    if not isinstance(payload, dict):
        raise FileNotFoundError(f"Invalid dispatch run payload: {path}")
    return path, payload


def _agent_bridge_config_path(workspace: Path) -> Path:
    return workspace / "context" / "AGENT_BRIDGE.json"


def load_agent_bridge_config(workspace: Path) -> dict[str, Any]:
    path = _agent_bridge_config_path(workspace)
    raw = read_json(path) if path.exists() else {}
    if not isinstance(raw, dict):
        raw = {}

    role_to_agent = ROLE_AGENT_DEFAULTS.copy()
    if isinstance(raw.get("role_to_agent"), dict):
        for role, agent_id in raw["role_to_agent"].items():
            if isinstance(role, str) and isinstance(agent_id, str) and agent_id.strip():
                role_to_agent[role] = agent_id.strip()

    role_to_thinking = ROLE_THINKING_DEFAULTS.copy()
    if isinstance(raw.get("role_to_thinking"), dict):
        for role, thinking in raw["role_to_thinking"].items():
            if isinstance(role, str) and isinstance(thinking, str) and thinking.strip():
                role_to_thinking[role] = thinking.strip()

    default_agent = raw.get("default_agent")
    if not isinstance(default_agent, str) or not default_agent.strip():
        default_agent = "main"

    return {
        "config_path": str(path),
        "config_exists": path.exists(),
        "default_agent": default_agent.strip(),
        "role_to_agent": role_to_agent,
        "role_to_thinking": role_to_thinking,
    }


def list_native_agents(cmd_runner=None) -> dict[str, Any]:
    command = ["openclaw", "agents", "list", "--json"]
    runner = cmd_runner or subprocess.run
    try:
        result = runner(command, capture_output=True, text=True, check=False)
    except FileNotFoundError as exc:
        return {
            "ok": False,
            "command": shlex.join(command),
            "error": f"openclaw_not_found: {exc}",
            "agent_ids": [],
            "agents": [],
            "default_agent_id": None,
        }
    except OSError as exc:
        return {
            "ok": False,
            "command": shlex.join(command),
            "error": f"openclaw_exec_error: {exc}",
            "agent_ids": [],
            "agents": [],
            "default_agent_id": None,
        }

    stdout = result.stdout.strip()
    if result.returncode != 0:
        return {
            "ok": False,
            "command": shlex.join(command),
            "error": (result.stderr or stdout or f"exit_{result.returncode}").strip(),
            "agent_ids": [],
            "agents": [],
            "default_agent_id": None,
        }

    try:
        payload = json.loads(stdout or "[]")
    except json.JSONDecodeError as exc:
        return {
            "ok": False,
            "command": shlex.join(command),
            "error": f"invalid_json: {exc}",
            "stdout_preview": stdout[:400],
            "agent_ids": [],
            "agents": [],
            "default_agent_id": None,
        }

    entries = payload if isinstance(payload, list) else payload.get("agents", []) if isinstance(payload, dict) else []
    agents: list[dict[str, Any]] = []
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        agent_id = entry.get("id")
        if not isinstance(agent_id, str) or not agent_id.strip():
            continue
        agents.append(
            {
                "id": agent_id.strip(),
                "is_default": bool(entry.get("isDefault")),
                "workspace": entry.get("workspace"),
                "model": entry.get("model"),
            }
        )

    default_agent_id = next((entry["id"] for entry in agents if entry["is_default"]), None)
    return {
        "ok": True,
        "command": shlex.join(command),
        "agents": agents,
        "agent_ids": [entry["id"] for entry in agents],
        "default_agent_id": default_agent_id,
    }


def resolve_native_agent(actor: str, bridge: dict[str, Any], native_listing: dict[str, Any]) -> dict[str, Any]:
    available_ids = native_listing.get("agent_ids", [])
    configured_agent = bridge["role_to_agent"].get(actor, actor)
    default_agent = bridge["default_agent"]

    if actor in available_ids:
        resolved_agent = actor
        resolution = "actor_id_available"
    elif configured_agent in available_ids:
        resolved_agent = configured_agent
        resolution = "bridge_config_available"
    elif default_agent in available_ids:
        resolved_agent = default_agent
        resolution = "default_agent_fallback"
    elif native_listing.get("default_agent_id"):
        resolved_agent = native_listing["default_agent_id"]
        resolution = "native_default_agent_fallback"
    elif available_ids:
        resolved_agent = available_ids[0]
        resolution = "first_available_agent_fallback"
    else:
        resolved_agent = configured_agent or default_agent
        resolution = "no_native_agent_inventory"

    return {
        "actor": actor,
        "configured_agent": configured_agent,
        "resolved_agent": resolved_agent,
        "resolution": resolution,
        "available_agents_ok": native_listing.get("ok", False),
    }


def inspect_dispatch_bridge(workspace: Path, native_listing: dict[str, Any] | None = None) -> dict[str, Any]:
    bridge = load_agent_bridge_config(workspace)
    listing = native_listing or list_native_agents()
    roles = ["coordinator", "Explore", "Plan", "general-purpose", "Verification", "main"]
    role_targets = [resolve_native_agent(role, bridge, listing) for role in roles]
    return {
        "workspace": str(workspace),
        "bridge_config_path": bridge["config_path"],
        "bridge_config_exists": bridge["config_exists"],
        "default_agent": bridge["default_agent"],
        "available_agents_ok": listing.get("ok", False),
        "available_agents": listing.get("agents", []),
        "available_agent_ids": listing.get("agent_ids", []),
        "native_default_agent": listing.get("default_agent_id"),
        "role_targets": role_targets,
        **({"agent_inventory_error": listing["error"]} if listing.get("error") else {}),
    }


def render_dispatch_bridge_markdown(payload: dict[str, Any]) -> str:
    lines = [
        "# Dispatch Bridge",
        "",
        f"- Workspace: `{payload['workspace']}`",
        f"- Bridge config exists: `{str(payload['bridge_config_exists']).lower()}`",
        f"- Bridge config path: `{payload['bridge_config_path']}`",
        f"- Available agents ok: `{str(payload['available_agents_ok']).lower()}`",
        f"- Default agent: `{payload['default_agent']}`",
        f"- Native default agent: `{payload['native_default_agent'] or '_none_'}`",
        "- Available agent ids:",
    ]
    lines.extend([f"  - `{item}`" for item in payload["available_agent_ids"]] or ["  - `_none_`"])
    if payload.get("agent_inventory_error"):
        lines.append(f"- Agent inventory error: `{payload['agent_inventory_error']}`")
    lines.append("- Role targets:")
    for item in payload["role_targets"]:
        lines.append(
            f"  - actor=`{item['actor']}` configured=`{item['configured_agent']}` resolved=`{item['resolved_agent']}` resolution=`{item['resolution']}`"
        )
    return "\n".join(lines) + "\n"


def resolve_stage_thinking(actor: str, model_tier: str, bridge: dict[str, Any], override: str | None) -> tuple[str, str]:
    if override:
        return override, "cli_override"
    configured = bridge["role_to_thinking"].get(actor)
    if configured:
        return configured, "bridge_config"
    model_tier_map = {
        "fast": "low",
        "balanced": "medium",
        "strong": "high",
    }
    return model_tier_map.get(model_tier, "medium"), "model_tier_default"


def build_dispatch_launch_message(run_payload: dict[str, Any], stage: dict[str, Any]) -> str:
    return "\n".join(
        [
            stage["prompt"],
            "",
            f"Dispatch run id: {run_payload['run_id']}",
            f"Dispatch stage id: {stage['id']}",
            "Reply only with this stage output. Do not claim later stages are complete.",
        ]
    )


def _session_dir_for_agent(agent_id: str, session_root: Path = Path("/root/.openclaw/agents")) -> Path:
    return session_root / agent_id / "sessions"


def load_agent_session_state(agent_id: str, session_root: Path = Path("/root/.openclaw/agents")) -> dict[str, Any]:
    sessions_dir = _session_dir_for_agent(agent_id, session_root)
    sessions_path = sessions_dir / "sessions.json"
    payload = read_json(sessions_path)
    if not isinstance(payload, dict):
        return {
            "found": False,
            "agent_id": agent_id,
            "sessions_path": str(sessions_path),
        }

    latest_entry = None
    latest_updated_at = -1
    for session_key, entry in payload.items():
        if not isinstance(entry, dict):
            continue
        updated_at = int(entry.get("updatedAt") or entry.get("startedAt") or 0)
        if updated_at >= latest_updated_at:
            latest_updated_at = updated_at
            latest_entry = (session_key, entry)

    if latest_entry is None:
        return {
            "found": False,
            "agent_id": agent_id,
            "sessions_path": str(sessions_path),
        }

    session_key, entry = latest_entry
    session_file = entry.get("sessionFile")
    workspace_dir = ((entry.get("systemPromptReport") or {}).get("workspaceDir")) if isinstance(entry.get("systemPromptReport"), dict) else None
    return {
        "found": True,
        "agent_id": agent_id,
        "sessions_path": str(sessions_path),
        "session_id": entry.get("sessionId"),
        "session_key": session_key,
        "session_file": session_file,
        "status": entry.get("status"),
        "workspace_dir": workspace_dir,
        "updated_at": latest_updated_at if latest_updated_at >= 0 else None,
    }


def _extract_text_items(message: dict[str, Any]) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    for entry in message.get("content", []):
        if not isinstance(entry, dict) or entry.get("type") != "text":
            continue
        text = entry.get("text")
        if not isinstance(text, str) or not text.strip():
            continue
        signature = parse_text_signature(entry.get("textSignature"))
        items.append(
            {
                "text": text.strip(),
                "phase": signature.get("phase"),
                "signature": signature,
            }
        )
    return items


def _join_message_text(message: dict[str, Any]) -> str:
    return "\n".join(item["text"] for item in _extract_text_items(message)).strip()


def _is_internal_session_prompt(text: str | None) -> bool:
    if not text:
        return False
    stripped = text.strip()
    if not stripped:
        return False
    if stripped.startswith("System: [") and "A scheduled reminder has been triggered." in stripped:
        return True
    if "Read HEARTBEAT.md if it exists" in stripped:
        return True
    if "Dispatch run id:" in stripped and "Dispatch stage id:" in stripped:
        return True
    if "An async command did not run." in stripped and "Do not run the command again." in stripped:
        return True
    if "action_required:" in stripped and "Reply to the user in this same session" in stripped:
        return True
    return False


def _derive_goal_from_session_prompt(text: str | None) -> str:
    if not text:
        return "session closeout"

    in_code_block = False
    for raw_line in text.splitlines():
        stripped = raw_line.strip()
        if stripped.startswith("```"):
            in_code_block = not in_code_block
            continue
        if in_code_block:
            continue
        normalized = normalize_line(stripped)
        if not normalized:
            continue
        if normalized in {"{", "}", "[", "]"}:
            continue
        if normalized.startswith(("Conversation info", "Sender (untrusted metadata):")):
            continue
        if re.fullmatch(r'["{},:[\]0-9A-Za-z_.@+-]+', normalized):
            continue
        if normalized.startswith(
            (
                "System: [",
                "Role:",
                "Stage id:",
                "Task goal:",
                "Stage goal:",
                "Depends on:",
                "Current task goal:",
                "Current next step:",
                "Key files:",
                "Risk level:",
                "Permission level:",
                "Instruction:",
                "Output contract:",
                "Exit criteria:",
                "Dispatch run id:",
                "Dispatch stage id:",
                "Reply only with",
                "Read HEARTBEAT.md if it exists",
                "Current time:",
            )
        ):
            continue
        return normalized[:160]
    return normalize_line(text)[:160] or "session closeout"


def _candidate_session_log_paths(
    agent_id: str,
    session_root: Path,
    session_id: str | None = None,
    session_file: str | None = None,
) -> list[Path]:
    candidates: list[Path] = []

    def add_candidate(path: Path | None) -> None:
        if path is None or not path.exists() or path in candidates:
            return
        candidates.append(path)

    if session_file:
        path = Path(session_file)
        add_candidate(path)
        return candidates
    sessions_dir = _session_dir_for_agent(agent_id, session_root)
    if session_id:
        add_candidate(sessions_dir / f"{session_id}.jsonl")
        return candidates
    state = load_agent_session_state(agent_id, session_root)
    state_file = state.get("session_file")
    if isinstance(state_file, str):
        add_candidate(Path(state_file))
    state_session_id = state.get("session_id")
    if isinstance(state_session_id, str) and state_session_id:
        add_candidate(sessions_dir / f"{state_session_id}.jsonl")
    if sessions_dir.exists():
        recent_logs = sorted(sessions_dir.glob("*.jsonl"), key=lambda path: path.stat().st_mtime, reverse=True)[:5]
        for path in recent_logs:
            add_candidate(path)
    return candidates


def find_latest_session_closeout_turn(
    agent_id: str,
    session_root: Path = Path("/root/.openclaw/agents"),
    session_id: str | None = None,
    session_file: str | None = None,
    include_internal: bool = False,
    latest_turn_only: bool = False,
) -> dict[str, Any]:
    session_paths = _candidate_session_log_paths(
        agent_id=agent_id,
        session_root=session_root,
        session_id=session_id,
        session_file=session_file,
    )
    if not session_paths:
        return {
            "found": False,
            "reason": "session_log_missing",
            "agent_id": agent_id,
        }

    searched_paths: list[str] = []
    total_turns = 0

    for session_path in session_paths:
        searched_paths.append(str(session_path))
        records = _load_jsonl_records(session_path)
        turns: list[dict[str, Any]] = []
        current_turn: dict[str, Any] | None = None

        for record in records:
            message = record.get("message", {})
            role = message.get("role")
            if role == "user":
                if current_turn:
                    turns.append(current_turn)
                current_turn = {
                    "prompt_text": _join_message_text(message),
                    "prompt_timestamp": record.get("timestamp"),
                    "reply_text": None,
                    "commentary_text": None,
                    "approval_requests": [],
                    "error_messages": [],
                }
                continue

            if current_turn is None:
                continue

            if role == "assistant":
                for item in _extract_text_items(message):
                    text = item["text"]
                    if is_approval_text(text):
                        current_turn["approval_requests"].append(text)
                    elif item["phase"] == "final_answer" and text != "NO_REPLY":
                        current_turn["reply_text"] = text
                    elif item["phase"] == "commentary" and current_turn["commentary_text"] is None:
                        current_turn["commentary_text"] = text
                error_message = record.get("errorMessage")
                if isinstance(error_message, str) and error_message.strip():
                    current_turn["error_messages"].append(error_message.strip())
            elif role == "toolResult":
                for item in _extract_text_items(message):
                    if item["text"].startswith("Approval required "):
                        current_turn["approval_requests"].append(item["text"])

        if current_turn:
            turns.append(current_turn)
        total_turns += len(turns)

        candidate_turns = [turns[-1]] if latest_turn_only and turns else list(reversed(turns))
        for turn in candidate_turns:
            internal_prompt = _is_internal_session_prompt(turn["prompt_text"])
            if not turn.get("reply_text"):
                if latest_turn_only:
                    return {
                        "found": False,
                        "reason": "latest_turn_missing_reply",
                        "agent_id": agent_id,
                        "session_path": str(session_path),
                        "session_id": session_path.stem,
                        "prompt_text": turn["prompt_text"],
                        "prompt_timestamp": turn["prompt_timestamp"],
                        "internal_prompt": internal_prompt,
                        "considered_turns": total_turns,
                        "searched_session_paths": searched_paths,
                    }
                continue
            if internal_prompt and not include_internal:
                if latest_turn_only:
                    return {
                        "found": False,
                        "reason": "latest_turn_internal_prompt",
                        "agent_id": agent_id,
                        "session_path": str(session_path),
                        "session_id": session_path.stem,
                        "prompt_text": turn["prompt_text"],
                        "prompt_timestamp": turn["prompt_timestamp"],
                        "reply_text": turn["reply_text"],
                        "commentary_text": turn["commentary_text"],
                        "approval_requests": turn["approval_requests"],
                        "error_messages": turn["error_messages"],
                        "internal_prompt": True,
                        "considered_turns": total_turns,
                        "searched_session_paths": searched_paths,
                    }
                continue
            goal_suggestion = _derive_goal_from_session_prompt(turn["prompt_text"])
            return {
                "found": True,
                "agent_id": agent_id,
                "session_path": str(session_path),
                "session_id": session_path.stem,
                "prompt_text": turn["prompt_text"],
                "prompt_timestamp": turn["prompt_timestamp"],
                "reply_text": turn["reply_text"],
                "commentary_text": turn["commentary_text"],
                "approval_requests": turn["approval_requests"],
                "error_messages": turn["error_messages"],
                "internal_prompt": internal_prompt,
                "goal_suggestion": goal_suggestion,
                "considered_turns": total_turns,
                "searched_session_paths": searched_paths,
            }

    return {
        "found": False,
        "reason": "no_real_turn_found" if total_turns else "session_has_no_reply_turns",
        "agent_id": agent_id,
        "session_path": searched_paths[0],
        "session_id": Path(searched_paths[0]).stem,
        "considered_turns": total_turns,
        "searched_session_paths": searched_paths,
    }


def build_session_closeout(
    workspace: Path,
    agent_id: str,
    min_items: int,
    apply_memory: bool,
    goal: str | None = None,
    session_root: Path = Path("/root/.openclaw/agents"),
    session_id: str | None = None,
    session_file: str | None = None,
    include_internal: bool = False,
    latest_turn_only: bool = False,
) -> dict[str, Any]:
    session_turn = find_latest_session_closeout_turn(
        agent_id=agent_id,
        session_root=session_root,
        session_id=session_id,
        session_file=session_file,
        include_internal=include_internal,
        latest_turn_only=latest_turn_only,
    )
    if not session_turn.get("found"):
        return {
            **session_turn,
            "workspace": str(workspace),
        }

    resolved_goal = goal or session_turn.get("goal_suggestion") or "session closeout"
    closeout_turn = build_closeout_turn(
        workspace=workspace,
        goal=resolved_goal,
        text=session_turn["reply_text"],
        min_items=min_items,
        apply_memory=apply_memory,
    )
    return {
        **session_turn,
        "workspace": str(workspace),
        "goal": resolved_goal,
        "closeout_turn": closeout_turn,
    }


def apply_session_closeout(
    workspace: Path,
    payload: dict[str, Any],
    run_id: str | None = None,
    source: str | None = None,
) -> dict[str, Any]:
    return apply_closeout_turn(
        workspace=workspace,
        payload=payload["closeout_turn"],
        run_id=run_id,
        source=source or f"session:{payload['agent_id']}:{payload['session_id']}",
    )


def find_dispatch_session_result(
    agent_id: str,
    run_id: str,
    stage_id: str,
    session_root: Path = Path("/root/.openclaw/agents"),
    max_files: int = 3,
) -> dict[str, Any]:
    sessions_dir = _session_dir_for_agent(agent_id, session_root)
    if not sessions_dir.exists():
        return {
            "found": False,
            "reason": "sessions_dir_missing",
            "agent_id": agent_id,
            "run_id": run_id,
            "stage_id": stage_id,
        }

    markers = (f"Dispatch run id: {run_id}", f"Dispatch stage id: {stage_id}")
    candidate_files = sorted(
        sessions_dir.glob("*.jsonl"),
        key=lambda path: path.stat().st_mtime,
        reverse=True,
    )[:max_files]

    for path in candidate_files:
        try:
            lines = path.read_text(encoding="utf-8").splitlines()
        except OSError:
            continue

        prompt_index = None
        prompt_timestamp = None
        for index in range(len(lines) - 1, -1, -1):
            try:
                record = json.loads(lines[index])
            except json.JSONDecodeError:
                continue
            message = record.get("message", {})
            if message.get("role") != "user":
                continue
            text_entries = _extract_text_items(message)
            joined = "\n".join(item["text"] for item in text_entries)
            if all(marker in joined for marker in markers):
                prompt_index = index
                prompt_timestamp = record.get("timestamp")
                break

        if prompt_index is None:
            continue

        final_text = None
        commentary_text = None
        error_messages: list[str] = []
        approval_requests: list[str] = []
        records_seen = 0

        for raw_line in lines[prompt_index + 1 :]:
            try:
                record = json.loads(raw_line)
            except json.JSONDecodeError:
                continue
            message = record.get("message", {})
            role = message.get("role")
            if role == "user":
                break
            if role == "assistant":
                records_seen += 1
                text_items = _extract_text_items(message)
                for item in text_items:
                    if is_approval_text(item["text"]):
                        approval_requests.append(item["text"])
                    elif item["phase"] == "final_answer" and item["text"] != "NO_REPLY":
                        final_text = item["text"]
                    elif item["phase"] == "commentary" and commentary_text is None:
                        commentary_text = item["text"]
                error_message = record.get("errorMessage")
                if isinstance(error_message, str) and error_message.strip():
                    error_messages.append(error_message.strip())
            elif role == "toolResult":
                for item in _extract_text_items(message):
                    if item["text"].startswith("Approval required "):
                        approval_requests.append(item["text"])

        return {
            "found": True,
            "session_path": str(path),
            "session_id": path.stem,
            "prompt_timestamp": prompt_timestamp,
            "reply_text": final_text,
            "commentary_text": commentary_text,
            "error_messages": error_messages,
            "approval_requests": approval_requests,
            "records_seen": records_seen,
        }

    return {
        "found": False,
        "reason": "dispatch_prompt_not_found",
        "agent_id": agent_id,
        "run_id": run_id,
        "stage_id": stage_id,
    }


def load_gateway_auth_env(
    config_path: Path = Path("/root/.openclaw/openclaw.json"),
    secrets_env_path: Path = Path("/root/.openclaw/openclaw-secrets.env"),
    base_env: dict[str, str] | None = None,
) -> dict[str, Any]:
    env = dict(base_env or os.environ)
    config = read_json(config_path)
    if not isinstance(config, dict):
        return {
            "env": {},
            "injected_keys": [],
            "reason": "config_missing_or_invalid",
        }

    gateway = config.get("gateway")
    auth = gateway.get("auth") if isinstance(gateway, dict) else None
    if not isinstance(auth, dict):
        return {
            "env": {},
            "injected_keys": [],
            "reason": "gateway_auth_missing",
        }

    mode = auth.get("mode")
    if mode not in {"token", "password"}:
        return {
            "env": {},
            "injected_keys": [],
            "reason": f"unsupported_auth_mode:{mode}",
        }

    source_key = "token" if mode == "token" else "password"
    source = auth.get(source_key)
    if not isinstance(source, dict) or source.get("source") != "env":
        return {
            "env": {},
            "injected_keys": [],
            "reason": "auth_env_source_not_configured",
        }

    env_id = source.get("id")
    if not isinstance(env_id, str) or not env_id.strip():
        env_id = "OPENCLAW_GATEWAY_AUTH_TOKEN" if mode == "token" else "OPENCLAW_GATEWAY_PASSWORD"
    env_id = env_id.strip()
    compatibility_key = "OPENCLAW_GATEWAY_TOKEN" if mode == "token" else "OPENCLAW_GATEWAY_PASSWORD"

    if env.get(env_id):
        injected = {}
        if compatibility_key != env_id and not env.get(compatibility_key):
            injected[compatibility_key] = env[env_id]
        return {
            "env": injected,
            "injected_keys": sorted(injected.keys()),
            "reason": "already_present_in_env",
        }

    secrets = read_env_file(secrets_env_path)
    value = secrets.get(env_id)
    if not value:
        return {
            "env": {},
            "injected_keys": [],
            "reason": "secret_value_not_found",
        }

    injected = {env_id: value}
    if compatibility_key != env_id:
        injected[compatibility_key] = value
    return {
        "env": injected,
        "injected_keys": sorted(injected.keys()),
        "reason": "loaded_from_secrets_env",
    }


def _is_gateway_transport_error(text: str) -> bool:
    lowered = text.lower()
    return any(
        marker in lowered
        for marker in (
            "gateway closed",
            "gateway agent failed",
            "failed to resolve secrets from the active gateway snapshot",
            "start the gateway and retry",
        )
    )


def resolve_dispatch_stage_target(
    workspace: Path,
    stage: dict[str, Any],
    thinking: str | None,
    native_listing: dict[str, Any] | None = None,
) -> dict[str, Any]:
    bridge = load_agent_bridge_config(workspace)
    listing = native_listing or list_native_agents()
    target = resolve_native_agent(stage["actor"], bridge, listing)
    target_session_state = load_agent_session_state(target["resolved_agent"])
    fallback_from_agent = None
    fallback_reason = None
    if (
        target_session_state.get("found")
        and target_session_state.get("status") == "running"
        and target_session_state.get("workspace_dir")
        and Path(target_session_state["workspace_dir"]) != workspace
    ):
        fallback_target = resolve_native_agent("main", bridge, listing)
        if fallback_target["resolved_agent"] != target["resolved_agent"]:
            fallback_from_agent = target["resolved_agent"]
            fallback_reason = "stale_running_session_workspace_mismatch"
            target = fallback_target
    resolved_thinking, thinking_source = resolve_stage_thinking(stage["actor"], stage["model_tier"], bridge, thinking)
    return {
        "resolved_agent": target["resolved_agent"],
        "agent_resolution": target["resolution"],
        "configured_agent": target["configured_agent"],
        "target_session_state": target_session_state,
        "fallback_from_agent": fallback_from_agent,
        "fallback_reason": fallback_reason,
        "available_agents_ok": listing.get("ok", False),
        "available_agent_ids": listing.get("agent_ids", []),
        "thinking": resolved_thinking,
        "thinking_source": thinking_source,
    }


def build_dispatch_launch_payload(
    workspace: Path,
    run_file: str | None,
    stage_id: str | None,
    session_id: str | None,
    channel: str | None,
    to: str | None,
    deliver: bool,
    local: bool,
    reply_channel: str | None,
    reply_to: str | None,
    reply_account: str | None,
    thinking: str | None,
    native_listing: dict[str, Any] | None = None,
) -> dict[str, Any]:
    run_path, run_payload = load_dispatch_run(workspace, run_file)
    active_stage_id = stage_id or run_payload.get("current_stage")
    if not active_stage_id:
        raise ValueError("No current ready stage in dispatch run")

    stage = next((item for item in run_payload["stages"] if item["id"] == active_stage_id), None)
    if stage is None:
        raise KeyError(f"Unknown stage id: {active_stage_id}")
    if stage["status"] not in {"ready", "in_progress"}:
        raise ValueError(f"Stage {active_stage_id} is not launchable from status {stage['status']}")

    target = resolve_dispatch_stage_target(workspace, stage, thinking, native_listing=native_listing)
    message = build_dispatch_launch_message(run_payload, stage)

    command = [
        "openclaw",
        "agent",
        "--agent",
        target["resolved_agent"],
        "--message",
        message,
        "--json",
        "--thinking",
        target["thinking"],
    ]
    if session_id:
        command.extend(["--session-id", session_id])
    if channel:
        command.extend(["--channel", channel])
    if to:
        command.extend(["--to", to])
    if deliver:
        command.append("--deliver")
    if local:
        command.append("--local")
    if reply_channel:
        command.extend(["--reply-channel", reply_channel])
    if reply_to:
        command.extend(["--reply-to", reply_to])
    if reply_account:
        command.extend(["--reply-account", reply_account])

    return {
        "workspace": str(workspace),
        "run_id": run_payload["run_id"],
        "run_file": str(run_path),
        "stage_id": stage["id"],
        "stage_status": stage["status"],
        "actor": stage["actor"],
        "resolved_agent": target["resolved_agent"],
        "agent_resolution": target["agent_resolution"],
        "configured_agent": target["configured_agent"],
        "target_session_state": target["target_session_state"],
        "fallback_from_agent": target["fallback_from_agent"],
        "fallback_reason": target["fallback_reason"],
        "available_agents_ok": target["available_agents_ok"],
        "available_agent_ids": target["available_agent_ids"],
        "thinking": target["thinking"],
        "thinking_source": target["thinking_source"],
        "message": message,
        "command": command,
        "launch_command": shlex.join(command),
        "dispatch_update_hint": (
            f"python3 {shlex.quote(str(workspace / 'scripts/openclaw_harness.py'))} "
            f"dispatch-update --workspace {shlex.quote(str(workspace))} "
            f"--run-file {shlex.quote(str(run_path))} --stage {stage['id']} --file /tmp/{run_payload['run_id']}-{stage['id']}.txt"
        ),
    }


def render_dispatch_launch_markdown(payload: dict[str, Any]) -> str:
    lines = [
        "# Dispatch Launch",
        "",
        f"- Run id: `{payload['run_id']}`",
        f"- Run file: `{payload['run_file']}`",
        f"- Stage id: `{payload['stage_id']}`",
        f"- Stage status: `{payload['stage_status']}`",
        f"- Actor: `{payload['actor']}`",
        f"- Resolved agent: `{payload['resolved_agent']}`",
        f"- Agent resolution: `{payload['agent_resolution']}`",
        f"- Fallback from agent: `{payload.get('fallback_from_agent') or '_none_'}`",
        f"- Fallback reason: `{payload.get('fallback_reason') or '_none_'}`",
        f"- Thinking: `{payload['thinking']}`",
        f"- Thinking source: `{payload['thinking_source']}`",
        "- Available agent ids:",
    ]
    lines.extend([f"  - `{item}`" for item in payload["available_agent_ids"]] or ["  - `_none_`"])
    lines.extend(
        [
            "- Launch command:",
            f"  - `{payload['launch_command']}`",
            "- Dispatch update hint:",
            f"  - `{payload['dispatch_update_hint']}`",
        ]
    )
    if "apply_result" in payload:
        lines.append("- Apply result:")
        for key, value in payload["apply_result"].items():
            lines.append(f"  - {key}: `{value}`")
    if "execution" in payload:
        lines.append("- Execution:")
        for key, value in payload["execution"].items():
            if isinstance(value, (dict, list)):
                rendered = json.dumps(value, ensure_ascii=False)
            else:
                rendered = str(value)
            lines.append(f"  - {key}: `{rendered}`")
    if "auto_update_result" in payload:
        lines.append("- Auto update result:")
        for key, value in payload["auto_update_result"].items():
            lines.append(f"  - {key}: `{value}`")
    return "\n".join(lines) + "\n"


def apply_dispatch_launch(workspace: Path, run_file: str | None, launch_payload: dict[str, Any]) -> dict[str, Any]:
    _, run_payload = load_dispatch_run(workspace, run_file)
    stage = next((item for item in run_payload["stages"] if item["id"] == launch_payload["stage_id"]), None)
    if stage is None:
        raise KeyError(f"Unknown stage id: {launch_payload['stage_id']}")
    if stage["status"] == "ready":
        stage["status"] = "in_progress"
    stage["launch"] = {
        "launched_at": datetime.now().isoformat(timespec="seconds"),
        "resolved_agent": launch_payload["resolved_agent"],
        "agent_resolution": launch_payload["agent_resolution"],
        "thinking": launch_payload["thinking"],
        "launch_command": launch_payload["launch_command"],
    }
    if "execution" in launch_payload:
        stage["launch"]["execution"] = launch_payload["execution"]
    run_payload["current_stage"] = stage["id"]
    run_payload["updated_at"] = datetime.now().isoformat(timespec="seconds")
    apply_result = apply_dispatch_run(workspace, run_payload)
    return {
        "json": apply_result["json"],
        "markdown": apply_result["markdown"],
        "run_status": run_payload["status"],
        "stage_status": stage["status"],
    }


def execute_dispatch_launch(launch_payload: dict[str, Any], cmd_runner=None, timeout_seconds: int | None = None) -> dict[str, Any]:
    runner = cmd_runner or subprocess.run
    gateway_auth = load_gateway_auth_env()
    secrets_env = read_env_file(Path("/root/.openclaw/openclaw-secrets.env"))
    exec_env = os.environ.copy()
    exec_env.update(secrets_env)
    exec_env.update(gateway_auth["env"])
    try:
        result = runner(
            launch_payload["command"],
            capture_output=True,
            text=True,
            check=False,
            env=exec_env,
            timeout=timeout_seconds,
        )
    except subprocess.TimeoutExpired as exc:
        return {
            "returncode": None,
            "executed_at": datetime.now().isoformat(timespec="seconds"),
            "gateway_auth_reason": gateway_auth["reason"],
            "gateway_auth_injected_keys": gateway_auth["injected_keys"],
            "secrets_env_loaded": bool(secrets_env),
            "secrets_env_key_count": len(secrets_env),
            "command_mode": "gateway",
            "timed_out": True,
            "timeout_seconds": timeout_seconds,
            **({"stdout_preview": exc.stdout[:2000]} if isinstance(exc.stdout, str) and exc.stdout else {}),
            **({"stderr_preview": exc.stderr[:1000]} if isinstance(exc.stderr, str) and exc.stderr else {}),
        }
    active_command = launch_payload["command"]
    primary_result = result
    fallback_attempted = False

    combined_error = "\n".join(part for part in (result.stdout.strip(), result.stderr.strip()) if part)
    if result.returncode != 0 and "--local" not in launch_payload["command"] and _is_gateway_transport_error(combined_error):
        fallback_attempted = True
        active_command = [*launch_payload["command"], "--local"]
        result = runner(active_command, capture_output=True, text=True, check=False, env=exec_env)

    stdout = result.stdout.strip()
    stderr = result.stderr.strip()
    execution: dict[str, Any] = {
        "returncode": result.returncode,
        "executed_at": datetime.now().isoformat(timespec="seconds"),
        "gateway_auth_reason": gateway_auth["reason"],
        "gateway_auth_injected_keys": gateway_auth["injected_keys"],
        "secrets_env_loaded": bool(secrets_env),
        "secrets_env_key_count": len(secrets_env),
        "command_mode": "local" if "--local" in active_command else "gateway",
        "embedded_fallback_detected": "falling back to embedded" in stderr.lower(),
        **({"timeout_seconds": timeout_seconds} if timeout_seconds is not None else {}),
    }
    if fallback_attempted:
        execution["fallback_attempted"] = True
        execution["fallback_mode"] = "local"
        execution["primary_returncode"] = primary_result.returncode
        primary_stderr = primary_result.stderr.strip()
        if primary_stderr:
            execution["primary_stderr_preview"] = primary_stderr[:1000]
    if stdout:
        try:
            execution["stdout_json"] = json.loads(stdout)
        except json.JSONDecodeError:
            execution["stdout_preview"] = stdout[:2000]
    if stderr:
        execution["stderr_preview"] = stderr[:1000]
    return execution


def extract_agent_output_text(data: Any) -> str | None:
    if isinstance(data, str):
        stripped = data.strip()
        if not stripped or is_approval_text(stripped):
            return None
        return stripped

    if isinstance(data, list):
        for item in data:
            extracted = extract_agent_output_text(item)
            if extracted:
                return extracted
        return None

    if isinstance(data, dict):
        if isinstance(data.get("payloads"), list):
            extracted = extract_agent_output_text(data.get("payloads"))
            if extracted:
                return extracted

        if isinstance(data.get("content"), list):
            extracted = extract_agent_output_text(data.get("content"))
            if extracted:
                return extracted

        message = data.get("message")
        if isinstance(message, dict):
            extracted = extract_agent_output_text(message.get("content"))
            if extracted:
                return extracted

        for key in ("reply", "response", "output", "result", "data"):
            value = data.get(key)
            if value is None:
                continue
            extracted = extract_agent_output_text(value)
            if extracted:
                return extracted

        text_value = data.get("text")
        if isinstance(text_value, str):
            extracted = extract_agent_output_text(text_value)
            if extracted:
                return extracted

    return None


def contains_approval_payload(data: Any) -> bool:
    if isinstance(data, str):
        return is_approval_text(data)
    if isinstance(data, list):
        return any(contains_approval_payload(item) for item in data)
    if isinstance(data, dict):
        return any(contains_approval_payload(value) for value in data.values())
    return False


def auto_update_dispatch_run_from_execution(
    workspace: Path,
    run_file: str | None,
    stage_id: str,
    execution: dict[str, Any],
    launch_payload: dict[str, Any] | None = None,
    apply_closeout_memory: bool = False,
    closeout_min_items: int = 2,
) -> dict[str, Any]:
    if execution.get("timed_out"):
        return {
            "updated": False,
            "reason": "command_timeout",
            "timeout_seconds": execution.get("timeout_seconds"),
        }
    if execution.get("returncode") != 0:
        return {
            "updated": False,
            "reason": "command_failed",
        }
    if contains_approval_payload(execution.get("stdout_json")) or contains_approval_payload(execution.get("stdout_preview")):
        return {
            "updated": False,
            "reason": "approval_required",
        }

    text = extract_agent_output_text(execution.get("stdout_json"))
    if not text:
        text = extract_agent_output_text(execution.get("stdout_preview"))
    session_result = None
    if not text and launch_payload:
        session_result = find_dispatch_session_result(
            agent_id=launch_payload["resolved_agent"],
            run_id=launch_payload["run_id"],
            stage_id=stage_id,
        )
        text = session_result.get("reply_text") if isinstance(session_result, dict) else None
    if text and is_approval_text(text):
        return {
            "updated": False,
            "reason": "approval_required",
        }
    if session_result and session_result.get("approval_requests") and not text:
        return {
            "updated": False,
            "reason": "approval_required",
            "session_result": session_result,
        }
    if not text:
        if session_result and session_result.get("error_messages"):
            return {
                "updated": False,
                "reason": "session_error_detected",
                "session_result": session_result,
            }
        return {
            "updated": False,
            "reason": "no_result_text_extracted",
            **({"session_result": session_result} if session_result else {}),
        }

    updated = update_dispatch_run(
        workspace,
        run_file,
        stage_id,
        text,
        apply_closeout_memory=apply_closeout_memory,
        closeout_min_items=closeout_min_items,
    )
    return {
        "updated": True,
        "stage_id": stage_id,
        "extracted_text": text,
        "current_stage": updated["current_stage"],
        "run_status": updated["status"],
        **({"session_result": session_result} if session_result else {}),
    }


def sync_dispatch_run_from_session(
    workspace: Path,
    run_file: str | None,
    stage_id: str | None,
    apply_closeout_memory: bool = False,
    closeout_min_items: int = 2,
    native_listing: dict[str, Any] | None = None,
    session_root: Path = Path("/root/.openclaw/agents"),
) -> dict[str, Any]:
    run_path, run_payload = load_dispatch_run(workspace, run_file)
    active_stage_id = stage_id or run_payload.get("current_stage")
    if not active_stage_id:
        raise ValueError("No current ready stage in dispatch run")
    stage = next((item for item in run_payload["stages"] if item["id"] == active_stage_id), None)
    if stage is None:
        raise KeyError(f"Unknown stage id: {active_stage_id}")
    if stage["status"] == "completed":
        return {
            "updated": False,
            "reason": "stage_already_completed",
            "run_id": run_payload["run_id"],
            "run_file": str(run_path),
            "stage_id": stage["id"],
            "stage_status": stage["status"],
            "actor": stage["actor"],
            "resolved_agent": None,
            "agent_resolution": None,
            "fallback_from_agent": None,
            "fallback_reason": None,
            "session_result": {},
        }
    target = resolve_dispatch_stage_target(workspace, stage, thinking=None, native_listing=native_listing)
    session_result = find_dispatch_session_result(
        agent_id=target["resolved_agent"],
        run_id=run_payload["run_id"],
        stage_id=stage["id"],
        session_root=session_root,
    )
    payload = {
        "updated": False,
        "run_id": run_payload["run_id"],
        "run_file": str(run_path),
        "stage_id": stage["id"],
        "stage_status": stage["status"],
        "actor": stage["actor"],
        "resolved_agent": target["resolved_agent"],
        "agent_resolution": target["agent_resolution"],
        "fallback_from_agent": target.get("fallback_from_agent"),
        "fallback_reason": target.get("fallback_reason"),
        "session_result": session_result,
    }
    if not session_result.get("found"):
        payload["reason"] = session_result.get("reason", "session_result_missing")
        return payload
    text = session_result.get("reply_text")
    if session_result.get("approval_requests"):
        payload["approval_requests_seen"] = True
        if not isinstance(text, str) or not text.strip():
            payload["reason"] = "approval_required"
            return payload
    if isinstance(text, str) and is_approval_text(text):
        payload["reason"] = "approval_required"
        return payload
    if not isinstance(text, str) or not text.strip():
        if session_result.get("error_messages"):
            payload["reason"] = "session_error_detected"
        else:
            payload["reason"] = "session_result_pending"
        return payload

    updated = update_dispatch_run(
        workspace,
        run_file,
        stage["id"],
        text,
        apply_closeout_memory=apply_closeout_memory,
        closeout_min_items=closeout_min_items,
    )
    payload.update(
        {
            "updated": True,
            "reason": "updated_from_session",
            "extracted_text": text,
            "current_stage": updated["current_stage"],
            "run_status": updated["status"],
        }
    )
    return payload


def update_dispatch_run(
    workspace: Path,
    run_file: str | None,
    stage_id: str,
    text: str,
    apply_closeout_memory: bool = False,
    closeout_min_items: int = 2,
) -> dict[str, Any]:
    path, payload = load_dispatch_run(workspace, run_file)
    stage_map = {stage["id"]: stage for stage in payload["stages"]}
    if stage_id not in stage_map:
        raise KeyError(f"Unknown stage id: {stage_id}")
    stage = stage_map[stage_id]
    if stage["status"] not in {"ready", "in_progress"}:
        raise ValueError(f"Stage {stage_id} is not updatable from status {stage['status']}")
    stage["status"] = "completed"
    stage["result_text"] = text
    stage["completed_at"] = datetime.now().isoformat(timespec="seconds")

    if stage["actor"] in {"general-purpose", "Verification", "coordinator"}:
        closeout_source_text = text
        if stage["actor"] == "coordinator" and stage["id"] == "closure" and isinstance(payload.get("verification_report"), dict):
            closeout_source_text = "\n".join(
                f"{field}: {', '.join(payload['verification_report'].get(field, []))}"
                for field in CLOSURE_FIELDS
            )
        closeout_turn = build_closeout_turn(
            workspace,
            payload["goal"],
            closeout_source_text,
            min_items=closeout_min_items,
            apply_memory=apply_closeout_memory,
        )
        closeout_apply_result = apply_closeout_turn(
            workspace,
            closeout_turn,
            stage_id=stage_id,
            run_id=payload["run_id"],
            source="dispatch-update",
        )
        closeout_turn["persist_result"] = closeout_apply_result
        stage["closeout_turn"] = closeout_turn
        payload["latest_closeout_turn"] = {
            "stage_id": stage_id,
            "closeout_turn": closeout_turn,
        }

    if stage["actor"] == "Verification":
        payload["verification_report"] = payload["latest_closeout_turn"]["closeout_turn"]["closure_report"]

    next_stage_id = None
    for candidate in payload["stages"]:
        if candidate["status"] != "pending":
            continue
        dependencies_met = all(stage_map[dep]["status"] == "completed" for dep in candidate["depends_on"])
        if dependencies_met:
            candidate["status"] = "ready"
            next_stage_id = candidate["id"]
            break

    payload["current_stage"] = next_stage_id
    if next_stage_id is None:
        payload["status"] = "completed"
    else:
        payload["status"] = "active"
    payload["updated_at"] = datetime.now().isoformat(timespec="seconds")
    apply_result = apply_dispatch_run(workspace, payload)
    payload["apply_result"] = apply_result
    return payload


def rewind_dispatch_run(workspace: Path, run_file: str | None, stage_id: str) -> dict[str, Any]:
    path, payload = load_dispatch_run(workspace, run_file)
    stages = payload["stages"]
    stage_map = {stage["id"]: stage for stage in stages}
    if stage_id not in stage_map:
        raise KeyError(f"Unknown stage id: {stage_id}")

    target_index = next(index for index, stage in enumerate(stages) if stage["id"] == stage_id)
    target = stages[target_index]

    for index, stage in enumerate(stages):
        if index < target_index:
            continue
        stage["result_text"] = None
        stage["completed_at"] = None
        stage.pop("launch", None)
        stage.pop("closeout_turn", None)
        if index == target_index:
            stage["status"] = "ready"
        else:
            stage["status"] = "pending"

    payload["current_stage"] = target["id"]
    payload["status"] = "active"
    if target_index <= next((i for i, stage in enumerate(stages) if stage["id"] == "verification"), len(stages)):
        payload["verification_report"] = None
    latest_closeout = payload.get("latest_closeout_turn")
    if isinstance(latest_closeout, dict):
        latest_stage_id = latest_closeout.get("stage_id")
        latest_index = next((i for i, stage in enumerate(stages) if stage["id"] == latest_stage_id), None)
        if latest_index is None or latest_index >= target_index:
            payload["latest_closeout_turn"] = None
    payload["updated_at"] = datetime.now().isoformat(timespec="seconds")
    apply_result = apply_dispatch_run(workspace, payload)
    payload["apply_result"] = apply_result
    return payload


def collect_text(args_text: str | None, file_path: str | None) -> str:
    if args_text:
        return args_text
    if file_path:
        return Path(file_path).read_text(encoding="utf-8")
    return sys.stdin.read()


def lint_report(text: str, strict: bool) -> dict[str, Any]:
    present = []
    missing = []
    warnings = []
    section_values: dict[str, str] = {}
    for section in REPORT_SECTIONS:
        pattern = rf"(?im)^\s*-\s*{re.escape(section)}\s*:\s*(.+?)\s*$"
        match = re.search(pattern, text)
        if not match:
            missing.append(section)
            continue
        value = match.group(1).strip()
        section_values[section] = value
        present.append(section)

    recommended_next = section_values.get("Recommended next step")
    if recommended_next is not None and is_placeholder_value(recommended_next):
        if "Recommended next step" not in missing:
            missing.append("Recommended next step")
        warnings.append("placeholder_value_in_recommended_next_step")

    verified_value = section_values.get("Verified")
    verified_ok = verified_value is not None and not is_placeholder_value(verified_value)
    not_verified_value = section_values.get("Not verified")
    not_verified_ok = (
        not_verified_value is not None
        and not not_verified_value.strip().lower() == "_none_"
        and not is_placeholder_value(not_verified_value)
    )
    if not verified_ok and not not_verified_ok:
        for section in ("Verified", "Not verified"):
            if section not in missing:
                missing.append(section)
        warnings.append("verified_and_not_verified_are_both_placeholder")

    risks_value = section_values.get("Risks")
    if risks_value is not None and is_placeholder_value(risks_value) and risks_value.strip().lower() != "_none_":
        if "Risks" not in missing:
            missing.append("Risks")
        warnings.append("placeholder_value_in_risks")

    if re.search(r"(?i)\b(done|completed|all good|已完成|搞定了)\b", text) and missing:
        warnings.append("completion_claim_without_full_verification_sections")
    if strict and missing:
        warnings.append("strict_mode_missing_required_sections")

    decision = "pass" if not missing else "return"
    return {
        "decision": decision,
        "present_sections": present,
        "missing_sections": missing,
        "warnings": warnings,
    }


def parse_markdown_sections(text: str) -> dict[str, list[str]]:
    sections: dict[str, list[str]] = {}
    current = "_root"
    sections[current] = []
    for line in text.splitlines():
        heading = re.match(r"^\s*##+\s*(.+?)\s*$", line)
        if heading:
            current = heading.group(1).strip()
            sections.setdefault(current, [])
            continue
        sections.setdefault(current, []).append(line)
    return sections


def _clean_lines(lines: list[str]) -> list[str]:
    cleaned = []
    for line in lines:
        stripped = line.strip()
        if not stripped:
            continue
        cleaned.append(re.sub(r"^\s*[-*0-9.]+\s*", "", stripped))
    return cleaned


def compact_task_text(task_text: str) -> dict[str, Any]:
    sections = parse_markdown_sections(task_text)
    goal_lines = _clean_lines(sections.get("Goal", []) + sections.get("当前主任务", []))
    status_lines = _clean_lines(sections.get("Current stage", []) + sections.get("当前状态", []))
    done_lines = _clean_lines(sections.get("Done", []))
    blocker_lines = _clean_lines(sections.get("Blockers", []) + sections.get("当前阻塞", []))
    next_lines = _clean_lines(sections.get("Next step", []) + sections.get("下一步", []))
    in_progress_lines = _clean_lines(sections.get("正在处理", []))
    key_files_section = _clean_lines(sections.get("Key files", []))

    combined_lines = goal_lines + status_lines + done_lines + blocker_lines + next_lines + in_progress_lines + key_files_section
    decisions = [line for line in status_lines + done_lines if any(token in line for token in ("已确定", "已选择", "决定", "采用"))]
    verified_facts = [line for line in status_lines + done_lines if any(token in line for token in ("已", "确认", "支持", "存在"))]
    failed_attempts = [line for line in combined_lines if any(token in line for token in ("失败", "未成功", "报错", "冲突", "回退"))]
    key_files = key_files_section[:]
    for line in combined_lines:
        key_files.extend(re.findall(r"`([^`]+)`", line))
        key_files.extend(re.findall(r"\b(?:[\w.-]+/)+[\w.-]+\b", line))
    deduped_key_files = []
    for item in key_files:
        if item not in deduped_key_files:
            deduped_key_files.append(item)

    return {
        "Goal": goal_lines or ["_missing_"],
        "Decisions": decisions or status_lines[:3] or ["_missing_"],
        "Verified facts": verified_facts or ["_missing_"],
        "Failed attempts": failed_attempts or ["_none_"],
        "Current blocker": blocker_lines or in_progress_lines[:2] or ["_none_"],
        "Next exact step": next_lines or ["_missing_"],
        "Key files": deduped_key_files or ["_none_"],
    }


def render_compaction_markdown(payload: dict[str, Any]) -> str:
    lines = ["# Task Compaction", ""]
    for field in COMPACTION_FIELDS:
        lines.append(f"## {field}")
        lines.append("")
        values = payload[field]
        for value in values:
            lines.append(f"- {value}")
        lines.append("")
    return "\n".join(lines).rstrip() + "\n"


def render_verify_markdown(payload: dict[str, Any]) -> str:
    lines = [
        "# Verification Lint",
        "",
        f"- Decision: `{payload['decision']}`",
        "- Present sections:",
    ]
    if payload["present_sections"]:
        lines.extend([f"  - `{section}`" for section in payload["present_sections"]])
    else:
        lines.append("  - `_none_`")
    lines.append("- Missing sections:")
    if payload["missing_sections"]:
        lines.extend([f"  - `{section}`" for section in payload["missing_sections"]])
    else:
        lines.append("  - `_none_`")
    lines.append("- Warnings:")
    if payload["warnings"]:
        lines.extend([f"  - `{warning}`" for warning in payload["warnings"]])
    else:
        lines.append("  - `_none_`")
    return "\n".join(lines) + "\n"


def render_dispatch_sync_markdown(payload: dict[str, Any]) -> str:
    lines = [
        "# Dispatch Sync Session",
        "",
        f"- Updated: `{str(payload['updated']).lower()}`",
        f"- Reason: `{payload.get('reason') or '_none_'}`",
        f"- Run id: `{payload['run_id']}`",
        f"- Run file: `{payload['run_file']}`",
        f"- Stage id: `{payload['stage_id']}`",
        f"- Actor: `{payload['actor']}`",
        f"- Resolved agent: `{payload['resolved_agent']}`",
        f"- Agent resolution: `{payload['agent_resolution']}`",
        f"- Fallback from agent: `{payload.get('fallback_from_agent') or '_none_'}`",
        f"- Fallback reason: `{payload.get('fallback_reason') or '_none_'}`",
    ]
    if payload.get("extracted_text"):
        lines.extend(
            [
                "- Extracted text:",
                f"  - `{payload['extracted_text']}`",
            ]
        )
    if "current_stage" in payload:
        lines.append(f"- Current stage: `{payload['current_stage']}`")
    if "run_status" in payload:
        lines.append(f"- Run status: `{payload['run_status']}`")
    session_result = payload.get("session_result") or {}
    lines.append("- Session result:")
    for key in ("found", "reason", "session_id", "session_path", "prompt_timestamp", "records_seen"):
        if key not in session_result:
            continue
        lines.append(f"  - {key}: `{session_result[key]}`")
    if session_result.get("approval_requests"):
        lines.append("  - approval_requests:")
        for item in session_result["approval_requests"]:
            lines.append(f"    - `{item}`")
    if session_result.get("error_messages"):
        lines.append("  - error_messages:")
        for item in session_result["error_messages"]:
            lines.append(f"    - `{item}`")
    return "\n".join(lines) + "\n"


def dump(payload: dict[str, Any], format_name: str, renderer) -> None:
    if format_name == "json":
        print(json.dumps(payload, ensure_ascii=False, indent=2))
        return
    print(renderer(payload), end="")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="OpenClaw harness CLI")
    subparsers = parser.add_subparsers(dest="command", required=True)

    session_parser = subparsers.add_parser("session-context", help="Assemble session context in bootstrap order")
    session_parser.add_argument("--workspace", default="/root/.openclaw/workspace")
    session_parser.add_argument("--mode", choices=("main", "shared"), default="main")
    session_parser.add_argument("--recent-days", type=int, default=2)
    session_parser.add_argument("--format", choices=("json", "markdown"), default="markdown")

    route_parser = subparsers.add_parser("route", help="Triage an incoming request")
    route_parser.add_argument("--message", required=True)
    route_parser.add_argument("--format", choices=("json", "markdown"), default="markdown")

    orchestrate_parser = subparsers.add_parser("orchestrate-task", help="Build a Claude-style multi-role execution chain")
    orchestrate_parser.add_argument("--workspace", default="/root/.openclaw/workspace")
    orchestrate_parser.add_argument("--message", required=True)
    orchestrate_parser.add_argument("--format", choices=("json", "markdown"), default="markdown")

    dispatch_parser = subparsers.add_parser("dispatch-bundle", help="Build executable handoffs for each orchestration stage")
    dispatch_parser.add_argument("--workspace", default="/root/.openclaw/workspace")
    dispatch_parser.add_argument("--message", required=True)
    dispatch_parser.add_argument("--apply", action="store_true")
    dispatch_parser.add_argument("--format", choices=("json", "markdown"), default="markdown")

    dispatch_run_parser = subparsers.add_parser("dispatch-run", help="Initialize a staged dispatch run from a message")
    dispatch_run_parser.add_argument("--workspace", default="/root/.openclaw/workspace")
    dispatch_run_parser.add_argument("--message", required=True)
    dispatch_run_parser.add_argument("--apply", action="store_true")
    dispatch_run_parser.add_argument("--format", choices=("json", "markdown"), default="markdown")

    dispatch_update_parser = subparsers.add_parser("dispatch-update", help="Record a stage result and advance the dispatch run")
    dispatch_update_parser.add_argument("--workspace", default="/root/.openclaw/workspace")
    dispatch_update_parser.add_argument("--run-file")
    dispatch_update_parser.add_argument("--stage", required=True)
    dispatch_update_parser.add_argument("--text")
    dispatch_update_parser.add_argument("--file")
    dispatch_update_parser.add_argument("--apply-closeout-memory", action="store_true")
    dispatch_update_parser.add_argument("--closeout-min-items", type=int, default=2)
    dispatch_update_parser.add_argument("--format", choices=("json", "markdown"), default="markdown")

    dispatch_status_parser = subparsers.add_parser("dispatch-status", help="Inspect the latest or specified dispatch run")
    dispatch_status_parser.add_argument("--workspace", default="/root/.openclaw/workspace")
    dispatch_status_parser.add_argument("--run-file")
    dispatch_status_parser.add_argument("--format", choices=("json", "markdown"), default="markdown")

    dispatch_rewind_parser = subparsers.add_parser("dispatch-rewind", help="Rewind a dispatch run back to a specified stage")
    dispatch_rewind_parser.add_argument("--workspace", default="/root/.openclaw/workspace")
    dispatch_rewind_parser.add_argument("--run-file")
    dispatch_rewind_parser.add_argument("--stage", required=True)
    dispatch_rewind_parser.add_argument("--format", choices=("json", "markdown"), default="markdown")

    bridge_parser = subparsers.add_parser("dispatch-bridge-status", help="Inspect Claude-style role mapping to native OpenClaw agents")
    bridge_parser.add_argument("--workspace", default="/root/.openclaw/workspace")
    bridge_parser.add_argument("--format", choices=("json", "markdown"), default="markdown")

    dispatch_launch_parser = subparsers.add_parser("dispatch-launch", help="Build or execute an OpenClaw agent command for the current ready stage")
    dispatch_launch_parser.add_argument("--workspace", default="/root/.openclaw/workspace")
    dispatch_launch_parser.add_argument("--run-file")
    dispatch_launch_parser.add_argument("--stage")
    dispatch_launch_parser.add_argument("--session-id")
    dispatch_launch_parser.add_argument("--channel")
    dispatch_launch_parser.add_argument("--to")
    dispatch_launch_parser.add_argument("--deliver", action="store_true")
    dispatch_launch_parser.add_argument("--local", action="store_true")
    dispatch_launch_parser.add_argument("--reply-channel")
    dispatch_launch_parser.add_argument("--reply-to")
    dispatch_launch_parser.add_argument("--reply-account")
    dispatch_launch_parser.add_argument("--thinking", choices=("off", "minimal", "low", "medium", "high", "xhigh"))
    dispatch_launch_parser.add_argument("--timeout-seconds", type=int)
    dispatch_launch_parser.add_argument("--apply", action="store_true")
    dispatch_launch_parser.add_argument("--execute", action="store_true")
    dispatch_launch_parser.add_argument("--auto-update", action="store_true")
    dispatch_launch_parser.add_argument("--apply-closeout-memory", action="store_true")
    dispatch_launch_parser.add_argument("--closeout-min-items", type=int, default=2)
    dispatch_launch_parser.add_argument("--format", choices=("json", "markdown"), default="markdown")

    dispatch_sync_parser = subparsers.add_parser("dispatch-sync-session", help="Recover a stage result from native session logs and advance the dispatch run")
    dispatch_sync_parser.add_argument("--workspace", default="/root/.openclaw/workspace")
    dispatch_sync_parser.add_argument("--run-file")
    dispatch_sync_parser.add_argument("--stage")
    dispatch_sync_parser.add_argument("--apply-closeout-memory", action="store_true")
    dispatch_sync_parser.add_argument("--closeout-min-items", type=int, default=2)
    dispatch_sync_parser.add_argument("--format", choices=("json", "markdown"), default="markdown")

    permission_parser = subparsers.add_parser("permission", help="Classify action risk")
    permission_parser.add_argument("--text", required=True)
    permission_parser.add_argument("--format", choices=("json", "markdown"), default="markdown")

    verify_parser = subparsers.add_parser("verify-report", help="Lint completion report structure")
    verify_parser.add_argument("--text")
    verify_parser.add_argument("--file")
    verify_parser.add_argument("--strict", action="store_true")
    verify_parser.add_argument("--format", choices=("json", "markdown"), default="markdown")

    compact_parser = subparsers.add_parser("compact-task", help="Compress task state into fixed fields")
    compact_parser.add_argument("--text")
    compact_parser.add_argument("--file", default="/root/.openclaw/workspace/memory/current-task.md")
    compact_parser.add_argument("--format", choices=("json", "markdown"), default="markdown")

    extract_parser = subparsers.add_parser("extract-memory", help="Extract stable memory candidates from text")
    extract_parser.add_argument("--workspace", default="/root/.openclaw/workspace")
    extract_parser.add_argument("--text")
    extract_parser.add_argument("--file")
    extract_parser.add_argument("--apply", action="store_true")
    extract_parser.add_argument("--format", choices=("json", "markdown"), default="markdown")

    auto_memory_parser = subparsers.add_parser("auto-memory-turn", help="Extract and optionally apply memory from a single turn")
    auto_memory_parser.add_argument("--workspace", default="/root/.openclaw/workspace")
    auto_memory_parser.add_argument("--text")
    auto_memory_parser.add_argument("--file")
    auto_memory_parser.add_argument("--min-items", type=int, default=2)
    auto_memory_parser.add_argument("--apply", action="store_true")
    auto_memory_parser.add_argument("--format", choices=("json", "markdown"), default="markdown")

    recall_parser = subparsers.add_parser("recall-memory", help="Search layered memory files")
    recall_parser.add_argument("--workspace", default="/root/.openclaw/workspace")
    recall_parser.add_argument("--query", required=True)
    recall_parser.add_argument("--recent-days", type=int, default=7)
    recall_parser.add_argument("--format", choices=("json", "markdown"), default="markdown")

    dream_parser = subparsers.add_parser("dream-memory", help="Summarize recent memory into long-term candidates")
    dream_parser.add_argument("--workspace", default="/root/.openclaw/workspace")
    dream_parser.add_argument("--days", type=int, default=7)
    dream_parser.add_argument("--focus-query")
    dream_parser.add_argument("--focus-current-task", action="store_true")
    dream_parser.add_argument("--min-hours", type=int, default=0)
    dream_parser.add_argument("--min-sources", type=int, default=1)
    dream_parser.add_argument("--respect-gates", action="store_true")
    dream_parser.add_argument("--apply", action="store_true")
    dream_parser.add_argument("--format", choices=("json", "markdown"), default="markdown")

    promote_parser = subparsers.add_parser("promote-dream", help="Review and promote the latest dream payload")
    promote_parser.add_argument("--workspace", default="/root/.openclaw/workspace")
    promote_parser.add_argument("--report-json")
    promote_parser.add_argument("--max-items", type=int, default=3)
    promote_parser.add_argument("--write-memory-md", action="store_true")
    promote_parser.add_argument("--apply", action="store_true")
    promote_parser.add_argument("--format", choices=("json", "markdown"), default="markdown")

    nightly_parser = subparsers.add_parser("nightly-dream-cycle", help="Run the safe nightly dream and promotion cycle")
    nightly_parser.add_argument("--workspace", default="/root/.openclaw/workspace")
    nightly_parser.add_argument("--days", type=int, default=7)
    nightly_parser.add_argument("--focus-query")
    nightly_parser.add_argument("--focus-current-task", action="store_true")
    nightly_parser.add_argument("--min-hours", type=int, default=24)
    nightly_parser.add_argument("--min-sources", type=int, default=2)
    nightly_parser.add_argument("--max-items", type=int, default=3)
    nightly_parser.add_argument("--write-memory-md", action="store_true")
    nightly_parser.add_argument("--apply", action="store_true")
    nightly_parser.add_argument("--format", choices=("json", "markdown"), default="markdown")

    cron_spec_parser = subparsers.add_parser("dream-cron-spec", help="Render an OpenClaw cron spec for nightly dream maintenance")
    cron_spec_parser.add_argument("--workspace", default="/root/.openclaw/workspace")
    cron_spec_parser.add_argument("--cron", default="30 2 * * *")
    cron_spec_parser.add_argument("--tz", default="Asia/Shanghai")
    cron_spec_parser.add_argument("--days", type=int, default=7)
    cron_spec_parser.add_argument("--focus-query")
    cron_spec_parser.add_argument("--focus-current-task", action="store_true")
    cron_spec_parser.add_argument("--min-hours", type=int, default=24)
    cron_spec_parser.add_argument("--min-sources", type=int, default=2)
    cron_spec_parser.add_argument("--max-items", type=int, default=3)
    cron_spec_parser.add_argument("--thinking", choices=("off", "minimal", "low", "medium", "high", "xhigh"), default="low")
    cron_spec_parser.add_argument("--model")
    cron_spec_parser.add_argument("--write-memory-md", action="store_true")
    cron_spec_parser.add_argument("--disabled", action="store_true")
    cron_spec_parser.add_argument("--format", choices=("json", "markdown"), default="markdown")

    dream_status_parser = subparsers.add_parser("dream-status", help="Inspect nightly dream cron and memory status")
    dream_status_parser.add_argument("--workspace", default="/root/.openclaw/workspace")
    dream_status_parser.add_argument("--jobs-file", default="/root/.openclaw/cron/jobs.json")
    dream_status_parser.add_argument("--runs-dir", default="/root/.openclaw/cron/runs")
    dream_status_parser.add_argument("--job-name", default="Nightly Dream Memory")
    dream_status_parser.add_argument("--max-runs", type=int, default=3)
    dream_status_parser.add_argument("--format", choices=("json", "markdown"), default="markdown")

    dream_verify_parser = subparsers.add_parser("verify-dream", help="Verify nightly dream artifacts and promotion state")
    dream_verify_parser.add_argument("--workspace", default="/root/.openclaw/workspace")
    dream_verify_parser.add_argument("--jobs-file", default="/root/.openclaw/cron/jobs.json")
    dream_verify_parser.add_argument("--runs-dir", default="/root/.openclaw/cron/runs")
    dream_verify_parser.add_argument("--job-name", default="Nightly Dream Memory")
    dream_verify_parser.add_argument("--max-runs", type=int, default=3)
    dream_verify_parser.add_argument("--report-json")
    dream_verify_parser.add_argument("--format", choices=("json", "markdown"), default="markdown")

    closure_parser = subparsers.add_parser("closure-report", help="Build a final closeout report from execution notes")
    closure_parser.add_argument("--goal", required=True)
    closure_parser.add_argument("--text")
    closure_parser.add_argument("--file")
    closure_parser.add_argument("--format", choices=("json", "markdown"), default="markdown")

    closeout_parser = subparsers.add_parser("closeout-turn", help="Run closure-report and auto-memory-turn as one closeout step")
    closeout_parser.add_argument("--workspace", default="/root/.openclaw/workspace")
    closeout_parser.add_argument("--goal", required=True)
    closeout_parser.add_argument("--text")
    closeout_parser.add_argument("--file")
    closeout_parser.add_argument("--min-items", type=int, default=2)
    closeout_parser.add_argument("--apply-memory", action="store_true")
    closeout_parser.add_argument("--apply", action="store_true")
    closeout_parser.add_argument("--stage-id")
    closeout_parser.add_argument("--run-id")
    closeout_parser.add_argument("--source", default="manual")
    closeout_parser.add_argument("--format", choices=("json", "markdown"), default="markdown")

    session_closeout_parser = subparsers.add_parser("closeout-session", help="Build a closeout from the latest real session turn")
    session_closeout_parser.add_argument("--workspace", default="/root/.openclaw/workspace")
    session_closeout_parser.add_argument("--agent-id", default="main")
    session_closeout_parser.add_argument("--session-root", default="/root/.openclaw/agents")
    session_closeout_parser.add_argument("--session-id")
    session_closeout_parser.add_argument("--session-file")
    session_closeout_parser.add_argument("--goal")
    session_closeout_parser.add_argument("--min-items", type=int, default=2)
    session_closeout_parser.add_argument("--apply-memory", action="store_true")
    session_closeout_parser.add_argument("--apply", action="store_true")
    session_closeout_parser.add_argument("--include-internal", action="store_true")
    session_closeout_parser.add_argument("--latest-turn-only", action="store_true")
    session_closeout_parser.add_argument("--run-id")
    session_closeout_parser.add_argument("--source")
    session_closeout_parser.add_argument("--format", choices=("json", "markdown"), default="markdown")

    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()

    if args.command == "session-context":
        payload = build_session_context(Path(args.workspace), args.mode, args.recent_days)
        dump(payload, args.format, render_session_context_markdown)
        return 0

    if args.command == "route":
        payload = classify_route(args.message)
        dump(payload, args.format, render_route_markdown)
        return 0

    if args.command == "orchestrate-task":
        payload = build_task_orchestration(Path(args.workspace), args.message)
        dump(payload, args.format, render_task_orchestration_markdown)
        return 0

    if args.command == "dispatch-bundle":
        payload = build_dispatch_bundle(Path(args.workspace), args.message)
        if args.apply:
            payload["apply_result"] = apply_dispatch_bundle(Path(args.workspace), payload)
        dump(payload, args.format, render_dispatch_bundle_markdown)
        return 0

    if args.command == "dispatch-run":
        bundle = build_dispatch_bundle(Path(args.workspace), args.message)
        payload = initialize_dispatch_run(bundle)
        if args.apply:
            payload["apply_result"] = apply_dispatch_run(Path(args.workspace), payload)
        dump(payload, args.format, render_dispatch_run_markdown)
        return 0

    if args.command == "dispatch-update":
        text = collect_text(args.text, args.file)
        payload = update_dispatch_run(
            Path(args.workspace),
            args.run_file,
            args.stage,
            text,
            apply_closeout_memory=args.apply_closeout_memory,
            closeout_min_items=args.closeout_min_items,
        )
        dump(payload, args.format, render_dispatch_run_markdown)
        return 0

    if args.command == "dispatch-status":
        _, payload = load_dispatch_run(Path(args.workspace), args.run_file)
        dump(payload, args.format, render_dispatch_run_markdown)
        return 0

    if args.command == "dispatch-rewind":
        payload = rewind_dispatch_run(Path(args.workspace), args.run_file, args.stage)
        dump(payload, args.format, render_dispatch_run_markdown)
        return 0

    if args.command == "dispatch-bridge-status":
        payload = inspect_dispatch_bridge(Path(args.workspace))
        dump(payload, args.format, render_dispatch_bridge_markdown)
        return 0

    if args.command == "dispatch-launch":
        if args.auto_update and not args.execute:
            parser.error("--auto-update requires --execute")
        if args.apply_closeout_memory and not args.auto_update:
            parser.error("--apply-closeout-memory requires --auto-update")
        payload = build_dispatch_launch_payload(
            workspace=Path(args.workspace),
            run_file=args.run_file,
            stage_id=args.stage,
            session_id=args.session_id,
            channel=args.channel,
            to=args.to,
            deliver=args.deliver,
            local=args.local,
            reply_channel=args.reply_channel,
            reply_to=args.reply_to,
            reply_account=args.reply_account,
            thinking=args.thinking,
        )
        if args.execute:
            payload["execution"] = execute_dispatch_launch(payload, timeout_seconds=args.timeout_seconds)
            if args.auto_update:
                payload["auto_update_result"] = auto_update_dispatch_run_from_execution(
                    workspace=Path(args.workspace),
                    run_file=args.run_file,
                    stage_id=payload["stage_id"],
                    execution=payload["execution"],
                    launch_payload=payload,
                    apply_closeout_memory=args.apply_closeout_memory,
                    closeout_min_items=args.closeout_min_items,
                )
        if args.apply and not args.auto_update:
            payload["apply_result"] = apply_dispatch_launch(Path(args.workspace), args.run_file, payload)
        dump(payload, args.format, render_dispatch_launch_markdown)
        return 0

    if args.command == "dispatch-sync-session":
        payload = sync_dispatch_run_from_session(
            workspace=Path(args.workspace),
            run_file=args.run_file,
            stage_id=args.stage,
            apply_closeout_memory=args.apply_closeout_memory,
            closeout_min_items=args.closeout_min_items,
        )
        dump(payload, args.format, render_dispatch_sync_markdown)
        return 0

    if args.command == "permission":
        payload = classify_permission(args.text)
        dump(payload, args.format, render_permission_markdown)
        return 0

    if args.command == "verify-report":
        text = collect_text(args.text, args.file)
        payload = lint_report(text, args.strict)
        dump(payload, args.format, render_verify_markdown)
        return 0

    if args.command == "compact-task":
        text = collect_text(args.text, args.file)
        payload = compact_task_text(text)
        dump(payload, args.format, render_compaction_markdown)
        return 0

    if args.command == "extract-memory":
        text = collect_text(args.text, args.file)
        payload = extract_memory_payload(text)
        if args.apply:
            payload["apply_result"] = apply_memory_capture(Path(args.workspace), payload)
        dump(payload, args.format, render_extract_memory_markdown)
        return 0

    if args.command == "auto-memory-turn":
        text = collect_text(args.text, args.file)
        payload = run_auto_memory_turn(Path(args.workspace), text, args.min_items, args.apply)
        dump(payload, args.format, render_auto_memory_turn_markdown)
        return 0

    if args.command == "recall-memory":
        payload = recall_memory(Path(args.workspace), args.query, args.recent_days)
        dump(payload, args.format, render_recall_memory_markdown)
        return 0

    if args.command == "dream-memory":
        workspace = Path(args.workspace)
        gate = evaluate_dream_gate(workspace, args.days, args.min_hours, args.min_sources)
        if args.respect_gates and not gate["open"]:
            payload = {
                "window_days": args.days,
                "generated_at": datetime.now().isoformat(timespec="seconds"),
                "focus_terms": get_dream_focus_terms(workspace, args.focus_query, args.focus_current_task),
                "sources": [],
                "preference_candidates": [],
                "fact_candidates": [],
                "task_candidates": [],
                "suggested_actions": ["skip_dream_run_until_gate_opens"],
                "gate": gate,
            }
            dump(payload, args.format, render_dream_memory_markdown)
            return 0
        focus_terms = get_dream_focus_terms(workspace, args.focus_query, args.focus_current_task)
        payload = build_dream_memory(workspace, args.days, focus_terms)
        payload["gate"] = gate
        if args.apply:
            payload["apply_result"] = apply_dream_memory(workspace, payload)
        dump(payload, args.format, render_dream_memory_markdown)
        return 0

    if args.command == "promote-dream":
        workspace = Path(args.workspace)
        dream_payload = load_latest_dream_payload(workspace, args.report_json)
        payload = build_dream_promotion_plan(dream_payload, args.max_items)
        if args.apply:
            payload["apply_result"] = apply_dream_promotion(workspace, payload, args.write_memory_md)
        dump(payload, args.format, render_dream_promotion_markdown)
        return 0

    if args.command == "nightly-dream-cycle":
        payload = run_nightly_dream_cycle(
            workspace=Path(args.workspace),
            days=args.days,
            focus_query=args.focus_query,
            focus_current_task=args.focus_current_task,
            min_hours=args.min_hours,
            min_sources=args.min_sources,
            max_items=args.max_items,
            apply=args.apply,
            write_memory_md=args.write_memory_md,
        )
        dump(payload, args.format, render_nightly_dream_cycle_markdown)
        return 0

    if args.command == "dream-cron-spec":
        payload = build_nightly_dream_cron_spec(
            workspace=Path(args.workspace),
            cron_expr=args.cron,
            tz=args.tz,
            days=args.days,
            min_hours=args.min_hours,
            min_sources=args.min_sources,
            max_items=args.max_items,
            focus_query=args.focus_query,
            focus_current_task=args.focus_current_task,
            write_memory_md=args.write_memory_md,
            thinking=args.thinking,
            model=args.model,
            disabled=args.disabled,
        )
        dump(payload, args.format, render_nightly_dream_cron_spec_markdown)
        return 0

    if args.command == "dream-status":
        payload = build_dream_status(
            workspace=Path(args.workspace),
            jobs_file=Path(args.jobs_file),
            runs_dir=Path(args.runs_dir),
            job_name=args.job_name,
            max_runs=args.max_runs,
        )
        dump(payload, args.format, render_dream_status_markdown)
        return 0

    if args.command == "verify-dream":
        payload = build_dream_verification(
            workspace=Path(args.workspace),
            jobs_file=Path(args.jobs_file),
            runs_dir=Path(args.runs_dir),
            job_name=args.job_name,
            max_runs=args.max_runs,
            report_json=args.report_json,
        )
        dump(payload, args.format, render_dream_verification_markdown)
        return 0

    if args.command == "closure-report":
        text = collect_text(args.text, args.file)
        payload = build_closure_report(args.goal, text)
        dump(payload, args.format, render_closure_report_markdown)
        return 0

    if args.command == "closeout-turn":
        text = collect_text(args.text, args.file)
        payload = build_closeout_turn(
            workspace=Path(args.workspace),
            goal=args.goal,
            text=text,
            min_items=args.min_items,
            apply_memory=args.apply_memory,
        )
        if args.apply:
            payload["persist_result"] = apply_closeout_turn(
                workspace=Path(args.workspace),
                payload=payload,
                stage_id=args.stage_id,
                run_id=args.run_id,
                source=args.source,
            )
        dump(payload, args.format, render_closeout_turn_markdown)
        return 0

    if args.command == "closeout-session":
        payload = build_session_closeout(
            workspace=Path(args.workspace),
            agent_id=args.agent_id,
            min_items=args.min_items,
            apply_memory=args.apply_memory,
            goal=args.goal,
            session_root=Path(args.session_root),
            session_id=args.session_id,
            session_file=args.session_file,
            include_internal=args.include_internal,
            latest_turn_only=args.latest_turn_only,
        )
        if args.apply and payload.get("found"):
            payload["persist_result"] = apply_session_closeout(
                Path(args.workspace),
                payload,
                run_id=args.run_id,
                source=args.source,
            )
        dump(payload, args.format, render_session_closeout_markdown)
        return 0

    parser.error(f"Unknown command: {args.command}")
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
