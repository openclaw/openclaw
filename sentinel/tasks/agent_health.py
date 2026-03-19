#!/usr/bin/env python3
"""Agent health — workspace structure checks + rule inheritance.

Runs every 1h. Zero AI cost. Ten check items:
   1. Workspace path exists and is readable
   2. SOUL.md exists
   3. AGENTS.md exists (auto-create minimal template if missing)
   4. memory/ directory exists (auto mkdir -p)
   5. .openclaw/ directory exists (auto mkdir -p)
   6. Core rules inherited (inject _sentinel_rules.md if < 5 rules)
   7. HEARTBEAT.md exists (auto-create template)
   8. TOOLS.md exists (auto-create template)
   9. _sentinel_rules.md version matches latest (auto-update if stale)
  10. openclaw.json has at least one binding for this agent

Usage:
    python3 sentinel/tasks/agent_health.py --dry-run
"""

import hashlib
import json
import logging
import re
import sys
from datetime import datetime
from pathlib import Path

SENTINEL_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(SENTINEL_ROOT))

from lib.telegram import TelegramBridge

logger = logging.getLogger("sentinel.agent_health")

OPENCLAW_CONFIG = Path.home() / ".openclaw" / "openclaw.json"

# ── 5 core rules: regex patterns to detect in combined text ──
RULE_PATTERNS = {
    "anti_thought_leak": re.compile(r"洩漏思考|思維洩漏|禁止洩漏|禁止.*思考過程"),
    "anti_consecutive":  re.compile(r"連續發|禁止連續|禁止.*多則"),
    "anti_auto_summary": re.compile(r"自動總結|禁止.*總結"),
    "anti_self_eval":    re.compile(r"自我評價|禁止.*評價"),
    "anti_work_avoidance": re.compile(r"逃避工作|禁止逃避|收到指令.*執行|第一反應.*執行|列選項.*建議問"),
}

# Cooldown between notifications for the same alert (seconds)
NOTIFY_COOLDOWN = 3600  # 1 hour

# ── _sentinel_rules.md content ──
SENTINEL_RULES_CONTENT = """\
<!-- SENTINEL_MANAGED — 此檔案由 Sentinel agent_health 自動維護，請勿手動編輯 -->
<!-- version: 3 -->
# 核心行為規則（繼承自 workspace/SOUL.md）

1. **禁止洩漏思考過程** — 工具調用和中間推理是內部的，只有最終結果才能發出去
2. **禁止連續發多則** — 一個問題一個回覆
3. **禁止自動總結** — 回完話就停
4. **禁止自我評價** — 不要寫「展現了XX能力」「驗證了XX價值」
5. **禁止逃避工作** — 收到指令就執行，不要列選項菜單、不要建議問別人、不要用分析代替動手。第一反應是調用工具，不是打字。
"""

SENTINEL_RULES_HASH = hashlib.md5(SENTINEL_RULES_CONTENT.encode()).hexdigest()

# ── AGENTS.md minimal template ──
AGENTS_TEMPLATE = """\
# AGENTS.md — {agent_id}

## Boot Sequence

1. `SOUL.md` — identity
2. `AGENTS.md` — this file
3. `memory/` — today's memory
4. `workspace/BULLETIN.md` — cross-brain shared state

Skip missing files. Do not report what you loaded.
"""

# ── HEARTBEAT.md template ──
HEARTBEAT_TEMPLATE = """\
# HEARTBEAT.md — {agent_id}

> Session coordination file. Auto-created by Sentinel.

| # | Check | Status |
|---|-------|--------|
| 1 | SOUL.md loaded | ⬜ |
| 2 | AGENTS.md loaded | ⬜ |
| 3 | memory/ accessible | ⬜ |
"""

# ── TOOLS.md template ──
TOOLS_TEMPLATE = """\
# TOOLS.md — {agent_id}

> Tool definitions. Auto-created by Sentinel. Customize per agent needs.

## Available Tools

- **Bash** — execute shell commands
- **Read / Write / Edit** — file operations
- **Glob / Grep** — search codebase
- **WebFetch / WebSearch** — web access

## Constraints

- Do not execute destructive commands without confirmation
- Prefer dedicated tools over Bash equivalents
"""


def _load_openclaw() -> dict:
    """Load full openclaw.json."""
    if not OPENCLAW_CONFIG.exists():
        logger.error("openclaw.json not found: %s", OPENCLAW_CONFIG)
        return {}
    with open(OPENCLAW_CONFIG) as f:
        return json.load(f)


