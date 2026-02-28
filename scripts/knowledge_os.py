#!/usr/bin/env python3
"""
knowledge_os.py

Zettelkasten + PARA + Ontology + Redefinition 운영 루프를 위한 CLI 도구.
철학 파일(PHILOSOPHY_STRUCTURE.md)은 바꾸지 않고, 구조만 진화시킨다.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import plistlib
import re
import shutil
import signal
import sqlite3
import subprocess
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


WORKSPACE = Path("/Users/ron/.openclaw/workspace")
KNOWLEDGE_ROOT = WORKSPACE / "knowledge"
SYSTEM_ROOT = KNOWLEDGE_ROOT / "900 시스템"
PHILOSOPHY_PATH = WORKSPACE / "PHILOSOPHY_STRUCTURE.md"

MANIFEST_PATH = SYSTEM_ROOT / "structure_manifest.json"
RELATION_TYPES_PATH = SYSTEM_ROOT / "relation_types.json"
REGISTRY_PATH = SYSTEM_ROOT / "note_registry.json"

PROPOSAL_DRAFT_DIR = SYSTEM_ROOT / "905 제안" / "905.c 초안"
PROPOSAL_APPROVED_DIR = SYSTEM_ROOT / "905 제안" / "905.b 승인"
PROPOSAL_APPLIED_DIR = SYSTEM_ROOT / "905 제안" / "905.a 적용"
SNAPSHOT_DIR = SYSTEM_ROOT / "906 스냅샷"
CHANGELOG_DIR = SYSTEM_ROOT / "901 변경로그"
CHANGELOG_JSONL = CHANGELOG_DIR / "knowledge_os.jsonl"

ONTOLOGY_QUEUE_DIR = SYSTEM_ROOT / "910 온톨로지" / "911 큐"
LINK_QUEUE_PATH = ONTOLOGY_QUEUE_DIR / "links.jsonl"
QUEUE_CURSOR_PATH = ONTOLOGY_QUEUE_DIR / "cursor.json"
ONTOLOGY_TTL_PATH = SYSTEM_ROOT / "910 온톨로지" / "knowledge.ttl"

PARA_BUCKETS = ("inbox", "projects", "areas", "resources", "archive")
AI_PROMPTS_MD_PATH = SYSTEM_ROOT / "950 프롬프트" / "ai_prompts.md"
PROMPT_COMPOSITION_PATH = SYSTEM_ROOT / "prompt_composition.json"
PROMPT_PACK_DIR = SYSTEM_ROOT / "903 프롬프트팩"
PROPOSAL_TEMPLATE_DIR = SYSTEM_ROOT / "904 제안템플릿"

# ── 분류 체계 상수 ──
ZK_TYPES = ("fleeting", "literature", "permanent", "hub", "synthesis")
MATURITY_LEVELS = ("seedling", "growing", "evergreen")
DOMAINS = ("investment", "engineering", "philosophy", "operations", "intelligence", "meta", "general")
SOURCE_TYPES = ("capture", "analysis", "synthesis", "reference", "experience")

# ── 파일명 출처 약어 매핑 ──
_SOURCE_ABBREV_MAP = {
    "telegram-export": "tg",
    "knowledge_connector": "kc",
    "experiment_tracker": "exp",
    "manual": "man",
    "n8n-pipeline": "n8n",
    "proactive_research": "res",
}

def source_abbrev(source: str) -> str:
    """Map source string to 2-3 char abbreviation for filename."""
    if source in _SOURCE_ABBREV_MAP:
        return _SOURCE_ABBREV_MAP[source]
    if "agent_memory" in source or "ops_agent_memory" in source:
        return "mem"
    if "prompt_pack" in source or "프롬프트팩" in source or "latest.json" in source:
        return "ref"
    if "telegram_backup" in source or "first_principles" in source:
        return "tg"
    if "agent_prompts" in source or "prompt_composition" in source:
        return "ref"
    if "reports/" in source or "cowork" in source:
        return "sys"
    return "etc"

LAUNCHAGENT_LABEL = "com.openclaw.knowledge-os-cycle"
LAUNCHAGENT_PATH = Path("/Users/ron/Library/LaunchAgents") / f"{LAUNCHAGENT_LABEL}.plist"
KNOWLEDGE_OS_LOG = Path("/Users/ron/.openclaw/logs/knowledge_os_cycle.log")
KNOWLEDGE_OS_ERR = Path("/Users/ron/.openclaw/logs/knowledge_os_cycle.err.log")
STATUS_SNAPSHOT_PATH = SYSTEM_ROOT / "status_snapshot.json"
BUS_DIR = WORKSPACE / "bus"
BUS_STATUS_DIR = BUS_DIR / "status"
BUS_MESSAGES_PATH = BUS_DIR / "messages.jsonl"
OBSIDIAN_SYSTEM_DIR = SYSTEM_ROOT
OBSIDIAN_SYSTEM_MAP = OBSIDIAN_SYSTEM_DIR / "SYSTEM_OVERVIEW.md"
OPS_DB_PATH = Path("/Users/ron/.openclaw/data/ops_multiagent.db")

MCP_SERVER_COMMANDS: dict[str, list[str]] = {
    "codex-self": [str(WORKSPACE / "scripts" / "codex_mcp_server.sh")],
    "workspace-fs": [str(WORKSPACE / "scripts" / "mcp_filesystem.sh")],
    "knowledge-memory": [str(WORKSPACE / "scripts" / "mcp_memory.sh")],
    "agent-bus": [str(WORKSPACE / "scripts" / "mcp_agent_bus.sh")],
}

MCP_PROBE: dict[str, tuple[str, dict[str, Any]]] = {
    "codex-self": ("resources/list", {}),
    "workspace-fs": ("tools/list", {}),
    "knowledge-memory": ("tools/list", {}),
    "agent-bus": ("tools/list", {}),
}


def now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def slugify(text: str) -> str:
    s = (text or "").strip().lower()
    s = re.sub(r"[^\w가-힣]+", "-", s)
    s = re.sub(r"-+", "-", s).strip("-")
    return s or "note"


def ensure_dir(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)


def write_json(path: Path, data: Any) -> None:
    ensure_dir(path.parent)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def read_json(path: Path, default: Any) -> Any:
    if not path.exists():
        return default
    return json.loads(path.read_text(encoding="utf-8"))


def append_jsonl(path: Path, data: dict[str, Any]) -> None:
    ensure_dir(path.parent)
    with path.open("a", encoding="utf-8") as f:
        f.write(json.dumps(data, ensure_ascii=False) + "\n")


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    out: list[dict[str, Any]] = []
    with path.open("r", encoding="utf-8", errors="replace") as f:
        for line_no, line in enumerate(f, start=1):
            line = line.strip()
            if not line:
                continue
            try:
                parsed = json.loads(line)
            except json.JSONDecodeError:
                # Keep run-cycle resilient to occasional truncated/corrupted log lines.
                continue
            if isinstance(parsed, dict):
                out.append(parsed)
    return out


def file_sha256(path: Path) -> str:
    if not path.exists():
        return ""
    return hashlib.sha256(path.read_bytes()).hexdigest()


def resolve_workspace_path(raw: str) -> Path:
    p = Path(raw)
    return p if p.is_absolute() else (WORKSPACE / p)


def init_registry_if_missing() -> None:
    if REGISTRY_PATH.exists():
        return
    write_json(
        REGISTRY_PATH,
        {
            "version": "1.0.0",
            "created_at": now_iso(),
            "updated_at": now_iso(),
            "notes": [],
        },
    )


def load_registry() -> dict[str, Any]:
    init_registry_if_missing()
    reg = read_json(REGISTRY_PATH, {})
    reg.setdefault("notes", [])
    return reg


def save_registry(registry: dict[str, Any]) -> None:
    registry["updated_at"] = now_iso()
    write_json(REGISTRY_PATH, registry)


def find_note(registry: dict[str, Any], note_id: str) -> dict[str, Any] | None:
    for note in registry.get("notes", []):
        if note.get("id") == note_id:
            return note
    return None


def load_relation_type_ids() -> set[str]:
    data = read_json(RELATION_TYPES_PATH, {"relation_types": []})
    ids: set[str] = set()
    for item in data.get("relation_types", []):
        rel = item.get("id")
        if rel:
            ids.add(rel)
    return ids


def load_prompt_composition() -> dict[str, Any]:
    data = read_json(PROMPT_COMPOSITION_PATH, {})
    data.setdefault("wrappers", {})
    data["wrappers"].setdefault("system_prefix", [])
    data["wrappers"].setdefault("first_principles_checklist", [])
    return data


def extract_prompt_placeholders(source_prompt: str, placeholders_decl: str = "") -> list[str]:
    tokens: list[str] = []
    for m in re.finditer(r"\[[^\[\]\n]+?\]|\{[^{}\n]+?\}", source_prompt or ""):
        token = m.group(0)
        # Markdown label-like pattern such as "[문제]: ..." is not a variable placeholder.
        if token.startswith("["):
            tail = (source_prompt or "")[m.end() :]
            if re.match(r"^\s*:", tail):
                continue
        tokens.append(token)
    seen: set[str] = set()
    placeholders: list[str] = []
    for token in tokens:
        if token not in seen:
            seen.add(token)
            placeholders.append(token)
    if not placeholders and placeholders_decl:
        raw = [x.strip() for x in placeholders_decl.split(",") if x.strip()]
        for token in raw:
            if token not in seen:
                seen.add(token)
                placeholders.append(token)
    return placeholders


def parse_ai_prompts_markdown(text: str) -> list[dict[str, Any]]:
    entries: list[dict[str, Any]] = []

    def _append_entry(title: str, source_prompt: str, purpose: str, placeholders_decl: str = "") -> None:
        idx = len(entries) + 1
        entries.append(
            {
                "index": idx,
                "id": f"prompt-{idx:02d}",
                "title": title.strip(),
                "purpose": (purpose or "").strip(),
                "placeholders": extract_prompt_placeholders(source_prompt, placeholders_decl),
                "source_prompt": (source_prompt or "").strip(),
            }
        )

    existing_titles: set[str] = set()

    pattern = re.compile(r"^##\s+(\d+)\.\s+(.+?)\n(.*?)(?=^##\s+\d+\.\s+|\Z)", re.M | re.S)
    for m in pattern.finditer(text):
        title = m.group(2).strip()
        existing_titles.add(title)
        body = m.group(3)

        prompt_match = re.search(r"Prompt \(원문\):\s*\n```(?:[a-zA-Z0-9_-]+)?\n(.*?)\n```", body, re.S)
        if not prompt_match:
            prompt_match = re.search(r'Prompt \(원문\):\s*\n"(.*?)"\s*(?:\n|$)', body, re.S)
        if not prompt_match:
            prompt_match = re.search(r'Prompt \(원문\):\s*"(.*?)"\s*(?:\n|$)', body, re.S)
        source_prompt = prompt_match.group(1).strip() if prompt_match else ""

        purpose_match = re.search(r"Purpose:\s*(.+)", body)
        purpose = purpose_match.group(1).strip() if purpose_match else ""

        placeholders_decl = ""
        placeholders_match = re.search(r"Placeholders:\s*(.+)", body)
        if placeholders_match:
            placeholders_decl = placeholders_match.group(1).strip()

        _append_entry(title=title, source_prompt=source_prompt, purpose=purpose, placeholders_decl=placeholders_decl)

    # New format fallback:
    # ## 프롬프트 템플릿
    # ### <제목>
    # ```
    # ...
    # ```
    section = re.search(r"^##\s+프롬프트\s*템플릿\s*$\n(.*?)(?=^##\s+|\Z)", text, re.M | re.S)
    if section:
        body = section.group(1)
        h3_blocks = re.compile(r"^###\s+(.+?)\n(.*?)(?=^###\s+|\Z)", re.M | re.S)
        for m in h3_blocks.finditer(body):
            title = m.group(1).strip()
            if title in existing_titles:
                continue
            block = m.group(2)
            code_match = re.search(r"```(?:[a-zA-Z0-9_-]+)?\n(.*?)\n```", block, re.S)
            source_prompt = code_match.group(1).strip() if code_match else ""
            if not source_prompt:
                continue
            _append_entry(title=title, source_prompt=source_prompt, purpose=f"{title} 실행 템플릿")
            existing_titles.add(title)

    return entries


def deep_replace_vars(value: Any, vars_map: dict[str, str]) -> Any:
    if isinstance(value, str):
        out = value
        for k, v in vars_map.items():
            out = out.replace(f"{{{{{k}}}}}", str(v))
        return out
    if isinstance(value, list):
        return [deep_replace_vars(v, vars_map) for v in value]
    if isinstance(value, dict):
        return {k: deep_replace_vars(v, vars_map) for k, v in value.items()}
    return value


def load_template(template_name: str) -> tuple[Path, dict[str, Any]]:
    direct = PROPOSAL_TEMPLATE_DIR / f"{template_name}.json"
    if direct.exists():
        return direct, read_json(direct, {})
    candidates = sorted(PROPOSAL_TEMPLATE_DIR.glob(f"*{template_name}*.json"))
    if not candidates:
        raise SystemExit(f"template not found: {template_name}")
    if len(candidates) > 1:
        raise SystemExit(f"multiple templates matched: {[c.name for c in candidates]}")
    path = candidates[0]
    return path, read_json(path, {})


def compose_prompt(entry: dict[str, Any], cfg: dict[str, Any]) -> str:
    wrappers = cfg.get("wrappers", {})
    prefix_lines = wrappers.get("system_prefix", [])
    checklist = wrappers.get("first_principles_checklist", [])

    preface = "\n".join([f"- {line}" for line in prefix_lines]) if prefix_lines else ""
    checklist_text = "\n".join([f"{i + 1}. {line}" for i, line in enumerate(checklist)]) if checklist else ""
    placeholders = ", ".join(entry.get("placeholders", []))

    blocks = [
        "[SYSTEM CONTEXT]",
        preface,
        "",
        "[FIRST PRINCIPLES CHECKLIST]",
        checklist_text,
        "",
        "[TASK TEMPLATE]",
        entry.get("source_prompt", ""),
    ]
    if placeholders:
        blocks.extend(["", "[PLACEHOLDERS]", placeholders])
    blocks.extend(
        [
            "",
            "[OUTPUT CONTRACT]",
            "답변은 사실(what) -> 관계(why linked) -> 판단(so what) -> 행동(now what) 순서로 작성.",
            "가정은 '가정'으로 명시하고, 검증 가능한 사실과 분리.",
        ]
    )
    return "\n".join(blocks).strip() + "\n"


def bootstrap(args: argparse.Namespace) -> None:
    ensure_dir(KNOWLEDGE_ROOT / "100 지식" / "110 수신함")
    ensure_dir(KNOWLEDGE_ROOT / "100 지식" / "120 노트")
    ensure_dir(KNOWLEDGE_ROOT / "100 지식" / "130 구조노트")
    ensure_dir(KNOWLEDGE_ROOT / "200 활동" / "210 프로젝트")
    ensure_dir(KNOWLEDGE_ROOT / "200 활동" / "220 영역")
    ensure_dir(KNOWLEDGE_ROOT / "800 운영")
    ensure_dir(SYSTEM_ROOT / "910 온톨로지")
    ensure_dir(ONTOLOGY_QUEUE_DIR)
    ensure_dir(SYSTEM_ROOT)
    ensure_dir(PROPOSAL_DRAFT_DIR)
    ensure_dir(PROPOSAL_APPROVED_DIR)
    ensure_dir(PROPOSAL_APPLIED_DIR)
    ensure_dir(SNAPSHOT_DIR)
    ensure_dir(CHANGELOG_DIR)
    ensure_dir(PROMPT_PACK_DIR)
    ensure_dir(PROPOSAL_TEMPLATE_DIR)

    if not MANIFEST_PATH.exists():
        write_json(
            MANIFEST_PATH,
            {
                "manifest_version": "1.0.0",
                "root_philosophy_file": str(PHILOSOPHY_PATH),
                "knowledge_root": str(KNOWLEDGE_ROOT),
                "rules": {
                    "require_atomic_notes": True,
                    "require_explicit_links": True,
                    "allow_structure_redefinition": True,
                    "protect_root_philosophy": True,
                },
            },
        )
    if not RELATION_TYPES_PATH.exists():
        write_json(
            RELATION_TYPES_PATH,
            {
                "version": "1.0.0",
                "relation_types": [
                    {"id": "supports", "description": "A가 B를 지지"},
                    {"id": "contradicts", "description": "A가 B와 상충"},
                    {"id": "refines", "description": "A가 B를 정교화"},
                    {"id": "depends_on", "description": "A가 B에 의존"},
                    {"id": "derived_from", "description": "A가 B에서 도출"},
                    {"id": "example_of", "description": "A가 B의 사례"},
                    {"id": "causes", "description": "A가 B의 원인"},
                    {"id": "related_to", "description": "임시 연관"},
                ],
            },
        )
    if not PROMPT_COMPOSITION_PATH.exists():
        write_json(
            PROMPT_COMPOSITION_PATH,
            {
                "version": "1.0.0",
                "source_markdown": str(AI_PROMPTS_MD_PATH),
                "output_dir": str(PROMPT_PACK_DIR),
                "composition_mode": "root_first_principles_operating",
                "wrappers": {
                    "system_prefix": [
                        "ROOT 선언: Zettelkasten으로 사고를 만들고, PARA로 규모를 감당하며, Ontology로 의미를 연결해 철학적 판단까지 도달한다.",
                        "행동 원칙: 제1원칙 사고를 따른다. 목적/제약/검증가능 사실/비용리스크로 분해한다.",
                        "출력 형식: 사실(what) -> 관계(why linked) -> 판단(so what) -> 행동(now what).",
                    ],
                    "first_principles_checklist": [
                        "목적이 명확한가?",
                        "비가역 제약은 무엇인가?",
                        "검증 가능한 사실과 가정은 분리되었는가?",
                        "최소비용/최대학습 실험은 무엇인가?",
                    ],
                },
            },
        )
    init_registry_if_missing()
    if not QUEUE_CURSOR_PATH.exists():
        write_json(QUEUE_CURSOR_PATH, {"processed_lines": 0, "updated_at": now_iso()})

    if getattr(args, "command", None) == "bootstrap":
        print(
            json.dumps(
                {
                    "status": "ok",
                    "action": "bootstrap",
                    "knowledge_root": str(KNOWLEDGE_ROOT),
                    "manifest": str(MANIFEST_PATH),
                    "philosophy_hash": file_sha256(PHILOSOPHY_PATH),
                },
                ensure_ascii=False,
                indent=2,
            )
        )


def make_note_text(
    note_id: str,
    title: str,
    ts: str,
    para_bucket: str,
    topic: str,
    tags: list[str],
    source: str,
    body: str,
    status: str = "active",
    zk_type: str = "permanent",
    maturity: str = "seedling",
    domain: str = "general",
    source_type: str = "capture",
    purpose: str = "",
    extra_frontmatter: dict[str, str] | None = None,
) -> str:
    tag_str = ", ".join(tags)
    extra = ""
    if extra_frontmatter:
        for k, v in extra_frontmatter.items():
            extra += f"{k}: {v}\n"
    return (
        f"---\n"
        f"id: {note_id}\n"
        f"title: \"{title}\"\n"
        f"aliases: [\"{note_id}\"]\n"
        f"created_at: {ts}\n"
        f"updated_at: {ts}\n"
        f"zk_type: {zk_type}\n"
        f"maturity: {maturity}\n"
        f"para_bucket: {para_bucket}\n"
        f"domain: {domain}\n"
        f"source_type: {source_type}\n"
        f"purpose: \"{purpose}\"\n"
        f"tags: [{tag_str}]\n"
        f"source: {source}\n"
        f"topic: {topic}\n"
        f"status: {status}\n"
        f"{extra}"
        f"---\n\n"
        f"{body.strip()}\n\n"
        f"## Linked Notes\n"
    )


def create_atomic_note(
    title: str,
    body: str,
    para_bucket: str,
    topic: str,
    tags: list[str],
    source: str,
    external_key: str = "",
    status: str = "active",
    zk_type: str = "permanent",
    domain: str = "general",
    source_type: str = "capture",
    purpose: str = "",
) -> dict[str, Any]:
    if para_bucket not in PARA_BUCKETS:
        raise SystemExit(f"para_bucket must be one of: {', '.join(PARA_BUCKETS)}")

    registry = load_registry()
    if external_key:
        for note in registry.get("notes", []):
            if note.get("external_key") == external_key:
                return {
                    "status": "exists",
                    "action": "capture",
                    "note_id": note.get("id"),
                    "note_path": note.get("path"),
                    "external_key": external_key,
                }

    ts = now_iso()
    date_part = datetime.now().strftime("%Y%m%d-%H%M%S")
    note_id = f"zk-{date_part}-{uuid.uuid4().hex[:6]}"
    slug = slugify(title)
    src_code = source_abbrev(source)

    # ZK 원칙: 원자 노트는 평면 저장 (하위 폴더 없음)
    # inbox → 110 수신함, 나머지 → 120 노트
    if para_bucket == "inbox":
        note_dir = KNOWLEDGE_ROOT / "100 지식" / "110 수신함"
    else:
        note_dir = KNOWLEDGE_ROOT / "100 지식" / "120 노트"
    ensure_dir(note_dir)
    # 파일명 형식: YYYYMMDD-HHMMSS_SRC__slug.md (ID는 frontmatter에서 관리)
    note_path = note_dir / f"{date_part}_{src_code}__{slug}.md"

    maturity = "seedling"
    note_text = make_note_text(
        note_id,
        title,
        ts,
        para_bucket,
        topic,
        tags,
        source,
        body,
        status=status,
        zk_type=zk_type,
        maturity=maturity,
        domain=domain,
        source_type=source_type,
        purpose=purpose,
        extra_frontmatter={"external_key": external_key} if external_key else None,
    )
    note_path.write_text(note_text, encoding="utf-8")

    entry = {
        "id": note_id,
        "title": title,
        "path": str(note_path),
        "created_at": ts,
        "updated_at": ts,
        "zk_type": zk_type,
        "maturity": maturity,
        "para_bucket": para_bucket,
        "domain": domain,
        "source_type": source_type,
        "purpose": purpose,
        "topic": topic,
        "tags": tags,
        "source": source,
        "status": status,
        "external_key": external_key,
        "last_reviewed": None,
        "times_reinforced": 0,
        "links": [],
    }
    registry.setdefault("notes", []).append(entry)
    save_registry(registry)

    # PARA 카탈로그는 200 활동/ 하위에 기록
    para_catalog = KNOWLEDGE_ROOT / "200 활동" / "catalog.jsonl"
    append_jsonl(
        para_catalog,
        {
            "note_id": note_id,
            "title": title,
            "note_path": str(note_path),
            "created_at": ts,
            "topic": topic,
            "external_key": external_key,
        },
    )

    return {"status": "ok", "action": "capture", "note_id": note_id, "note_path": str(note_path)}


def progress_maturity() -> dict[str, int]:
    """Automated maturity progression for Zettelkasten notes.

    Maturity levels: seedling -> growing -> evergreen

    Rules (upgrade only, never downgrade):
      - seedling -> growing:   note has >= 3 links
      - growing -> evergreen:  note has >= 5 links AND times_reinforced >= 1

    Returns dict with counts: {promoted_to_growing: N, promoted_to_evergreen: N}
    """
    maturity_order = {"seedling": 0, "growing": 1, "evergreen": 2}

    registry = load_registry()
    notes = registry.get("notes", [])

    promoted_to_growing = 0
    promoted_to_evergreen = 0

    for note in notes:
        current = note.get("maturity", "seedling")
        link_count = len(note.get("links", []))
        times_reinforced = note.get("times_reinforced", 0)
        current_rank = maturity_order.get(current, 0)

        # Determine target maturity
        target = current
        if link_count >= 5 and times_reinforced >= 1:
            if maturity_order["evergreen"] > current_rank:
                target = "evergreen"
        elif link_count >= 3:
            if maturity_order["growing"] > current_rank:
                target = "growing"

        if target == current:
            continue

        note["maturity"] = target

        if target == "growing":
            promoted_to_growing += 1
        elif target == "evergreen":
            promoted_to_evergreen += 1

        # Update frontmatter in the .md file
        md_path = note.get("path", "")
        if md_path:
            _update_frontmatter_maturity(md_path, target)

    save_registry(registry)

    return {
        "promoted_to_growing": promoted_to_growing,
        "promoted_to_evergreen": promoted_to_evergreen,
    }


def _update_frontmatter_maturity(md_path: str, new_maturity: str) -> bool:
    """Update the maturity field in a .md file's YAML frontmatter."""
    p = Path(md_path)
    if not p.exists():
        return False

    text = p.read_text(encoding="utf-8")

    # Match YAML frontmatter between --- markers
    fm_match = re.match(r"^(---\n)(.*?)(---\n)", text, re.DOTALL)
    if not fm_match:
        return False

    frontmatter = fm_match.group(2)

    new_fm, count = re.subn(
        r"^(maturity:\s*).*$",
        rf"\g<1>{new_maturity}",
        frontmatter,
        count=1,
        flags=re.MULTILINE,
    )

    if count == 0:
        new_fm = frontmatter + f"maturity: {new_maturity}\n"

    new_text = fm_match.group(1) + new_fm + fm_match.group(3) + text[fm_match.end():]
    p.write_text(new_text, encoding="utf-8")
    return True


def create_link(
    from_id: str,
    to_id: str,
    relation: str,
    reason: str = "",
    dedupe: bool = True,
) -> dict[str, Any]:
    registry = load_registry()
    from_note = find_note(registry, from_id)
    to_note = find_note(registry, to_id)
    if not from_note:
        raise SystemExit(f"from_id not found: {from_id}")
    if not to_note:
        raise SystemExit(f"to_id not found: {to_id}")

    allowed = load_relation_type_ids()
    if relation not in allowed:
        raise SystemExit(f"Unknown relation '{relation}'. allowed={sorted(allowed)}")

    if dedupe:
        for event in from_note.get("links", []):
            if event.get("to_id") == to_id and event.get("relation") == relation:
                return {"status": "exists", "action": "link", "event": event}

    event = {
        "created_at": now_iso(),
        "from_id": from_id,
        "to_id": to_id,
        "relation": relation,
        "reason": reason or "",
    }
    append_jsonl(LINK_QUEUE_PATH, event)
    from_note.setdefault("links", []).append(event)
    from_note["updated_at"] = now_iso()
    save_registry(registry)

    # Obsidian-compatible wikilink + 기존 텍스트 형식 병행
    to_title = to_note.get("title", to_id)
    link_line = f"- [{relation}] [[{to_id}|{to_title}]]" + (f" — {reason}" if reason else "")
    append_note_link_line(Path(from_note["path"]), link_line)
    return {"status": "ok", "action": "link", "event": event}