def _load_agents(data: dict | None = None) -> list[dict]:
    """Extract agent list from openclaw data."""
    if data is None:
        data = _load_openclaw()
    return data.get("agents", {}).get("list", [])


def _load_bindings(data: dict | None = None) -> dict[str, int]:
    """Count bindings per agent_id from openclaw.json."""
    if data is None:
        data = _load_openclaw()
    counts: dict[str, int] = {}
    for binding in data.get("bindings", []):
        aid = binding.get("agentId", "")
        counts[aid] = counts.get(aid, 0) + 1
    return counts


def _check_rules(workspace: Path) -> dict[str, bool]:
    """Check which core rules are present in combined SOUL.md + AGENTS.md + _sentinel_rules.md."""
    combined = ""
    for fname in ("SOUL.md", "AGENTS.md", "_sentinel_rules.md"):
        fpath = workspace / fname
        if fpath.exists():
            try:
                combined += fpath.read_text(errors="replace")
            except OSError:
                pass

    results = {}
    for name, pattern in RULE_PATTERNS.items():
        results[name] = bool(pattern.search(combined))
    return results


def _check_agent(agent: dict, bindings: dict[str, int], dry_run: bool = False) -> dict:
    """Run all 10 checks on a single agent. Returns check result dict."""
    agent_id = agent["id"]
    ws_path = Path(agent.get("workspace", ""))
    result = {
        "score": 0,
        "max": 10,
        "fixes": [],
        "issues": [],
        "rules": {},
    }

    # ── 1. Workspace exists ──
    if ws_path.is_dir():
        result["score"] += 1
    else:
        result["issues"].append(f"{agent_id}: workspace 不存在 ({ws_path})")
        return result  # Can't check further

    # ── 2. SOUL.md exists ──
    soul = ws_path / "SOUL.md"
    if soul.exists():
        result["score"] += 1
    else:
        result["issues"].append(f"{agent_id}: SOUL.md missing")

    # ── 3. AGENTS.md exists (auto-create if missing) ──
    agents_md = ws_path / "AGENTS.md"
    if agents_md.exists():
        result["score"] += 1
    else:
        if not dry_run:
            try:
                agents_md.write_text(AGENTS_TEMPLATE.format(agent_id=agent_id))
                result["fixes"].append("AGENTS.md created")
                result["score"] += 1
            except OSError as e:
                result["issues"].append(f"{agent_id}: AGENTS.md create failed: {e}")
        else:
            result["fixes"].append("AGENTS.md would be created")

    # ── 4. memory/ exists (auto mkdir) ──
    mem_dir = ws_path / "memory"
    if mem_dir.is_dir():
        result["score"] += 1
    else:
        if not dry_run:
            try:
                mem_dir.mkdir(parents=True, exist_ok=True)
                result["fixes"].append("memory/ created")
                result["score"] += 1
            except OSError as e:
                result["issues"].append(f"{agent_id}: memory/ mkdir failed: {e}")
        else:
            result["fixes"].append("memory/ would be created")

    # ── 5. .openclaw/ exists (auto mkdir) ──
    oc_dir = ws_path / ".openclaw"
    if oc_dir.is_dir():
        result["score"] += 1
    else:
        if not dry_run:
            try:
                oc_dir.mkdir(parents=True, exist_ok=True)
                result["fixes"].append(".openclaw/ created")
                result["score"] += 1
            except OSError as e:
                result["issues"].append(f"{agent_id}: .openclaw/ mkdir failed: {e}")
        else:
            result["fixes"].append(".openclaw/ would be created")

    # ── 6. Core rules inherited ──
    optout = ws_path / ".sentinel_optout"
    if optout.exists():
        result["score"] += 1  # Opted out counts as pass
        result["rules"] = {k: True for k in RULE_PATTERNS}
    else:
        rules = _check_rules(ws_path)
        result["rules"] = rules
        matched = sum(1 for v in rules.values() if v)
        if matched >= 5:
            result["score"] += 1
        else:
            rules_file = ws_path / "_sentinel_rules.md"
            if not dry_run:
                try:
                    rules_file.write_text(SENTINEL_RULES_CONTENT)
                    result["fixes"].append(f"_sentinel_rules.md injected ({matched}/5 → 5/5)")
                    result["score"] += 1
                except OSError as e:
                    result["issues"].append(f"{agent_id}: rule injection failed: {e}")
            else:
                result["fixes"].append(f"_sentinel_rules.md would be injected ({matched}/5)")

    # ── 7. HEARTBEAT.md exists (auto-create) ──
    hb = ws_path / "HEARTBEAT.md"
    if hb.exists():
        result["score"] += 1
    else:
        if not dry_run:
            try:
                hb.write_text(HEARTBEAT_TEMPLATE.format(agent_id=agent_id))
                result["fixes"].append("HEARTBEAT.md created")
                result["score"] += 1
            except OSError as e:
                result["issues"].append(f"{agent_id}: HEARTBEAT.md create failed: {e}")
        else:
            result["fixes"].append("HEARTBEAT.md would be created")

    # ── 8. TOOLS.md exists (auto-create) ──
    tools = ws_path / "TOOLS.md"
    if tools.exists():
        result["score"] += 1
    else:
        if not dry_run:
            try:
                tools.write_text(TOOLS_TEMPLATE.format(agent_id=agent_id))
                result["fixes"].append("TOOLS.md created")
                result["score"] += 1
            except OSError as e:
                result["issues"].append(f"{agent_id}: TOOLS.md create failed: {e}")
        else:
            result["fixes"].append("TOOLS.md would be created")

    # ── 9. _sentinel_rules.md version matches latest ──
    if optout.exists():
        result["score"] += 1  # Optout = pass
    else:
        rules_file = ws_path / "_sentinel_rules.md"
        if rules_file.exists():
            try:
                current = rules_file.read_text(errors="replace")
                current_hash = hashlib.md5(current.encode()).hexdigest()
                if current_hash == SENTINEL_RULES_HASH:
                    result["score"] += 1
                else:
                    # Stale version — update
                    if not dry_run:
                        rules_file.write_text(SENTINEL_RULES_CONTENT)
                        result["fixes"].append("_sentinel_rules.md updated (stale → latest)")
                        result["score"] += 1
                    else:
                        result["fixes"].append("_sentinel_rules.md would be updated (stale)")
            except OSError:
                pass
        elif any("injected" in f for f in result["fixes"]):
            # Just injected in check #6 — it's already latest
            result["score"] += 1
        elif sum(1 for v in result["rules"].values() if v) >= 5:
            # Agent natively has all 5 rules — no _sentinel_rules.md needed
            result["score"] += 1

    # ── 10. openclaw.json binding exists ──
    bind_count = bindings.get(agent_id, 0)
    if bind_count > 0:
        result["score"] += 1
    else:
        result["issues"].append(f"{agent_id}: openclaw.json 無綁定 (0 bindings)")

    # ── 11. Capability matrix — model vs SOUL requirements ──
    model_id = agent.get("model", {}).get("primary", "")
    soul_text = ""
    if soul.exists():
        try:
            soul_text = soul.read_text(errors="replace")
        except OSError:
            pass

    cap_issues = _check_capability_matrix(agent_id, model_id, soul_text, bind_count)
    for ci in cap_issues:
        result["issues"].append(ci)

    # ── 12. MEMORY.md recommended for agents with 3+ bindings ──
    if bind_count >= 3:
        memory_md = ws_path / "MEMORY.md"
        if not memory_md.exists():
            result["issues"].append(
                f"{agent_id}: 有 {bind_count} 個 bindings 但無 MEMORY.md — 建議建立持久記憶"
            )

    # ── 13. BOOTSTRAP.md existence check (P2 advisory, no auto-create) ──
    bootstrap = ws_path / "BOOTSTRAP.md"
    if not bootstrap.exists():
        result["issues"].append(
            f"{agent_id}: P2 BOOTSTRAP.md missing — agent 缺乏穩定身份 context"
        )

    return result