def capture(args: argparse.Namespace) -> None:
    bootstrap(args)
    title = args.title.strip()
    if not title:
        raise SystemExit("--title is required")
    para_bucket = args.para.strip().lower()
    if para_bucket not in PARA_BUCKETS:
        raise SystemExit(f"--para must be one of: {', '.join(PARA_BUCKETS)}")

    body = args.body or ""
    if args.body_file:
        body = Path(args.body_file).read_text(encoding="utf-8")

    tags = [t.strip() for t in (args.tags or "").split(",") if t.strip()]
    topic = args.topic.strip() if args.topic else "general"
    source = args.source.strip() if args.source else "manual"
    domain = getattr(args, "domain", "general") or "general"
    source_type = getattr(args, "source_type", "capture") or "capture"
    purpose = getattr(args, "purpose", "") or ""
    payload = create_atomic_note(
        title=title,
        body=body,
        para_bucket=para_bucket,
        topic=topic,
        tags=tags,
        source=source,
        domain=domain,
        source_type=source_type,
        purpose=purpose,
    )
    print(json.dumps(payload, ensure_ascii=False, indent=2))


def append_note_link_line(note_path: Path, line: str) -> None:
    text = note_path.read_text(encoding="utf-8")
    if line in text:
        return
    if "## Linked Notes" not in text:
        text = text.rstrip() + "\n\n## Linked Notes\n"
    text = text.rstrip() + "\n" + line + "\n"
    note_path.write_text(text, encoding="utf-8")


def link(args: argparse.Namespace) -> None:
    bootstrap(args)
    payload = create_link(
        from_id=args.from_id,
        to_id=args.to_id,
        relation=args.relation.strip(),
        reason=args.reason or "",
        dedupe=True,
    )
    print(json.dumps(payload, ensure_ascii=False, indent=2))