# Models known to NOT support vision (text-only input)
_NO_VISION_MODELS = {"deepseek/deepseek-chat", "deepseek/deepseek-reasoner"}
# Models known to have small output limits
_SMALL_OUTPUT_MODELS = {"deepseek/deepseek-chat": 2048}

# SOUL.md keywords indicating vision requirement
_VISION_KEYWORDS = re.compile(r"截圖|圖片|screenshot|image|photo|照片|視覺")
# SOUL.md keywords indicating heavy analysis output
_ANALYSIS_KEYWORDS = re.compile(r"報告|分析|report|analysis|digest|校準")


def _check_capability_matrix(agent_id: str, model_id: str, soul_text: str,
                              bind_count: int) -> list[str]:
    """Check if the agent's model matches its SOUL requirements."""
    issues = []

    if not model_id or not soul_text:
        return issues

    # Vision check: SOUL mentions images but model is text-only
    needs_vision = bool(_VISION_KEYWORDS.search(soul_text))
    if needs_vision and model_id in _NO_VISION_MODELS:
        issues.append(
            f"{agent_id}: SOUL 需要圖片處理但 {model_id} 不支援 vision "
            f"— 需設定 tools.media.image 或換 model"
        )

    # Output size check: SOUL mentions analysis/reports but model has small output
    needs_long_output = bool(_ANALYSIS_KEYWORDS.search(soul_text))
    max_output = _SMALL_OUTPUT_MODELS.get(model_id)
    if needs_long_output and max_output and max_output < 4096:
        issues.append(
            f"{agent_id}: SOUL 需要產出報告/分析但 {model_id} maxTokens={max_output} "
            f"— 可能截斷輸出"
        )

    return issues


def _should_notify(alert_key: str, known_alerts: dict, now: datetime) -> bool:
    """Check notification cooldown (1-hour dedup)."""
    entry = known_alerts.get(alert_key)
    if not entry:
        return True
    last_notified = entry.get("last_notified")
    if not last_notified:
        return True
    try:
        last_dt = datetime.fromisoformat(last_notified)
        return (now - last_dt).total_seconds() >= NOTIFY_COOLDOWN
    except (ValueError, TypeError):
        return True


def _check_binding_completeness(oc_data: dict) -> list[str]:
    """B2: Check that every group in config.json has a valid agent binding.

    Returns list of P1 issue strings for groups missing agent_id or
    agent_id not found in openclaw.json bindings.
    """
    issues = []
    config_path = SENTINEL_ROOT / "config.json"
    if not config_path.exists():
        return issues

    try:
        with open(config_path) as f:
            scan_cfg = json.load(f)
    except (json.JSONDecodeError, OSError):
        return issues

    groups = scan_cfg.get("groups", {})
    agent_ids_in_oc = {a["id"] for a in oc_data.get("agents", {}).get("list", [])}
    binding_ids = {b.get("agentId") for b in oc_data.get("bindings", [])}

    for chat_id, info in groups.items():
        name = info.get("name", chat_id)
        priority = info.get("priority", "low")
        agent_id = info.get("agent_id")

        if not agent_id:
            if priority in ("high", "medium"):
                issues.append(f"群組 {name} ({chat_id}): 無 agent_id — {priority} 優先群組未綁定 agent")
            continue

        if agent_id not in agent_ids_in_oc:
            issues.append(f"群組 {name} ({chat_id}): agent_id={agent_id} 不在 openclaw.json agents.list")

        if agent_id not in binding_ids:
            issues.append(f"群組 {name} ({chat_id}): agent_id={agent_id} 無 openclaw.json binding")

    return issues