def sync_ontology(args: argparse.Namespace) -> None:
    try:
        from rdflib import Graph, Literal, Namespace
        from rdflib.namespace import DCTERMS, RDF, RDFS, XSD
    except ImportError as exc:
        raise SystemExit(f"rdflib is required: {exc}")

    bootstrap(args)
    registry = load_registry()

    RON = Namespace("http://ron.openclaw.local/ontology#")
    graph = Graph()
    graph.bind("ron", RON)
    graph.bind("rdfs", RDFS)
    graph.bind("dcterms", DCTERMS)
    graph.bind("xsd", XSD)

    if ONTOLOGY_TTL_PATH.exists():
        graph.parse(str(ONTOLOGY_TTL_PATH), format="turtle")

    note_count = 0
    for note in registry.get("notes", []):
        note_id = note.get("id")
        if not note_id:
            continue
        uri = RON[f"doc/{note_id}"]
        rdf_type = RON.ZKNote if note_id.startswith("zk-") else RON.Document
        graph.add((uri, RDF.type, rdf_type))
        graph.set((uri, RDFS.label, Literal(note.get("title", note_id))))
        graph.set((uri, DCTERMS.created, Literal(note.get("created_at", ""), datatype=XSD.dateTime)))
        graph.set((uri, RON.sourcePath, Literal(note.get("path", ""))))
        graph.set((uri, RON.topicName, Literal(note.get("topic", ""))))
        graph.set((uri, RON.paraBucket, Literal(note.get("para_bucket", ""))))
        note_count += 1

    events = read_jsonl(LINK_QUEUE_PATH)
    cursor = read_json(QUEUE_CURSOR_PATH, {"processed_lines": 0})
    processed_lines = int(cursor.get("processed_lines", 0))
    new_event_count = 0

    for idx, event in enumerate(events):
        if idx < processed_lines:
            continue
        from_id = event.get("from_id")
        to_id = event.get("to_id")
        if not from_id or not to_id:
            continue
        from_uri = RON[f"doc/{from_id}"]
        to_uri = RON[f"doc/{to_id}"]
        relation_str = event.get("relation", "related_to")
        relation_prop = RON[relation_str] if relation_str != "related_to" else RON.relatedTo
        graph.add((from_uri, relation_prop, to_uri))
        graph.add((from_uri, RON.zkRelation, Literal(relation_str)))
        reason = event.get("reason")
        if reason:
            graph.add((from_uri, RON.zkReason, Literal(reason)))
        new_event_count += 1

    ensure_dir(ONTOLOGY_TTL_PATH.parent)
    graph.serialize(str(ONTOLOGY_TTL_PATH), format="turtle")

    write_json(
        QUEUE_CURSOR_PATH,
        {"processed_lines": len(events), "updated_at": now_iso(), "last_synced_graph": str(ONTOLOGY_TTL_PATH)},
    )

    print(
        json.dumps(
            {
                "status": "ok",
                "action": "sync-ontology",
                "notes_upserted": note_count,
                "new_link_events_applied": new_event_count,
                "ttl_path": str(ONTOLOGY_TTL_PATH),
                "ttl_size_bytes": ONTOLOGY_TTL_PATH.stat().st_size if ONTOLOGY_TTL_PATH.exists() else 0,
            },
            ensure_ascii=False,
            indent=2,
        )
    )


def build_prompt_pack(args: argparse.Namespace) -> None:
    bootstrap(args)
    cfg = load_prompt_composition()
    source_path = Path(cfg.get("source_markdown", str(AI_PROMPTS_MD_PATH)))
    if not source_path.is_absolute():
        source_path = WORKSPACE / source_path
    if not source_path.exists():
        raise SystemExit(f"prompt source missing: {source_path}")

    source_text = source_path.read_text(encoding="utf-8")
    parsed = parse_ai_prompts_markdown(source_text)
    if not parsed:
        raise SystemExit("no prompts parsed from source markdown")

    pack_prompts: list[dict[str, Any]] = []
    for entry in parsed:
        pack_prompts.append(
            {
                **entry,
                "composed_prompt": compose_prompt(entry, cfg),
            }
        )

    out_dir = Path(cfg.get("output_dir", str(PROMPT_PACK_DIR)))
    if not out_dir.is_absolute():
        out_dir = WORKSPACE / out_dir
    ensure_dir(out_dir)

    ts = datetime.now().strftime("%Y%m%d-%H%M%S")
    out_path = out_dir / f"prompt-pack-{ts}.json"
    pack = {
        "pack_version": "1.0.0",
        "generated_at": now_iso(),
        "source_markdown": str(source_path),
        "philosophy_hash": file_sha256(PHILOSOPHY_PATH),
        "composition_mode": cfg.get("composition_mode", "root_first_principles_operating"),
        "count": len(pack_prompts),
        "prompts": pack_prompts,
    }
    write_json(out_path, pack)
    write_json(out_dir / "latest.json", pack)

    append_jsonl(
        CHANGELOG_JSONL,
        {
            "created_at": now_iso(),
            "action": "build-prompt-pack",
            "count": len(pack_prompts),
            "source_markdown": str(source_path),
            "output": str(out_path),
        },
    )

    payload = {
        "status": "ok",
        "action": "build-prompt-pack",
        "source_markdown": str(source_path),
        "output": str(out_path),
        "latest": str(out_dir / "latest.json"),
        "count": len(pack_prompts),
        "titles": [p["title"] for p in pack_prompts],
    }
    print(json.dumps(payload, ensure_ascii=False, indent=2))


def list_prompt_pack(args: argparse.Namespace) -> None:
    bootstrap(args)
    latest_path = PROMPT_PACK_DIR / "latest.json"
    if not latest_path.exists():
        raise SystemExit(f"prompt pack not found: {latest_path}. run build-prompt-pack first")
    pack = read_json(latest_path, {})
    prompts = pack.get("prompts", [])
    payload = {
        "status": "ok",
        "action": "list-prompt-pack",
        "generated_at": pack.get("generated_at"),
        "count": len(prompts),
        "items": [{"id": p.get("id"), "title": p.get("title"), "purpose": p.get("purpose")} for p in prompts],
    }
    print(json.dumps(payload, ensure_ascii=False, indent=2))


def select_domain_notes(registry: dict[str, Any], domain: str) -> list[dict[str, Any]]:
    d = domain.strip().lower()
    selected = []
    for note in registry.get("notes", []):
        topic = str(note.get("topic", "")).strip().lower()
        tags = [str(t).strip().lower() for t in note.get("tags", [])]
        if topic == d or d in tags:
            selected.append(note)
    return selected


def import_prompt_notes(args: argparse.Namespace) -> None:
    bootstrap(args)
    domain = args.domain.strip().lower()
    if args.rebuild_pack:
        me = Path(__file__).resolve()
        run_json_command([sys.executable, str(me), "build-prompt-pack"])

    latest_path = PROMPT_PACK_DIR / "latest.json"
    if not latest_path.exists():
        raise SystemExit(f"prompt pack not found: {latest_path}. run build-prompt-pack first")
    pack = read_json(latest_path, {})
    prompts = pack.get("prompts", [])
    if not isinstance(prompts, list):
        raise SystemExit("invalid prompt pack format: prompts is not list")

    created: list[dict[str, Any]] = []
    skipped: list[dict[str, Any]] = []
    created_ids: list[str] = []

    for p in prompts:
        pid = p.get("id", "")
        title = p.get("title", "Untitled Prompt")
        purpose = p.get("purpose", "")
        placeholders = p.get("placeholders", [])
        source_prompt = p.get("source_prompt", "")
        body = (
            f"## Purpose\n{purpose}\n\n"
            f"## Placeholders\n{', '.join(placeholders) if placeholders else '(none)'}\n\n"
            f"## Source Prompt\n```\n{source_prompt}\n```\n"
        )
        payload = create_atomic_note(
            title=f"Prompt Asset: {title}",
            body=body,
            para_bucket="resources",
            topic=domain,
            tags=["prompt", "asset", domain, pid],
            source=str(latest_path),
            external_key=f"prompt_pack:{pid}",
        )
        if payload.get("status") == "ok":
            created.append(payload)
            created_ids.append(str(payload.get("note_id")))
        else:
            skipped.append(payload)

    policy_note_id = args.policy_note_id or ""
    if not policy_note_id:
        registry = load_registry()
        for note in registry.get("notes", []):
            title = str(note.get("title", ""))
            if "프롬프트 조합 정책" in title:
                policy_note_id = str(note.get("id"))
                break

    linked = 0
    if policy_note_id:
        for note_id in created_ids:
            res = create_link(
                from_id=note_id,
                to_id=policy_note_id,
                relation="depends_on",
                reason="프롬프트 자산은 조합 정책을 따른다.",
                dedupe=True,
            )
            if res.get("status") == "ok":
                linked += 1

    payload = {
        "status": "ok",
        "action": "import-prompt-notes",
        "domain": domain,
        "source_pack": str(latest_path),
        "created_count": len(created),
        "skipped_count": len(skipped),
        "linked_to_policy_count": linked,
        "policy_note_id": policy_note_id or None,
        "created_note_ids": [x.get("note_id") for x in created],
    }
    print(json.dumps(payload, ensure_ascii=False, indent=2))


def build_map(args: argparse.Namespace) -> None:
    bootstrap(args)
    domain = args.domain.strip().lower()
    registry = load_registry()
    notes = select_domain_notes(registry, domain)
    note_ids = {str(n.get("id")) for n in notes}
    notes_sorted = sorted(notes, key=lambda n: str(n.get("created_at", "")))

    edges = []
    for note in notes_sorted:
        for ev in note.get("links", []):
            to_id = str(ev.get("to_id", ""))
            if not to_id:
                continue
            if to_id in note_ids:
                edges.append(
                    {
                        "from_id": str(note.get("id")),
                        "to_id": to_id,
                        "relation": str(ev.get("relation", "related_to")),
                    }
                )

    map_dir = KNOWLEDGE_ROOT / "100 지식" / "130 구조노트" / domain
    ensure_dir(map_dir)
    map_path = map_dir / "MAP.md"

    lines = []
    lines.append(f"# Domain Map: {domain}")
    lines.append("")
    lines.append(f"- Generated: {now_iso()}")
    lines.append(f"- Notes: {len(notes_sorted)}")
    lines.append(f"- Internal links: {len(edges)}")
    lines.append(f"- Philosophy hash: `{file_sha256(PHILOSOPHY_PATH)}`")
    lines.append("")
    lines.append("## Notes")
    for note in notes_sorted:
        nid = str(note.get("id"))
        title = str(note.get("title", ""))
        para = str(note.get("para_bucket", ""))
        path = str(note.get("path", ""))
        lines.append(f"- `{nid}` | {title} | para={para}")
        lines.append(f"  - path: `{path}`")

    lines.append("")
    lines.append("## Links")
    for edge in edges:
        lines.append(f"- `{edge['from_id']}` --{edge['relation']}--> `{edge['to_id']}`")

    lines.append("")
    lines.append("## Graph")
    lines.append("```mermaid")
    lines.append("graph TD")
    for note in notes_sorted:
        nid = str(note.get("id"))
        title = str(note.get("title", "")).replace('"', "'")
        lines.append(f'  {nid.replace("-", "_")}["{nid}\\n{title}"]')
    for edge in edges:
        a = edge["from_id"].replace("-", "_")
        b = edge["to_id"].replace("-", "_")
        rel = edge["relation"].replace('"', "'")
        lines.append(f"  {a} -->|{rel}| {b}")
    lines.append("```")
    lines.append("")

    map_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    payload = {
        "status": "ok",
        "action": "build-map",
        "domain": domain,
        "map_path": str(map_path),
        "note_count": len(notes_sorted),
        "link_count": len(edges),
    }
    print(json.dumps(payload, ensure_ascii=False, indent=2))


def run_json_command(command: list[str]) -> dict[str, Any]:
    """Run a subprocess command expected to return JSON.

    Returns a dict with keys:
    - status: "ok" or "error"
    - returncode: int
    - stdout: full stdout (trimmed)
    - stderr: full stderr (trimmed)
    - json: parsed JSON if available
    """
    proc = subprocess.run(command, capture_output=True, text=True, check=False)
    out = (proc.stdout or "").strip()
    err = (proc.stderr or "").strip()
    if proc.returncode != 0:
        return {
            "status": "error",
            "returncode": proc.returncode,
            "stdout": out,
            "stderr": err,
            "command": command,
        }
    if not out:
        return {"status": "ok", "returncode": 0, "stdout": "", "stderr": "", "json": None}
    try:
        parsed = json.loads(out)
    except Exception:
        # Return raw output when JSON parsing fails
        return {"status": "ok", "returncode": 0, "stdout": out, "stderr": err, "json": None}
    return {"status": "ok", "returncode": 0, "stdout": out, "stderr": err, "json": parsed}


def mcp_frame(payload: dict[str, Any]) -> bytes:
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    header = f"Content-Length: {len(body)}\r\n\r\n".encode("ascii")
    return header + body


def read_mcp_message(proc: subprocess.Popen[bytes], timeout_sec: float = 8.0) -> dict[str, Any]:
    import select

    buf = b""
    fd = proc.stdout.fileno()
    deadline = datetime.now().timestamp() + timeout_sec

    def read_some(target_len: int | None = None) -> bytes:
        nonlocal buf
        while True:
            now = datetime.now().timestamp()
            if now >= deadline:
                raise TimeoutError("mcp response timeout")
            wait = max(0.05, min(0.3, deadline - now))
            ready, _, _ = select.select([fd], [], [], wait)
            if not ready:
                continue
            chunk = os.read(fd, 4096)
            if not chunk:
                raise RuntimeError("mcp stdout closed")
            buf += chunk
            if target_len is None:
                if b"\r\n\r\n" in buf:
                    return b""
            else:
                if len(buf) >= target_len:
                    return b""

    read_some(None)
    header_raw, rest = buf.split(b"\r\n\r\n", 1)
    buf = rest

    content_length = None
    for line in header_raw.decode("utf-8", errors="replace").split("\r\n"):
        if line.lower().startswith("content-length:"):
            content_length = int(line.split(":", 1)[1].strip())
            break
    if content_length is None:
        raise RuntimeError("mcp response missing content-length")

    if len(buf) < content_length:
        read_some(content_length)
    body = buf[:content_length]
    buf = buf[content_length:]
    return json.loads(body.decode("utf-8", errors="replace"))


def check_mcp_server(server_name: str, command: list[str], method: str, params: dict[str, Any]) -> dict[str, Any]:
    started_at = datetime.now().timestamp()
    proc = subprocess.Popen(
        command,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        cwd=str(WORKSPACE),
    )
    try:
        init_req = {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {"name": "knowledge-os", "version": "1.0.0"},
            },
        }
        proc.stdin.write(mcp_frame(init_req))
        proc.stdin.flush()
        init_res = read_mcp_message(proc, timeout_sec=8.0)
        if "error" in init_res:
            return {
                "server": server_name,
                "status": "error",
                "phase": "initialize",
                "error": init_res["error"],
                "latency_ms": int((datetime.now().timestamp() - started_at) * 1000),
            }

        # notification/initialized
        proc.stdin.write(
            mcp_frame({"jsonrpc": "2.0", "method": "notifications/initialized", "params": {}})
        )
        proc.stdin.flush()

        probe_req = {"jsonrpc": "2.0", "id": 2, "method": method, "params": params}
        proc.stdin.write(mcp_frame(probe_req))
        proc.stdin.flush()
        probe_res = read_mcp_message(proc, timeout_sec=8.0)

        latency = int((datetime.now().timestamp() - started_at) * 1000)
        if "error" in probe_res:
            # Some MCP servers do not implement resources/list; that still means transport is healthy.
            code = probe_res["error"].get("code")
            status = "alive-method-unsupported" if code == -32601 else "error"
            return {
                "server": server_name,
                "status": status,
                "phase": "probe",
                "probe_method": method,
                "error": probe_res["error"],
                "latency_ms": latency,
            }

        return {
            "server": server_name,
            "status": "ok",
            "phase": "probe",
            "probe_method": method,
            "latency_ms": latency,
            "result_keys": sorted(list((probe_res.get("result") or {}).keys())),
        }
    except Exception as exc:  # noqa: BLE001
        return {
            "server": server_name,
            "status": "error",
            "phase": "runtime",
            "probe_method": method,
            "error": {"message": str(exc)},
            "latency_ms": int((datetime.now().timestamp() - started_at) * 1000),
        }
    finally:
        try:
            if proc.poll() is None:
                proc.send_signal(signal.SIGTERM)
                proc.wait(timeout=1.0)
        except Exception:  # noqa: BLE001
            try:
                proc.kill()
            except Exception:  # noqa: BLE001
                pass


def mcp_check(args: argparse.Namespace) -> None:
    """MCP 서버 stdio 헬스체크.

    - 기본 출력: JSON (stdout)
    - 실패 조건: servers_healthy != servers_total
    - --fix: 실패 시 1회 재시도(지연 2s)
    - --save-log <path>: 결과 JSON을 파일로 저장
    """

    bootstrap(args)

    def _run_once() -> list[dict[str, Any]]:
        checks_local: list[dict[str, Any]] = []
        for name, cmd in MCP_SERVER_COMMANDS.items():
            method, params = MCP_PROBE.get(name, ("tools/list", {}))
            checks_local.append(check_mcp_server(name, cmd, method, params))
        return checks_local

    checks = _run_once()

    ok_statuses = {"ok", "alive-method-unsupported"}
    ok_count = sum(1 for c in checks if c.get("status") in ok_statuses)

    fix_attempted = False
    if getattr(args, "fix", False) and ok_count != len(checks):
        fix_attempted = True
        time.sleep(2.0)
        checks = _run_once()
        ok_count = sum(1 for c in checks if c.get("status") in ok_statuses)

    overall_status = "ok" if ok_count == len(checks) else "error"

    payload = {
        "status": overall_status,
        "action": "mcp-check",
        "checked_at": now_iso(),
        "servers_total": len(checks),
        "servers_healthy": ok_count,
        "fix_attempted": fix_attempted,
        "servers": checks,
    }

    out = json.dumps(payload, ensure_ascii=False, indent=2)
    print(out)

    save_path = getattr(args, "save_log", "") or ""
    if save_path:
        p = Path(save_path)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(out + "\n", encoding="utf-8")

    if overall_status != "ok":
        raise SystemExit(1)


def build_status_payload() -> dict[str, Any]:
    registry = load_registry()
    notes = registry.get("notes", [])
    cursor = read_json(QUEUE_CURSOR_PATH, {"processed_lines": 0})
    queue_lines = len(read_jsonl(LINK_QUEUE_PATH))
    processed = int(cursor.get("processed_lines", 0))
    pending = max(queue_lines - processed, 0)
    prompt_parsed_count = 0
    prompt_parse_error = ""
    if AI_PROMPTS_MD_PATH.exists():
        try:
            source_text = AI_PROMPTS_MD_PATH.read_text(encoding="utf-8")
            prompt_parsed_count = len(parse_ai_prompts_markdown(source_text))
        except Exception as exc:  # noqa: BLE001
            prompt_parse_error = str(exc)

    return {
        "status": "ok",
        "manifest_version": read_json(MANIFEST_PATH, {}).get("manifest_version"),
        "philosophy_file": str(PHILOSOPHY_PATH),
        "philosophy_hash": file_sha256(PHILOSOPHY_PATH),
        "notes_total": len(notes),
        "notes_by_para": {
            bucket: sum(1 for n in notes if n.get("para_bucket") == bucket) for bucket in PARA_BUCKETS
        },
        "links_queue_total": queue_lines,
        "links_queue_pending": pending,
        "proposals": {
            "draft": len(list(PROPOSAL_DRAFT_DIR.glob("*.json"))),
            "approved": len(list(PROPOSAL_APPROVED_DIR.glob("*.json"))),
            "applied": len(list(PROPOSAL_APPLIED_DIR.glob("*.json"))),
        },
        "ontology_ttl_exists": ONTOLOGY_TTL_PATH.exists(),
        "ontology_ttl_size_bytes": ONTOLOGY_TTL_PATH.stat().st_size if ONTOLOGY_TTL_PATH.exists() else 0,
        "prompt_engine": {
            "source_markdown_exists": AI_PROMPTS_MD_PATH.exists(),
            "composition_config_exists": PROMPT_COMPOSITION_PATH.exists(),
            "packs_count": len(list(PROMPT_PACK_DIR.glob("prompt-pack-*.json"))),
            "latest_pack_exists": (PROMPT_PACK_DIR / "latest.json").exists(),
            "source_parsed_count": prompt_parsed_count,
            "source_parse_ok": prompt_parsed_count > 0 and not prompt_parse_error,
            "source_parse_error": prompt_parse_error or None,
        },
        "maps": {
            "domains": sorted([p.name for p in (KNOWLEDGE_ROOT / "100 지식" / "130 구조노트").glob("*") if p.is_dir()]),
            "map_files": len(list((KNOWLEDGE_ROOT / "100 지식" / "130 구조노트").rglob("MAP.md"))),
        },
        "automation": {
            "launchagent_plist_exists": LAUNCHAGENT_PATH.exists(),
            "launchagent_label": LAUNCHAGENT_LABEL,
        },
    }