def run(config: dict, state: dict) -> dict:
    """Main entry point called by sentinel.py."""
    logger.info("=== agent_health: start ===")

    oc_data = _load_openclaw()
    agents = _load_agents(oc_data)
    bindings = _load_bindings(oc_data)

    if not agents:
        logger.warning("No agents found in openclaw.json")
        return {"agents_checked": 0, "error": "no agents in openclaw.json"}

    # State for dedup
    sentinel = state.setdefault("sentinel", {})
    ah_state = sentinel.setdefault("agent_health", {})
    known_alerts = ah_state.setdefault("known_alerts", {})

    # Notification bridge
    notify_url = config.get("notifications", {}).get(
        "telegram_bridge", "http://localhost:18790"
    )
    cruz_id = config.get("notifications", {}).get("cruz_chat_id", "448345880")
    telegram = TelegramBridge(bridge_url=notify_url)

    now = datetime.now()
    result = {
        "agents_checked": 0,
        "structure_fixes": 0,
        "rule_injections": 0,
        "p1_issues": [],
        "agents": {},
    }
    current_alert_keys: set = set()

    # ── B2: Binding completeness — groups vs agent config ──
    binding_issues = _check_binding_completeness(oc_data)
    for issue in binding_issues:
        result["p1_issues"].append(issue)
        alert_key = f"binding_completeness:{issue[:60]}"
        current_alert_keys.add(alert_key)
        if _should_notify(alert_key, known_alerts, now):
            msg = f"[Sentinel Binding] P1 {issue}"
            resp = telegram.send(msg, cruz_id)
            if resp.get("ok") or resp.get("error") is None:
                logger.info("Notified: %s", msg)
            if alert_key not in known_alerts:
                known_alerts[alert_key] = {
                    "first_seen": now.isoformat(),
                    "last_notified": now.isoformat(),
                    "count": 1,
                }
            else:
                known_alerts[alert_key]["last_notified"] = now.isoformat()
                known_alerts[alert_key]["count"] = known_alerts[alert_key].get("count", 0) + 1

    for agent in agents:
        agent_id = agent["id"]
        check = _check_agent(agent, bindings)
        result["agents"][agent_id] = check
        result["agents_checked"] += 1

        # Count fixes
        for fix in check["fixes"]:
            if "rules" in fix or "sentinel_rules" in fix:
                result["rule_injections"] += 1
            else:
                result["structure_fixes"] += 1

        # P1 issues: SOUL.md missing, workspace missing, no binding
        for issue in check["issues"]:
            result["p1_issues"].append(issue)

            alert_key = f"agent_health:{agent_id}:{issue.split(':')[1].strip() if ':' in issue else issue}"
            current_alert_keys.add(alert_key)

            if _should_notify(alert_key, known_alerts, now):
                msg = f"[Sentinel Agent健康] P1 {issue}"
                resp = telegram.send(msg, cruz_id)
                if resp.get("ok") or resp.get("error") is None:
                    logger.info("Notified: %s", msg)
                else:
                    logger.warning("Notify failed: %s", resp)

                if alert_key not in known_alerts:
                    known_alerts[alert_key] = {
                        "first_seen": now.isoformat(),
                        "last_notified": now.isoformat(),
                        "count": 1,
                    }
                else:
                    known_alerts[alert_key]["last_notified"] = now.isoformat()
                    known_alerts[alert_key]["count"] = known_alerts[alert_key].get("count", 0) + 1

    # Clean resolved alerts
    stale = [k for k in known_alerts if k not in current_alert_keys]
    for k in stale:
        del known_alerts[k]

    # Store summary
    ah_state["last_run"] = now.isoformat()
    ah_state["last_result"] = {
        "agents_checked": result["agents_checked"],
        "structure_fixes": result["structure_fixes"],
        "rule_injections": result["rule_injections"],
        "p1_count": len(result["p1_issues"]),
        "p1_issues": result["p1_issues"][:10],
        "agents": {
            aid: {
                "score": info["score"],
                "max": info["max"],
                "fixes": info["fixes"],
                "rules": info["rules"],
            }
            for aid, info in result["agents"].items()
        },
    }

    logger.info(
        "=== agent_health: done — %d agents, %d fixes, %d injections, %d P1 ===",
        result["agents_checked"],
        result["structure_fixes"],
        result["rule_injections"],
        len(result["p1_issues"]),
    )
    return result


# ---------------------------------------------------------------------------
# Standalone
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    import argparse

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(name)s %(levelname)s %(message)s",
    )

    parser = argparse.ArgumentParser(description="Agent health (standalone)")
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Check without auto-repair or notifications",
    )
    args = parser.parse_args()

    oc_data = _load_openclaw()
    agents = _load_agents(oc_data)
    agent_bindings = _load_bindings(oc_data)

    if not agents:
        print("No agents found in openclaw.json")
        sys.exit(1)

    total_fixes = 0
    total_issues = 0

    for agent in agents:
        agent_id = agent["id"]
        check = _check_agent(agent, agent_bindings, dry_run=args.dry_run)
        score = check["score"]
        mx = check["max"]
        color = "\033[32m" if score >= 8 else "\033[33m" if score >= 5 else "\033[31m"
        reset = "\033[0m"

        print(f"\n{color}{agent_id}: {score}/{mx}{reset}")

        if check["fixes"]:
            for fix in check["fixes"]:
                print(f"  [fix] {fix}")
                total_fixes += 1
        if check["issues"]:
            for issue in check["issues"]:
                print(f"  [P1]  {issue}")
                total_issues += 1

        # Show rules
        rules = check["rules"]
        if rules:
            missing = [k for k, v in rules.items() if not v]
            if missing:
                print(f"  [rules] missing: {', '.join(missing)}")
            else:
                print(f"  [rules] 5/5 ✓")

    prefix = "[dry-run] " if args.dry_run else ""
    print(f"\n{prefix}Total: {len(agents)} agents, {total_fixes} fixes, {total_issues} P1 issues")