def refresh_status_snapshot(args: argparse.Namespace) -> None:
    bootstrap(args)
    payload = build_status_payload()
    payload["snapshot_generated_at"] = now_iso()
    write_json(STATUS_SNAPSHOT_PATH, payload)
    print(
        json.dumps(
            {
                "status": "ok",
                "action": "refresh-status-snapshot",
                "snapshot_path": str(STATUS_SNAPSHOT_PATH),
                "snapshot_generated_at": payload["snapshot_generated_at"],
            },
            ensure_ascii=False,
            indent=2,
        )
    )


def load_bus_overview() -> dict[str, Any]:
    agent_status = []
    if BUS_STATUS_DIR.exists():
        for p in sorted(BUS_STATUS_DIR.glob("*.json")):
            try:
                agent_status.append(json.loads(p.read_text(encoding="utf-8")))
            except Exception:
                continue
    last_msg = None
    msgs = read_jsonl(BUS_MESSAGES_PATH)
    if msgs:
        last_msg = msgs[-1]

    cmd_counts = {"queued": 0, "claimed": 0, "done": 0, "failed": 0, "cancelled": 0}
    if OPS_DB_PATH.exists():
        try:
            con = sqlite3.connect(str(OPS_DB_PATH))
            con.row_factory = sqlite3.Row
            rows = con.execute("SELECT status, COUNT(*) AS c FROM bus_commands GROUP BY status").fetchall()
            con.close()
            for r in rows:
                st = str(r["status"])
                cmd_counts[st] = int(r["c"])
        except Exception:
            pass

    return {
        "agent_status": agent_status,
        "message_total": len(msgs),
        "last_message": last_msg,
        "command_counts": cmd_counts,
    }


def export_obsidian(args: argparse.Namespace) -> None:
    bootstrap(args)
    status_payload = build_status_payload()
    mcp_payload = run_json_command([sys.executable, str(Path(__file__).resolve()), "mcp-check"])
    bus = load_bus_overview()

    ensure_dir(OBSIDIAN_SYSTEM_DIR)
    mcp_data = mcp_payload.get("json") if isinstance(mcp_payload.get("json"), dict) else mcp_payload
    mcp_total = int(mcp_data.get("servers_total", 0))
    mcp_ok = int(mcp_data.get("servers_healthy", 0))
    cmd_counts = bus.get("command_counts", {})

    lines: list[str] = []
    lines.append("# Ron System Overview")
    lines.append("")
    lines.append(f"- Updated: {now_iso()}")
    lines.append(f"- ROOT file: `{PHILOSOPHY_PATH}`")
    lines.append(f"- Notes total: {status_payload.get('notes_total', 0)}")
    lines.append(f"- MCP health: {mcp_ok}/{mcp_total}")
    lines.append(
        f"- Command queue: queued={cmd_counts.get('queued', 0)} claimed={cmd_counts.get('claimed', 0)} done={cmd_counts.get('done', 0)} failed={cmd_counts.get('failed', 0)}"
    )
    lines.append("")
    lines.append("## Architecture")
    lines.append("```mermaid")
    lines.append("flowchart LR")
    lines.append('  ROOT["ROOT Philosophy (Locked)"] --> KOS["Knowledge OS"]')
    lines.append('  KOS --> MCP["MCP Mesh"]')
    lines.append('  KOS --> ZK["Zettelkasten"]')
    lines.append('  KOS --> PARA["PARA"]')
    lines.append('  KOS --> ONTO["Ontology"]')
    lines.append('  KOS --> DASH["Dashboard 3344"]')
    lines.append('  DASH --> BUS["3-Agent Bus"]')
    lines.append('  BUS --> QUEUE["Command Queue"]')
    lines.append("```")
    lines.append("")
    lines.append("## Agent Roles")
    lines.append("| Agent | Role | Current Task |")
    lines.append("|---|---|---|")
    for row in bus.get("agent_status", []):
        agent = str(row.get("agent", ""))
        role = {
            "ron": "운영/지식 실행",
            "codex": "코드/MCP 구현",
            "cowork": "아키텍처/조율",
        }.get(agent, "-")
        task = str(row.get("current_task", "") or "-").replace("|", "/")
        lines.append(f"| {agent} | {role} | {task} |")
    lines.append("")
    lines.append("## Runtime Signals")
    lines.append(f"- Ontology TTL size: {status_payload.get('ontology_ttl_size_bytes', 0)} bytes")
    lines.append(f"- Prompt packs: {(status_payload.get('prompt_engine') or {}).get('packs_count', 0)}")
    lines.append(f"- Strategy maps: {(status_payload.get('maps') or {}).get('map_files', 0)}")
    lines.append(f"- Bus messages: {bus.get('message_total', 0)}")
    last_msg = bus.get("last_message") or {}
    if last_msg:
        lines.append(
            f"- Last bus message: {last_msg.get('ts', '')} {last_msg.get('from', '')}->{last_msg.get('to', '')} {last_msg.get('body', '')}"
        )

    OBSIDIAN_SYSTEM_MAP.write_text("\n".join(lines) + "\n", encoding="utf-8")
    payload = {
        "status": "ok",
        "action": "export-obsidian",
        "output": str(OBSIDIAN_SYSTEM_MAP),
        "mcp_health": f"{mcp_ok}/{mcp_total}",
        "command_counts": cmd_counts,
    }
    print(json.dumps(payload, ensure_ascii=False, indent=2))


def _extract_zk_gap_tags_from_bus(limit_lines: int = 3000) -> list[str]:
    if not BUS_MESSAGES_PATH.exists():
        return []

    # tail을 직접 구현(메모리/비용 절약)
    lines = BUS_MESSAGES_PATH.read_text(encoding="utf-8", errors="replace").splitlines()[-limit_lines:]
    text = "\n".join(lines)

    tags: set[str] = set()

    # 패턴1: "ZK coverage gaps (tags: failure, etf, error, ...)"
    for m in re.findall(r"ZK coverage gaps?\s*\(tags:\s*([^\)\]]+)", text, flags=re.I):
        raw = m.strip()
        for tok in re.split(r"[\s,]+", raw):
            tok = tok.strip().strip("'").strip('"')
            if tok:
                tags.add(tok)

    # 패턴2: "tags:failure,etf,error" 같은 형태
    for m in re.findall(r"tags:\s*([a-zA-Z0-9_\-]+(?:\s*,\s*[a-zA-Z0-9_\-]+)+)", text, flags=re.I):
        for tok in re.split(r"\s*,\s*", m.strip()):
            tok = tok.strip().strip("'").strip('"')
            if tok:
                tags.add(tok)

    return sorted(tags)


def _auto_create_zk_skeletons(tags: list[str], commit: bool = True) -> dict[str, Any]:
    if not tags:
        return {"status": "skipped", "reason": "no_tags"}

    script = WORKSPACE / "scripts" / "create_zk_skeletons.py"
    if not script.exists():
        return {"status": "error", "reason": "create_zk_skeletons.py not found", "path": str(script)}

    cmd = [sys.executable, str(script), "--tags", *tags]
    if commit:
        cmd.append("--commit")

    proc = subprocess.run(cmd, capture_output=True, text=True, check=False)
    return {
        "status": "ok" if proc.returncode == 0 else "error",
        "returncode": proc.returncode,
        "tags": tags,
        "stdout_tail": (proc.stdout or "").splitlines()[-40:],
        "stderr_tail": (proc.stderr or "").splitlines()[-40:],
        "command": cmd,
    }


def run_cycle(args: argparse.Namespace) -> None:
    bootstrap(args)
    domain = args.domain.strip().lower()
    me = Path(__file__).resolve()

    # Defensive checks: ensure the script file exists and is readable when
    # this function is invoked by launchd/launchctl or other wrappers.
    if not me.exists():
        print(json.dumps({"status": "error", "action": "run-cycle", "reason": "script_not_found", "path": str(me)}, ensure_ascii=False))
        return
    if not os.access(me, os.R_OK):
        print(json.dumps({"status": "error", "action": "run-cycle", "reason": "script_not_readable", "path": str(me)}, ensure_ascii=False))
        return

    base = [sys.executable, str(me)]

    zk_autofill_result: dict[str, Any] | None = None
    if getattr(args, "auto_zk_skeletons", False):
        gap_tags = _extract_zk_gap_tags_from_bus(limit_lines=3000)
        zk_autofill_result = _auto_create_zk_skeletons(gap_tags, commit=True)

    results: dict[str, Any] = {}
    commands = {
        "mcp_check": base + ["mcp-check"],
        "build_prompt_pack": base + ["build-prompt-pack"],
        "import_prompt_notes": base + ["import-prompt-notes", "--domain", domain],
        "build_map": base + ["build-map", "--domain", domain],
        "sync_ontology": base + ["sync-ontology"],
        "refresh_status_snapshot": base + ["refresh-status-snapshot"],
        "export_obsidian": base + ["export-obsidian"],
        "status": base + ["status"],
    }

    # NOTE (patch): We assume run_json_command is deterministic and returns a serializable dict.
    # - Rationale: called from launchd/agent; must not raise uncaught exceptions because a single
    #   failure should not abort the entire run-cycle. Tests mock run_json_command to simulate
    #   both success and failure paths (see tests/test_run_cycle.py).
    # - Core assumption: the command list is small and each item is independent; failures are
    #   recorded per-key in results and do not stop further commands.
    for key, cmd in commands.items():
        try:
            results[key] = run_json_command(cmd)
        except Exception as e:
            # Record structured error payload so external callers can parse which step failed.
            # Keep exception string short to avoid leaking stack traces in normal ops.
            results[key] = {"status": "error", "exception": str(e), "command": cmd}

    if zk_autofill_result is not None:
        results["auto_zk_skeletons"] = zk_autofill_result

    def _step_ok(item: Any) -> bool:
        if not isinstance(item, dict):
            return False
        if str(item.get("status", "")) != "ok":
            return False
        rc = item.get("returncode")
        if rc is not None:
            try:
                return int(rc) == 0
            except Exception:
                return False
        return True

    critical_steps = (
        "mcp_check",
        "build_prompt_pack",
        "import_prompt_notes",
        "build_map",
        "sync_ontology",
        "refresh_status_snapshot",
        "export_obsidian",
        "status",
    )
    failed_steps = [name for name in critical_steps if not _step_ok(results.get(name))]
    overall_status = "ok" if not failed_steps else "error"

    payload = {
        "status": overall_status,
        "action": "run-cycle",
        "domain": domain,
        "executed_at": now_iso(),
        "results": results,
        "failed_steps": failed_steps,
    }
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    if overall_status != "ok":
        raise SystemExit(1)


def install_launchagent(args: argparse.Namespace) -> None:
    bootstrap(args)
    interval_sec = int(args.interval_minutes) * 60
    ensure_dir(LAUNCHAGENT_PATH.parent)
    ensure_dir(KNOWLEDGE_OS_LOG.parent)
    cmd = [
        "/usr/bin/python3",
        str(Path(__file__).resolve()),
        "run-cycle",
        "--domain",
        args.domain.strip().lower(),
    ]
    plist_payload = {
        "Label": LAUNCHAGENT_LABEL,
        "ProgramArguments": cmd,
        "RunAtLoad": True,
        "StartInterval": interval_sec,
        "StandardOutPath": str(KNOWLEDGE_OS_LOG),
        "StandardErrorPath": str(KNOWLEDGE_OS_ERR),
        "EnvironmentVariables": {"PATH": "/usr/bin:/bin:/usr/sbin:/sbin"},
    }
    with LAUNCHAGENT_PATH.open("wb") as f:
        plistlib.dump(plist_payload, f)

    uid = os.getuid()
    bootout = subprocess.run(
        ["launchctl", "bootout", f"gui/{uid}", str(LAUNCHAGENT_PATH)],
        capture_output=True,
        text=True,
        check=False,
    )
    bootstrap_cmd = subprocess.run(
        ["launchctl", "bootstrap", f"gui/{uid}", str(LAUNCHAGENT_PATH)],
        capture_output=True,
        text=True,
        check=False,
    )
    enable_cmd = subprocess.run(
        ["launchctl", "enable", f"gui/{uid}/{LAUNCHAGENT_LABEL}"],
        capture_output=True,
        text=True,
        check=False,
    )
    payload = {
        "status": "ok" if bootstrap_cmd.returncode == 0 else "warning",
        "action": "install-launchagent",
        "label": LAUNCHAGENT_LABEL,
        "plist_path": str(LAUNCHAGENT_PATH),
        "interval_minutes": int(args.interval_minutes),
        "domain": args.domain.strip().lower(),
        "bootstrap_returncode": bootstrap_cmd.returncode,
        "bootstrap_stderr": (bootstrap_cmd.stderr or "").strip(),
        "enable_returncode": enable_cmd.returncode,
        "enable_stderr": (enable_cmd.stderr or "").strip(),
        "bootout_returncode": bootout.returncode,
    }
    print(json.dumps(payload, ensure_ascii=False, indent=2))


def launchagent_status(args: argparse.Namespace) -> None:
    uid = os.getuid()
    loaded = subprocess.run(
        ["launchctl", "print", f"gui/{uid}/{LAUNCHAGENT_LABEL}"],
        capture_output=True,
        text=True,
        check=False,
    )
    payload = {
        "status": "ok",
        "action": "launchagent-status",
        "label": LAUNCHAGENT_LABEL,
        "plist_exists": LAUNCHAGENT_PATH.exists(),
        "loaded": loaded.returncode == 0,
        "log_path": str(KNOWLEDGE_OS_LOG),
        "err_path": str(KNOWLEDGE_OS_ERR),
    }
    if loaded.returncode != 0:
        payload["launchctl_message"] = (loaded.stderr or loaded.stdout or "").strip()
    print(json.dumps(payload, ensure_ascii=False, indent=2))


def list_templates(args: argparse.Namespace) -> None:
    bootstrap(args)
    items = []
    for path in sorted(PROPOSAL_TEMPLATE_DIR.glob("*.json")):
        obj = read_json(path, {})
        items.append(
            {
                "template": path.stem,
                "level": obj.get("level"),
                "description": obj.get("description"),
                "required_vars": obj.get("required_vars", []),
                "operation_count": len(obj.get("operations", [])) if isinstance(obj.get("operations"), list) else 0,
            }
        )
    print(
        json.dumps(
            {"status": "ok", "action": "list-templates", "count": len(items), "items": items},
            ensure_ascii=False,
            indent=2,
        )
    )


def propose_from_template(args: argparse.Namespace) -> None:
    bootstrap(args)
    path, tmpl = load_template(args.template)
    required = tmpl.get("required_vars", [])
    vars_map = json.loads(args.vars) if args.vars else {}
    if not isinstance(vars_map, dict):
        raise SystemExit("--vars must be a JSON object")

    missing = [k for k in required if k not in vars_map]
    if missing:
        raise SystemExit(f"missing template vars: {missing}")

    operations = tmpl.get("operations", [])
    if not isinstance(operations, list):
        raise SystemExit("template.operations must be a list")
    rendered_ops = deep_replace_vars(operations, vars_map)

    reason = args.reason
    if not reason:
        reason = f"template={tmpl.get('template_id', path.stem)} | {tmpl.get('description', '')}"

    notes = args.notes or tmpl.get("default_notes", "")
    title = args.title or f"Template Proposal: {path.stem}"

    ts = datetime.now().strftime("%Y%m%d-%H%M%S")
    proposal_id = f"proposal-{ts}-{slugify(title)}"
    proposal = {
        "proposal_id": proposal_id,
        "title": title,
        "reason": reason,
        "created_at": now_iso(),
        "status": "draft",
        "philosophy_hash": file_sha256(PHILOSOPHY_PATH),
        "template": path.stem,
        "template_file": str(path),
        "template_vars": vars_map,
        "operations": rendered_ops,
        "notes": notes,
    }
    out_path = PROPOSAL_DRAFT_DIR / f"{proposal_id}.json"
    write_json(out_path, proposal)

    print(
        json.dumps(
            {
                "status": "ok",
                "action": "propose-from-template",
                "proposal_id": proposal_id,
                "template": path.stem,
                "path": str(out_path),
                "operation_count": len(rendered_ops),
            },
            ensure_ascii=False,
            indent=2,
        )
    )


def find_proposal_file(directory: Path, query: str) -> Path:
    q = query.strip()
    direct = Path(q)
    if direct.exists():
        return direct
    candidates = sorted(directory.glob(f"*{q}*.json"))
    if not candidates:
        raise SystemExit(f"proposal not found in {directory}: {query}")
    if len(candidates) > 1:
        raise SystemExit(f"multiple proposals matched: {[c.name for c in candidates]}")
    return candidates[0]


def propose(args: argparse.Namespace) -> None:
    bootstrap(args)
    title = args.title.strip()
    reason = args.reason.strip()
    operations: list[dict[str, Any]] = []
    if args.operations:
        loaded = json.loads(args.operations)
        if not isinstance(loaded, list):
            raise SystemExit("--operations must be a JSON list")
        operations = loaded

    ts = datetime.now().strftime("%Y%m%d-%H%M%S")
    proposal_id = f"proposal-{ts}-{slugify(title)}"
    proposal = {
        "proposal_id": proposal_id,
        "title": title,
        "reason": reason,
        "created_at": now_iso(),
        "status": "draft",
        "philosophy_hash": file_sha256(PHILOSOPHY_PATH),
        "operations": operations,
        "notes": args.notes or "",
    }
    out_path = PROPOSAL_DRAFT_DIR / f"{proposal_id}.json"
    write_json(out_path, proposal)
    print(
        json.dumps(
            {"status": "ok", "action": "propose", "proposal_id": proposal_id, "path": str(out_path)},
            ensure_ascii=False,
            indent=2,
        )
    )


def approve(args: argparse.Namespace) -> None:
    bootstrap(args)
    src = find_proposal_file(PROPOSAL_DRAFT_DIR, args.proposal)
    proposal = read_json(src, {})
    proposal["status"] = "approved"
    proposal["approved_at"] = now_iso()
    dst = PROPOSAL_APPROVED_DIR / src.name
    write_json(dst, proposal)
    src.unlink(missing_ok=True)
    print(
        json.dumps(
            {"status": "ok", "action": "approve", "proposal_id": proposal.get("proposal_id"), "path": str(dst)},
            ensure_ascii=False,
            indent=2,
        )
    )


def snapshot_tree(label: str, proposal_id: str) -> Path:
    ts = datetime.now().strftime("%Y%m%d-%H%M%S")
    out_path = SNAPSHOT_DIR / f"{ts}__{proposal_id}__{label}.json"
    max_depth = 4
    rows: list[dict[str, Any]] = []

    for path in sorted(KNOWLEDGE_ROOT.rglob("*")):
        rel = path.relative_to(KNOWLEDGE_ROOT)
        depth = len(rel.parts)
        if depth > max_depth:
            continue
        rows.append(
            {
                "path": str(rel),
                "type": "dir" if path.is_dir() else "file",
                "size": path.stat().st_size if path.is_file() else None,
            }
        )

    payload = {
        "created_at": now_iso(),
        "label": label,
        "proposal_id": proposal_id,
        "philosophy_hash": file_sha256(PHILOSOPHY_PATH),
        "entries": rows,
    }
    write_json(out_path, payload)
    return out_path


def apply_operations(operations: list[dict[str, Any]], dry_run: bool) -> list[dict[str, Any]]:
    results: list[dict[str, Any]] = []
    for op in operations:
        op_type = op.get("op")
        if op_type not in {"mkdir", "move", "copy", "touch"}:
            raise SystemExit(f"Unsupported op: {op_type}")
        result: dict[str, Any] = {"op": op_type, "input": op, "status": "ok", "dry_run": dry_run}
        if op_type == "mkdir":
            target = resolve_workspace_path(op["path"])
            result["target"] = str(target)
            if not dry_run:
                ensure_dir(target)
        elif op_type == "touch":
            target = resolve_workspace_path(op["path"])
            result["target"] = str(target)
            if not dry_run:
                ensure_dir(target.parent)
                target.touch(exist_ok=True)
        elif op_type == "move":
            src = resolve_workspace_path(op["src"])
            dst = resolve_workspace_path(op["dst"])
            result["src"] = str(src)
            result["dst"] = str(dst)
            if not dry_run:
                ensure_dir(dst.parent)
                shutil.move(str(src), str(dst))
        elif op_type == "copy":
            src = resolve_workspace_path(op["src"])
            dst = resolve_workspace_path(op["dst"])
            result["src"] = str(src)
            result["dst"] = str(dst)
            if not dry_run:
                ensure_dir(dst.parent)
                if src.is_dir():
                    shutil.copytree(src, dst, dirs_exist_ok=True)
                else:
                    shutil.copy2(src, dst)
        results.append(result)
    return results


def apply_proposal(args: argparse.Namespace) -> None:
    bootstrap(args)
    src = find_proposal_file(PROPOSAL_APPROVED_DIR, args.proposal)
    proposal = read_json(src, {})
    proposal_id = proposal.get("proposal_id", src.stem)
    operations = proposal.get("operations", [])
    if not isinstance(operations, list):
        raise SystemExit("proposal.operations must be a list")

    before_snapshot = snapshot_tree("before", proposal_id)
    op_results = apply_operations(operations, dry_run=args.dry_run)
    after_snapshot = snapshot_tree("after", proposal_id)

    proposal["status"] = "applied-dry-run" if args.dry_run else "applied"
    proposal["applied_at"] = now_iso()
    proposal["snapshots"] = {"before": str(before_snapshot), "after": str(after_snapshot)}
    proposal["operation_results"] = op_results

    if not args.dry_run:
        dst = PROPOSAL_APPLIED_DIR / src.name
        write_json(dst, proposal)
        src.unlink(missing_ok=True)
    else:
        dst = src
        write_json(dst, proposal)

    changelog_event = {
        "created_at": now_iso(),
        "action": "apply-proposal",
        "proposal_id": proposal_id,
        "status": proposal["status"],
        "dry_run": args.dry_run,
        "operations": len(op_results),
    }
    append_jsonl(CHANGELOG_JSONL, changelog_event)

    print(
        json.dumps(
            {
                "status": "ok",
                "action": "apply",
                "proposal_id": proposal_id,
                "dry_run": args.dry_run,
                "proposal_path": str(dst),
                "before_snapshot": str(before_snapshot),
                "after_snapshot": str(after_snapshot),
                "operations": op_results,
            },
            ensure_ascii=False,
            indent=2,
        )
    )


def status(args: argparse.Namespace) -> None:
    bootstrap(args)
    payload = build_status_payload()
    print(json.dumps(payload, ensure_ascii=False, indent=2))


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Knowledge OS CLI")
    sub = parser.add_subparsers(dest="command", required=True)

    p_boot = sub.add_parser("bootstrap", help="기본 구조/제어 파일 초기화")
    p_boot.set_defaults(func=bootstrap)

    p_capture = sub.add_parser("capture", help="원자 노트 생성")
    p_capture.add_argument("--title", required=True)
    p_capture.add_argument("--body", default="")
    p_capture.add_argument("--body-file")
    p_capture.add_argument("--para", default="inbox", choices=PARA_BUCKETS)
    p_capture.add_argument("--topic", default="general")
    p_capture.add_argument("--tags", default="")
    p_capture.add_argument("--source", default="manual")
    p_capture.add_argument("--domain", default="general", choices=DOMAINS)
    p_capture.add_argument("--source-type", default="capture", choices=SOURCE_TYPES)
    p_capture.add_argument("--purpose", default="")
    p_capture.set_defaults(func=capture)

    p_link = sub.add_parser("link", help="노트 간 링크 생성")
    p_link.add_argument("--from-id", required=True)
    p_link.add_argument("--to-id", required=True)
    p_link.add_argument("--relation", required=True)
    p_link.add_argument("--reason", default="")
    p_link.set_defaults(func=link)

    p_sync = sub.add_parser("sync-ontology", help="노트/링크를 온톨로지로 반영")
    p_sync.set_defaults(func=sync_ontology)

    p_prompt_build = sub.add_parser("build-prompt-pack", help="ai_prompts를 ROOT/제1원칙 프레임으로 조합")
    p_prompt_build.set_defaults(func=build_prompt_pack)

    p_prompt_list = sub.add_parser("list-prompt-pack", help="최신 프롬프트 팩 목록 조회")
    p_prompt_list.set_defaults(func=list_prompt_pack)

    p_prompt_import = sub.add_parser("import-prompt-notes", help="프롬프트 팩을 원자 노트로 일괄 수집")
    p_prompt_import.add_argument("--domain", default="strategy")
    p_prompt_import.add_argument("--policy-note-id", default="")
    p_prompt_import.add_argument("--rebuild-pack", action="store_true")
    p_prompt_import.set_defaults(func=import_prompt_notes)

    p_map = sub.add_parser("build-map", help="도메인 노트 링크맵(MAP.md) 생성")
    p_map.add_argument("--domain", default="strategy")
    p_map.set_defaults(func=build_map)

    p_cycle = sub.add_parser("run-cycle", help="프롬프트 조합->수집->맵->온톨로지 동기화 일괄 실행")
    p_cycle.add_argument("--domain", default="strategy")
    p_cycle.add_argument(
        "--auto-zk-skeletons",
        action="store_true",
        help="bus/messages.jsonl에서 'ZK coverage gap(s)' 태그를 추출해 atomic_notes 스켈레톤을 자동 생성",
    )
    p_cycle.set_defaults(func=run_cycle)

    p_mcp = sub.add_parser("mcp-check", help="등록된 MCP 서버 stdio 헬스체크")
    p_mcp.add_argument(
        "--save-log",
        default="",
        help="지정 경로에 결과 JSON을 저장합니다(부모 디렉토리 자동 생성).",
    )
    p_mcp.add_argument(
        "--fix",
        action="store_true",
        help="실패 시 1회 자체 재시도를 수행합니다(가벼운 자동복구).",
    )
    p_mcp.set_defaults(func=mcp_check)

    p_snapshot = sub.add_parser("refresh-status-snapshot", help="status_snapshot.json 갱신")
    p_snapshot.set_defaults(func=refresh_status_snapshot)

    p_obsidian = sub.add_parser("export-obsidian", help="Obsidian용 시스템 구조 문서 갱신")
    p_obsidian.set_defaults(func=export_obsidian)

    p_agent_install = sub.add_parser("install-launchagent", help="Knowledge OS 주기 실행 LaunchAgent 설치")
    p_agent_install.add_argument("--interval-minutes", type=int, default=60)
    p_agent_install.add_argument("--domain", default="strategy")
    p_agent_install.set_defaults(func=install_launchagent)

    p_agent_status = sub.add_parser("launchagent-status", help="Knowledge OS LaunchAgent 상태 확인")
    p_agent_status.set_defaults(func=launchagent_status)

    p_templates = sub.add_parser("list-templates", help="proposal 템플릿 목록 조회")
    p_templates.set_defaults(func=list_templates)

    p_prop_tmpl = sub.add_parser("propose-from-template", help="템플릿 기반 draft proposal 생성")
    p_prop_tmpl.add_argument("--template", required=True)
    p_prop_tmpl.add_argument("--title", default="")
    p_prop_tmpl.add_argument("--reason", default="")
    p_prop_tmpl.add_argument("--vars", default="")
    p_prop_tmpl.add_argument("--notes", default="")
    p_prop_tmpl.set_defaults(func=propose_from_template)

    p_prop = sub.add_parser("propose", help="구조 재정의 제안 생성")
    p_prop.add_argument("--title", required=True)
    p_prop.add_argument("--reason", required=True)
    p_prop.add_argument("--operations", default="")
    p_prop.add_argument("--notes", default="")
    p_prop.set_defaults(func=propose)

    p_approve = sub.add_parser("approve", help="draft 제안을 approved로 승격")
    p_approve.add_argument("--proposal", required=True)
    p_approve.set_defaults(func=approve)

    p_apply = sub.add_parser("apply", help="approved 제안을 반영")
    p_apply.add_argument("--proposal", required=True)
    p_apply.add_argument("--dry-run", action="store_true")
    p_apply.set_defaults(func=apply_proposal)

    p_status = sub.add_parser("status", help="전체 상태 요약")
    p_status.set_defaults(func=status)

    return parser


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(130)
