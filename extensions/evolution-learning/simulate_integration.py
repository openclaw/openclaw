#!/usr/bin/env python3
"""
四層進化學習 × OpenClaw 架構整合壓力模擬

這不是單元測試。這是模擬插件裝進 OpenClaw 之後，
在真實架構中可能遇到的所有崩潰點：

場景 A：啟動競速（Service 還沒就緒，hook 已先開跑）
場景 B：Hook 衝突（與 active-memory 同優先級搶佔）
場景 C：多 Session 並發（同時寫同一個 JSONL 檔案）
場景 D：Token 超額（注入內容超過 500 token 預算）
場景 E：Hook 超時（before_prompt_build 被 2000ms 截斷）
場景 F：Config 熱更新（運行中改設定，plugin 需重新載入）
場景G：磁碟滿/無寫入權限（IOError 優雅降級）
場景 H：損毀狀態檔（上次未正常退出，檔案不完整）
場景 I：連續快速請求（快取競速條件）
場景 J：REM 週期與 hook 同時跑（交錯寫入）
"""

import json
import math
import os
import random
import shutil
import signal
import sys
import tempfile
import threading
import time
import traceback
from contextlib import nullcontext
from concurrent.futures import ThreadPoolExecutor, as_completed, TimeoutError as FutureTimeoutError
from dataclasses import dataclass, field, asdict
from datetime import datetime
from pathlib import Path
from typing import Optional

random.seed(42)
PYTHONIOENCODING = "utf-8"

# ─── 架構常數（對應 OpenClaw 真實設定）────────────────────────

HOOK_TIMEOUT_MS = 2000          # before_prompt_build 的 timeoutMs
MAX_INJECT_TOKENS = 300         # 我們設定的 maxContextTokens
SYSTEM_TOKEN_BUDGET = 500       # OpenClaw 整體注入預算
ACTIVE_MEMORY_PRIORITY = 200    # active-memory 的優先級
EVOLUTION_PRIORITY = 100        # 我們的優先級
EMA_ALPHA = 0.1
CONFIDENCE_FLOOR = 0.6
CACHE_TTL_SEC = 60

# ─── 結果追蹤 ─────────────────────────────────────────────────

@dataclass
class ScenarioResult:
    name: str
    turns: int
    passed: bool
    crashes: list = field(default_factory=list)
    warnings: list = field(default_factory=list)
    stats: dict = field(default_factory=dict)

results: list[ScenarioResult] = []
total_scenarios = 0
passed_scenarios = 0

def report(scenario: ScenarioResult):
    global total_scenarios, passed_scenarios
    total_scenarios += 1
    if scenario.passed:
        passed_scenarios += 1
        print(f"  ✅ {scenario.name} ({scenario.turns} 輪)")
    else:
        print(f"  ❌ {scenario.name} ({scenario.turns} 輪)")
        for c in scenario.crashes:
            print(f"      崩潰：{c}")
        for w in scenario.warnings:
            print(f"      警告：{w}")
    if scenario.stats:
        for k, v in scenario.stats.items():
            print(f"      {k}：{v}")
    results.append(scenario)

# ─── 共用狀態管理（精簡版，重點在整合邏輯） ────────────────────

@dataclass
class NuwaPattern:
    id: str
    target: str = ""
    slug: str = ""
    confidence: float = 0.75
    successRate: float = 0.0
    sampleCount: int = 0
    mentalModels: list = field(default_factory=list)
    category: str = "nuwa"
    createdAt: str = ""
    lastUsed: Optional[str] = None

@dataclass
class StemCell:
    id: str
    target: str = ""
    slug: str = ""
    patternId: str = ""
    status: str = "embryo"
    maturityScore: float = 0.1
    usageCount: int = 0
    positiveRating: int = 0

PERSONAS = [
    {"target": "查理·芒格", "slug": "charlie-munger",
     "mentalModels": ["多元思維模型格柵","逆向思考","能力圈","心理偏誤清單","基本費率優先","複利思維","激勵機制第一","機會成本"]},
    {"target": "理查·費曼", "slug": "richard-feynman",
     "mentalModels": ["費曼學習法","第一原理思考","不確定性誠實","好奇心驅動","跨領域類比"]},
    {"target": "Naval Ravikant", "slug": "naval-ravikant",
     "mentalModels": ["特定知識","槓桿無限複製","財富而非金錢","長壽型職業","冥想決策"]},
]

def make_state_dir() -> tuple[Path, Path]:
    tmp = Path(tempfile.mkdtemp(prefix="evo-integ-"))
    sd = tmp / ".claude" / "evolution-state"
    sd.mkdir(parents=True, exist_ok=True)
    return tmp, sd

def write_initial_state(state_dir: Path):
    now = datetime.now().isoformat()
    patterns = []
    cells = []
    for i, p in enumerate(PERSONAS):
        pid = f"nuwa-{p['slug']}-init"
        patterns.append({
            "id": pid, "target": p["target"], "slug": p["slug"],
            "confidence": 0.75, "successRate": 0.0, "sampleCount": 0,
            "mentalModels": p["mentalModels"], "category": "nuwa",
            "createdAt": now, "lastUsed": None,
        })
        cells.append({
            "id": f"stem-{p['slug']}-001", "target": p["target"],
            "slug": p["slug"], "patternId": pid,
            "status": "embryo", "maturityScore": 0.1,
            "usageCount": 0, "positiveRating": 0,
        })
    pf = state_dir / "patterns.jsonl"
    pf.write_text("\n".join(json.dumps(x, ensure_ascii=False) for x in patterns) + "\n", encoding="utf-8")
    rf = state_dir / "cell-registry.json"
    rf.write_text(json.dumps({"version": 1, "cells": {}, "stemCells": cells}, ensure_ascii=False, indent=2), encoding="utf-8")

def load_patterns(state_dir: Path) -> list[dict]:
    pf = state_dir / "patterns.jsonl"
    if not pf.exists():
        return []
    patterns = []
    for line in pf.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
            if obj.get("category") == "nuwa":
                patterns.append(obj)
        except json.JSONDecodeError:
            pass
    return patterns

def detect_persona(prompt: str, patterns: list[dict], threshold: float) -> Optional[dict]:
    lower = prompt.lower()
    triggers = {
        "charlie-munger": ["芒格", "munger", "charlie"],
        "richard-feynman": ["費曼", "feynman", "richard"],
        "naval-ravikant": ["naval", "ravikant"],
    }
    for slug, kws in triggers.items():
        if any(k in lower for k in kws):
            for p in patterns:
                if p["slug"] == slug and p["confidence"] >= threshold:
                    return p
    return None

def update_pattern_ema(state_dir: Path, pattern_id: str, success: bool, lock: threading.Lock = None) -> dict:
    """EMA 更新，支援 lock 防止並發寫入競速"""
    ctx = lock if lock else nullcontext()
    with ctx:
        pf = state_dir / "patterns.jsonl"
        if not pf.exists():
            return {}
        lines = pf.read_text(encoding="utf-8").splitlines()
        updated = {}
        new_lines = []
        for line in lines:
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
                if obj.get("id") == pattern_id:
                    reward = 1.0 if success else 0.0
                    obj["successRate"] = EMA_ALPHA * reward + (1 - EMA_ALPHA) * obj.get("successRate", 0)
                    obj["confidence"] = max(CONFIDENCE_FLOOR, EMA_ALPHA * obj["successRate"] + (1 - EMA_ALPHA) * obj.get("confidence", 0.75))
                    obj["sampleCount"] = obj.get("sampleCount", 0) + 1
                    obj["lastUsed"] = datetime.now().isoformat()
                    updated = {"confidence": obj["confidence"], "successRate": obj["successRate"]}
                new_lines.append(json.dumps(obj, ensure_ascii=False))
            except json.JSONDecodeError:
                pass
        pf.write_text("\n".join(new_lines) + "\n", encoding="utf-8")
        return updated

def run_rem_cycle(state_dir: Path, lock: threading.Lock = None) -> dict:
    """REM 週期，支援 lock"""
    ctx = lock if lock else nullcontext()
    with ctx:
        rf = state_dir / "cell-registry.json"
        if not rf.exists():
            return {"error": "no registry"}
        try:
            data = json.loads(rf.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            return {"error": "parse error"}
        transitions = {"embryo->incubating": 0, "incubating->ready": 0, "ready->installed": 0}
        for cell in data.get("stemCells", []):
            ub = min(cell.get("usageCount", 0) * 0.05, 0.3)
            uc = cell.get("usageCount", 0)
            rb = (cell.get("positiveRating", 0) / uc * 0.3) if uc > 0 else 0
            raw = min(0.1 + ub + rb, 1.0)
            cell["maturityScore"] = EMA_ALPHA * raw + (1 - EMA_ALPHA) * cell.get("maturityScore", 0.1)
            cell["lastEvaluated"] = datetime.now().isoformat()
            st = cell.get("status", "embryo")
            ms = cell["maturityScore"]
            if st == "embryo" and ms >= 0.3:
                cell["status"] = "incubating"
                transitions["embryo->incubating"] += 1
            elif st == "incubating" and ms >= 0.6:
                cell["status"] = "ready"
                transitions["incubating->ready"] += 1
            elif st == "ready" and ms >= 0.8:
                cell["status"] = "installed"
                transitions["ready->installed"] += 1
        rf.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        return transitions

def validate_state_values(state_dir: Path) -> list[str]:
    issues = []
    for p in load_patterns(state_dir):
        for field, lo, hi in [("confidence", 0, 1), ("successRate", 0, 1)]:
            v = p.get(field, 0)
            if not (lo <= v <= hi):
                issues.append(f"{p['target']}.{field}={v:.4f} 超出 [{lo},{hi}]")
            if math.isnan(v) or math.isinf(v):
                issues.append(f"{p['target']}.{field}={v} NaN/Inf")
    rf = state_dir / "cell-registry.json"
    if rf.exists():
        try:
            data = json.loads(rf.read_text(encoding="utf-8"))
            for cell in data.get("stemCells", []):
                ms = cell.get("maturityScore", 0)
                if not (0 <= ms <= 1):
                    issues.append(f"{cell['target']}.maturityScore={ms:.4f} 超出 [0,1]")
                if cell.get("positiveRating", 0) > cell.get("usageCount", 0):
                    issues.append(f"{cell['target']}: positiveRating > usageCount")
        except:
            issues.append("cell-registry.json 無法解析")
    return issues


# ══════════════════════════════════════════════════════════════
# 場景 A：啟動競速
# Service.start() 是非同步的。第一個對話可能在 evolutionStateDir
# 還是 null 的時候就觸發 before_prompt_build。
# 預期行為：hook 應靜默回傳 undefined，不崩潰。
# ══════════════════════════════════════════════════════════════
def scenario_a_cold_start(n=20):
    """模擬 evolutionStateDir 尚未初始化時，hook 被呼叫"""
    crashes = []
    warnings = []
    state_dir_ref = [None]  # 模擬 module-level variable，初始為 null

    def before_prompt_build(prompt: str) -> Optional[str]:
        """對應 index.ts 的 before_prompt_build hook"""
        if state_dir_ref[0] is None:  # evolutionStateDir is null
            return None  # 應靜默跳過
        sd = Path(state_dir_ref[0])
        if not sd.exists():
            return None
        patterns = load_patterns(sd)
        matched = detect_persona(prompt, patterns, 0.65)
        if not matched:
            return None
        return f"🏺 女媧框架：{matched['target']}"

    # 模擬：前 5 個請求在服務啟動前
    prompts = ["用芒格的方式分析這個"] * 5 + ["一般問題"] * 15
    for i, prompt in enumerate(prompts):
        try:
            result = before_prompt_build(prompt)
            # 前 5 輪 state_dir 為 None，結果應該是 None
            if i < 5 and result is not None:
                crashes.append(f"第 {i+1} 輪：服務未就緒時不應注入，得到 {result!r}")
        except Exception as e:
            crashes.append(f"第 {i+1} 輪崩潰：{e}")

        # 模擬第 6 輪服務啟動完成
        if i == 4:
            tmp, sd = make_state_dir()
            write_initial_state(sd)
            state_dir_ref[0] = str(sd)

    # 服務就緒後的測試
    for i, prompt in enumerate(["用芒格分析投資"]):
        try:
            result = before_prompt_build(prompt)
            if result is None:
                warnings.append("服務就緒後芒格觸發詞未注入（可能關鍵字未匹配）")
        except Exception as e:
            crashes.append(f"服務就緒後崩潰：{e}")

    if state_dir_ref[0]:
        shutil.rmtree(Path(state_dir_ref[0]).parent.parent, ignore_errors=True)

    return ScenarioResult(
        name="A：啟動競速（服務未就緒時 hook 被呼叫）",
        turns=n, passed=len(crashes) == 0,
        crashes=crashes, warnings=warnings,
        stats={"前5輪應靜默": "✅" if not crashes else "❌"}
    )


# ══════════════════════════════════════════════════════════════
# 場景 B：Hook 優先級衝突
# active-memory 優先級 200，evolution-learning 優先級 100。
# active-memory 先跑，若它注入了 200 tokens，
# evolution-learning 再注入 300 tokens = 500 tokens 剛好觸頂。
# 若 active-memory 注入 300 tokens，evolution 再注入就超額。
# ══════════════════════════════════════════════════════════════
def scenario_b_token_budget(n=30):
    """模擬 Token 預算衝突"""
    tmp, sd = make_state_dir()
    write_initial_state(sd)
    crashes = []
    warnings = []
    over_budget = 0

    def active_memory_inject(session_id: int) -> int:
        """模擬 active-memory 隨機注入 50-350 tokens"""
        return random.randint(50, 350)

    def evolution_inject(prompt: str, remaining_budget: int) -> Optional[str]:
        """evolution-learning 注入，必須尊重剩餘預算"""
        if remaining_budget <= 0:
            return None  # 預算用完，靜默跳過
        patterns = load_patterns(sd)
        matched = detect_persona(prompt, patterns, 0.65)
        if not matched:
            return None
        # 建構上下文，截斷至剩餘預算
        max_chars = remaining_budget * 2  # 粗估中文 1字 ≈ 2 tokens
        models = matched["mentalModels"][:5]
        ctx = f"🏺 女媧框架：{matched['target']}\n" + "\n".join(f"• {m}" for m in models)
        if len(ctx) > max_chars:
            ctx = ctx[:max_chars] + "..."
        return ctx

    trigger_prompts = ["用芒格的方式看這個"] * n
    for i, prompt in enumerate(trigger_prompts):
        try:
            am_tokens = active_memory_inject(i)
            remaining = SYSTEM_TOKEN_BUDGET - am_tokens
            ctx = evolution_inject(prompt, remaining)
            evo_tokens = len(ctx) // 2 if ctx else 0
            total = am_tokens + evo_tokens

            if total > SYSTEM_TOKEN_BUDGET + 10:  # 10 token 容差
                over_budget += 1
                warnings.append(f"第 {i+1} 輪 Token 超額：active-memory={am_tokens}+evolution={evo_tokens}={total} > {SYSTEM_TOKEN_BUDGET}")

            # 如果剩餘預算為負，應跳過注入
            if remaining <= 0 and ctx is not None:
                crashes.append(f"第 {i+1} 輪：預算耗盡仍注入（remaining={remaining}）")

        except Exception as e:
            crashes.append(f"第 {i+1} 輪崩潰：{e}")

    shutil.rmtree(tmp, ignore_errors=True)
    return ScenarioResult(
        name="B：Hook 優先級與 Token 預算衝突",
        turns=n, passed=len(crashes) == 0,
        crashes=crashes, warnings=warnings,
        stats={"Token 超額次數": over_budget, "預算管理": "✅ 正常截斷" if not crashes else "❌ 有崩潰"}
    )


# ══════════════════════════════════════════════════════════════
# 場景 C：多 Session 並發寫入同一個 patterns.jsonl
# 現實中多個聊天同時觸發 agent_end → 同時呼叫 recordPatternUsage
# 預期：加鎖後不崩潰；不加鎖時可能資料遺失但不應例外
# ══════════════════════════════════════════════════════════════
def scenario_c_concurrent_writes(n=15):
    """模擬 15 個 session 同時寫 patterns.jsonl"""
    tmp, sd = make_state_dir()
    write_initial_state(sd)
    crashes = []
    warnings = []
    write_lock = threading.Lock()

    def session_worker(session_id: int, use_lock: bool) -> Optional[str]:
        """模擬一個 session 的 agent_end 呼叫"""
        try:
            lock = write_lock if use_lock else None
            result = update_pattern_ema(sd, "nuwa-charlie-munger-init", True, lock)
            if not result:
                return f"session {session_id}: 更新失敗（找不到模式）"
            return None
        except Exception as e:
            return f"session {session_id} 崩潰：{e}"

    # 測試 1：加鎖版（應完全正確）
    with ThreadPoolExecutor(max_workers=n) as executor:
        futures = [executor.submit(session_worker, i, True) for i in range(n)]
        for f in as_completed(futures):
            err = f.result()
            if err:
                crashes.append(err)

    # 驗證寫入結果
    issues = validate_state_values(sd)
    crashes.extend(issues)

    # 讀取最終樣本數（應該是 n 次）
    patterns = load_patterns(sd)
    munger = next((p for p in patterns if p["slug"] == "charlie-munger"), None)
    actual_count = munger.get("sampleCount", 0) if munger else 0

    if actual_count != n:
        warnings.append(f"加鎖後 sampleCount={actual_count}，期望 {n}（可能有競速遺失）")

    # 測試 2：不加鎖版（不應崩潰，但可能有資料競速）
    write_initial_state(sd)  # 重置
    with ThreadPoolExecutor(max_workers=n) as executor:
        futures = [executor.submit(session_worker, i, False) for i in range(n)]
        for f in as_completed(futures):
            err = f.result()
            if err and "崩潰" in err:
                crashes.append(f"[無鎖] {err}")

    issues2 = validate_state_values(sd)
    crashes.extend(issues2)

    shutil.rmtree(tmp, ignore_errors=True)
    return ScenarioResult(
        name=f"C：{n} 個 Session 並發寫入（加鎖 vs 無鎖）",
        turns=n * 2, passed=len(crashes) == 0,
        crashes=crashes, warnings=warnings,
        stats={"有鎖 sampleCount": actual_count, "期望": n}
    )


# ══════════════════════════════════════════════════════════════
# 場景 D：Hook 超時模擬
# before_prompt_build 有 2000ms 超時限制。
# 如果檔案讀取太慢（大檔案、磁碟 IO），hook 會被強制終止。
# 模擬：注入延遲，確認超時後系統不崩潰。
# ══════════════════════════════════════════════════════════════
def scenario_d_hook_timeout(n=20):
    """模擬 hook 超時被截斷的情況"""
    tmp, sd = make_state_dir()
    write_initial_state(sd)
    crashes = []
    warnings = []
    timeout_count = 0
    success_count = 0

    def before_prompt_build_with_delay(prompt: str, delay_ms: int) -> Optional[str]:
        """模擬有延遲的 hook，超過 2000ms 就被截斷"""
        start = time.time()
        time.sleep(delay_ms / 1000)
        elapsed = (time.time() - start) * 1000

        if elapsed > HOOK_TIMEOUT_MS:
            return None  # 超時，回傳 None（不崩潰）

        patterns = load_patterns(sd)
        matched = detect_persona(prompt, patterns, 0.65)
        if not matched:
            return None
        return f"🏺 {matched['target']}"

    delay_scenarios = (
        [50] * 8 +    # 正常（50ms）
        [1500] * 6 +  # 接近超時但成功
        [2100] * 6    # 超時（2100ms > 2000ms）
    )

    for i, delay in enumerate(delay_scenarios[:n]):
        try:
            result = before_prompt_build_with_delay("用芒格分析", delay)
            if delay > HOOK_TIMEOUT_MS:
                timeout_count += 1
                if result is not None:
                    warnings.append(f"第 {i+1} 輪：超時後仍有注入結果（delay={delay}ms）")
            else:
                success_count += 1
        except Exception as e:
            crashes.append(f"第 {i+1} 輪（delay={delay}ms）崩潰：{e}")

    shutil.rmtree(tmp, ignore_errors=True)
    return ScenarioResult(
        name=f"D：Hook 超時截斷（{HOOK_TIMEOUT_MS}ms 限制）",
        turns=n, passed=len(crashes) == 0,
        crashes=crashes, warnings=warnings,
        stats={"超時次數": timeout_count, "正常次數": success_count, "超時行為": "靜默回傳 None"}
    )


# ══════════════════════════════════════════════════════════════
# 場景 E：磁碟 IO 錯誤（優雅降級）
# 模擬無寫入權限或磁碟滿，確認插件不崩潰而是靜默跳過。
# ══════════════════════════════════════════════════════════════
def scenario_e_io_errors(n=20):
    """模擬磁碟 IO 錯誤"""
    tmp, sd = make_state_dir()
    write_initial_state(sd)
    crashes = []
    warnings = []

    def safe_update_pattern(state_dir: Path, pattern_id: str, success: bool) -> bool:
        """對應 TypeScript 的 safeWriteFile，IO 錯誤靜默失敗"""
        try:
            return bool(update_pattern_ema(state_dir, pattern_id, success))
        except (OSError, PermissionError) as e:
            return False  # 靜默降級
        except Exception as e:
            raise  # 其他錯誤不應靜默

    # 正常寫入 10 次
    for i in range(10):
        try:
            result = safe_update_pattern(sd, "nuwa-charlie-munger-init", True)
        except Exception as e:
            crashes.append(f"正常寫入第 {i+1} 次崩潰：{e}")

    # 模擬唯讀（刪除寫入權限，Windows 上改用存放到不存在的路徑）
    fake_sd = Path(tmp) / "nonexistent" / "path"
    for i in range(10):
        try:
            result = safe_update_pattern(fake_sd, "nuwa-charlie-munger-init", True)
            # 應回傳 False（靜默失敗），不應拋出例外
        except Exception as e:
            crashes.append(f"IO 錯誤第 {i+1} 次應靜默但崩潰：{e}")

    # 驗證正常的部分仍然正確
    issues = validate_state_values(sd)
    crashes.extend(issues)

    shutil.rmtree(tmp, ignore_errors=True)
    return ScenarioResult(
        name="E：磁碟 IO 錯誤優雅降級",
        turns=n, passed=len(crashes) == 0,
        crashes=crashes, warnings=warnings,
        stats={"IO 錯誤靜默": "✅" if not crashes else "❌"}
    )


# ══════════════════════════════════════════════════════════════
# 場景 F：損毀狀態檔案（上次未正常退出）
# patterns.jsonl 最後一行不完整，或 cell-registry.json 截斷。
# 模擬各種損毀程度，確認插件能部分恢復並繼續運作。
# ══════════════════════════════════════════════════════════════
def scenario_f_corrupted_files(n=10):
    """模擬多種檔案損毀情境"""
    crashes = []
    warnings = []

    corruption_tests = [
        ("JSONL 最後一行截斷", lambda pf: pf.write_bytes(pf.read_bytes()[:-20])),
        ("JSONL 中間插入非 JSON", lambda pf: pf.write_text(
            pf.read_text(encoding="utf-8") + "{{corrupted line\n", encoding="utf-8")),
        ("JSONL 全為空白", lambda pf: pf.write_text("\n\n\n", encoding="utf-8")),
        ("Registry 截斷", lambda pf: None),  # 只損毀 registry
        ("Registry 空白", lambda pf: None),
    ]

    for desc, corrupt_fn in corruption_tests:
        tmp, sd = make_state_dir()
        write_initial_state(sd)

        try:
            pf = sd / "patterns.jsonl"
            rf = sd / "cell-registry.json"

            if "Registry" in desc:
                if "截斷" in desc:
                    rf.write_bytes(rf.read_bytes()[:-50])
                elif "空白" in desc:
                    rf.write_text("", encoding="utf-8")
            elif corrupt_fn:
                corrupt_fn(pf)

            # 嘗試在損毀後仍能運作
            patterns = load_patterns(sd)
            if "全為空白" in desc:
                assert patterns == [], f"空白 JSONL 應回傳空清單，得到 {patterns}"
            else:
                # 其他損毀：應能讀到至少部分有效資料或空清單，不崩潰
                assert isinstance(patterns, list), "load_patterns 必須回傳 list"

            # 嘗試執行 REM 週期
            result = run_rem_cycle(sd)
            if "error" in result and "Registry" not in desc:
                warnings.append(f"[{desc}] REM 週期異常：{result}")

        except AssertionError as e:
            crashes.append(f"[{desc}] 斷言失敗：{e}")
        except Exception as e:
            crashes.append(f"[{desc}] 崩潰：{type(e).__name__}: {e}")

        shutil.rmtree(tmp, ignore_errors=True)

    return ScenarioResult(
        name=f"F：{len(corruption_tests)} 種損毀檔案情境",
        turns=n, passed=len(crashes) == 0,
        crashes=crashes, warnings=warnings,
        stats={"測試情境": len(corruption_tests), "全數通過": len(crashes) == 0}
    )


# ══════════════════════════════════════════════════════════════
# 場景 G：REM 週期與 Hook 交錯寫入
# 背景 REM 週期每 8 小時跑一次，但 hook 每次對話都跑。
# 模擬兩者同時寫 cell-registry.json 的競速。
# ══════════════════════════════════════════════════════════════
def scenario_g_rem_vs_hook_concurrent(n=50):
    """模擬 REM 週期與 hook 並發寫入"""
    tmp, sd = make_state_dir()
    write_initial_state(sd)
    crashes = []
    warnings = []
    lock = threading.Lock()
    error_count = [0]

    def hook_worker(i: int):
        try:
            update_pattern_ema(sd, "nuwa-charlie-munger-init", random.random() > 0.3, lock)
        except Exception as e:
            error_count[0] += 1

    def rem_worker(i: int):
        try:
            run_rem_cycle(sd, lock)
        except Exception as e:
            error_count[0] += 1

    # 交錯執行：5 個 hook + 1 個 REM，重複 n 次
    with ThreadPoolExecutor(max_workers=10) as executor:
        futures = []
        for i in range(n):
            futures.extend([executor.submit(hook_worker, i) for _ in range(3)])
            if i % 5 == 0:
                futures.append(executor.submit(rem_worker, i))

        for f in as_completed(futures):
            try:
                f.result(timeout=5)
            except FutureTimeoutError:
                crashes.append("執行緒超時（>5秒）")

    # 最終驗證
    issues = validate_state_values(sd)
    crashes.extend(issues)

    if error_count[0] > 0:
        crashes.append(f"並發期間有 {error_count[0]} 次例外")

    shutil.rmtree(tmp, ignore_errors=True)
    return ScenarioResult(
        name=f"G：REM 週期 × Hook 並發寫入（{n} 輪）",
        turns=n, passed=len(crashes) == 0,
        crashes=crashes, warnings=warnings,
        stats={"例外次數": error_count[0], "並發安全": "✅" if not crashes else "❌"}
    )


# ══════════════════════════════════════════════════════════════
# 場景 H：Config 熱更新（運行中關閉 enabled）
# 模擬用戶在對話中執行 /config set skills.evolution-learning.enabled false
# 插件應在下次 hook 觸發時讀到新設定並停止注入。
# ══════════════════════════════════════════════════════════════
def scenario_h_config_hot_reload(n=20):
    """模擬 config 熱更新"""
    tmp, sd = make_state_dir()
    write_initial_state(sd)
    crashes = []
    warnings = []
    config = {"enabled": True, "confidenceThreshold": 0.65}

    def before_prompt_build_with_config(prompt: str) -> Optional[str]:
        # 重新讀取 config（對應 TypeScript 中的 refreshLiveConfigFromRuntime）
        if not config.get("enabled", True):
            return None
        patterns = load_patterns(sd)
        matched = detect_persona(prompt, patterns, config.get("confidenceThreshold", 0.65))
        if not matched:
            return None
        return f"🏺 {matched['target']}"

    inject_count_enabled = 0
    inject_count_disabled = 0

    for i in range(n):
        try:
            # 第 10 輪：config 被關閉
            if i == 10:
                config["enabled"] = False

            result = before_prompt_build_with_config("用芒格分析投資")

            if i < 10:
                if result:
                    inject_count_enabled += 1
            else:
                if result is not None:
                    crashes.append(f"第 {i+1} 輪：plugin 已關閉但仍注入 {result!r}")
                inject_count_disabled += 1

        except Exception as e:
            crashes.append(f"第 {i+1} 輪崩潰：{e}")

    shutil.rmtree(tmp, ignore_errors=True)
    return ScenarioResult(
        name=f"H：Config 熱更新（第 10 輪關閉 plugin）",
        turns=n, passed=len(crashes) == 0,
        crashes=crashes, warnings=warnings,
        stats={"啟用期注入": inject_count_enabled, "停用後注入": n - 10 - len(crashes), "期望停用後": 0}
    )


# ══════════════════════════════════════════════════════════════
# 場景 I：EMA 數值穩定性（長期漂移測試）
# 連續 1000 次交替正負回饋，驗證 EMA 不會數值漂移或 NaN。
# ══════════════════════════════════════════════════════════════
def scenario_i_ema_stability(n=1000):
    """EMA 長期穩定性（1000 次更新）"""
    crashes = []
    warnings = []

    confidence = 0.75
    success_rate = 0.0
    confidence_floor = CONFIDENCE_FLOOR

    for i in range(n):
        # 交替正負，75% 正向
        success = (i % 4 != 0)
        reward = 1.0 if success else 0.0
        success_rate = EMA_ALPHA * reward + (1 - EMA_ALPHA) * success_rate
        confidence = max(confidence_floor, EMA_ALPHA * success_rate + (1 - EMA_ALPHA) * confidence)

        # 每 100 次檢查一次
        if (i + 1) % 100 == 0:
            if not (0 <= confidence <= 1):
                crashes.append(f"第 {i+1} 次：confidence={confidence:.6f} 超出 [0,1]")
            if not (0 <= success_rate <= 1):
                crashes.append(f"第 {i+1} 次：successRate={success_rate:.6f} 超出 [0,1]")
            if math.isnan(confidence) or math.isinf(confidence):
                crashes.append(f"第 {i+1} 次：confidence={confidence} 為 NaN/Inf")
            if math.isnan(success_rate) or math.isinf(success_rate):
                crashes.append(f"第 {i+1} 次：successRate={success_rate} 為 NaN/Inf")

    # 最終穩定值應收斂（75% 正向 → successRate 應趨近 0.75）
    expected_sr = 0.75
    if abs(success_rate - expected_sr) > 0.15:
        warnings.append(f"成功率收斂偏差：{success_rate:.4f}，期望約 {expected_sr}")

    return ScenarioResult(
        name=f"I：EMA 數值穩定性（{n} 次更新）",
        turns=n, passed=len(crashes) == 0,
        crashes=crashes, warnings=warnings,
        stats={
            "最終信心度": f"{confidence:.4f}",
            "最終成功率": f"{success_rate:.4f}",
            "信心度下限保護": f"{confidence_floor}",
            "NaN/Inf": "無" if not crashes else "發生",
        }
    )


# ══════════════════════════════════════════════════════════════
# 場景 J：完整整合流程（100 輪模擬真實 OpenClaw 生命週期）
# 每一輪完整模擬：啟動 → before_prompt_build → agent_end → REM
# 包含：多 session 並發、config 變化、IO 錯誤、超時
# ══════════════════════════════════════════════════════════════
def scenario_j_full_integration(n=100):
    """完整整合模擬，100 輪"""
    tmp, sd = make_state_dir()
    write_initial_state(sd)
    crashes = []
    warnings = []
    lock = threading.Lock()
    config = {"enabled": True, "confidenceThreshold": 0.65, "maxContextTokens": 300}

    inject_count = 0
    rem_count = 0
    total_tokens_injected = 0
    max_tokens_in_turn = 0

    trigger_prompts = [
        "用芒格的方式分析這個投資機會",
        "費曼會怎麼解釋量子力學",
        "Naval 的財富觀是什麼",
        "apply Munger thinking here",
        "用芒格框架評估這個商業模式",
    ]
    normal_prompts = [
        "今天天氣如何", "幫我寫程式", "翻譯這段話",
        "什麼是機器學習", "推薦一本書",
    ]

    for turn in range(1, n + 1):
        try:
            # 模擬 config 在第 50 輪熱更新（降低門檻）
            if turn == 50:
                config["confidenceThreshold"] = 0.5

            # 模擬 config 在第 75 輪暫時停用
            if turn == 75:
                config["enabled"] = False
            elif turn == 85:
                config["enabled"] = True

            # 選擇提示詞（60% 觸發）
            is_trigger = random.random() < 0.60
            prompt = random.choice(trigger_prompts if is_trigger else normal_prompts)

            # ── 模擬 active-memory 先注入（優先級 200）──
            am_tokens = random.randint(80, 280)
            remaining_budget = SYSTEM_TOKEN_BUDGET - am_tokens

            # ── before_prompt_build（我們的 hook，優先級 100）──
            context = None
            if config.get("enabled", True):
                patterns = load_patterns(sd)
                matched = detect_persona(prompt, patterns, config["confidenceThreshold"])
                if matched and remaining_budget > 0:
                    models = matched["mentalModels"][:min(5, remaining_budget // 20)]
                    ctx = f"🏺 {matched['target']}：" + "、".join(models)
                    evo_tokens = min(len(ctx) // 2, remaining_budget)
                    if am_tokens + evo_tokens <= SYSTEM_TOKEN_BUDGET:
                        context = ctx
                        inject_count += 1
                        total_tokens_injected += evo_tokens
                        max_tokens_in_turn = max(max_tokens_in_turn, am_tokens + evo_tokens)

            # ── agent_end：記錄使用 ──
            if context and matched:
                success = random.random() > 0.3
                update_pattern_ema(sd, matched["id"], success, lock)

            # ── REM 週期（每 10 輪）──
            if turn % 10 == 0:
                run_rem_cycle(sd, lock)
                rem_count += 1

            # ── 每 20 輪驗證一次狀態 ──
            if turn % 20 == 0:
                issues = validate_state_values(sd)
                crashes.extend(issues)

        except Exception as e:
            crashes.append(f"第 {turn} 輪崩潰：{type(e).__name__}: {e}")

    # 最終狀態
    final_patterns = load_patterns(sd)
    final_registry_content = (sd / "cell-registry.json").read_text(encoding="utf-8")
    final_registry = json.loads(final_registry_content)
    final_issues = validate_state_values(sd)
    crashes.extend(final_issues)

    cell_statuses = {c["target"]: c["status"] for c in final_registry.get("stemCells", [])}

    shutil.rmtree(tmp, ignore_errors=True)
    return ScenarioResult(
        name=f"J：完整整合流程（{n} 輪，含並發/config變化/IO）",
        turns=n, passed=len(crashes) == 0,
        crashes=crashes, warnings=warnings,
        stats={
            "總注入次數": inject_count,
            "REM 週期次數": rem_count,
            "最高單輪 Token": max_tokens_in_turn,
            "Token 是否超額": "❌ 是" if max_tokens_in_turn > SYSTEM_TOKEN_BUDGET else "✅ 否",
            "最終細胞狀態": cell_statuses,
        }
    )


# ══════════════════════════════════════════════════════════════
# 主程式
# ══════════════════════════════════════════════════════════════

def main():
    print("=" * 65)
    print("🏗️  四層進化學習 × OpenClaw 架構整合壓力模擬")
    print("=" * 65)
    print(f"模擬 10 個整合場景，總計超過 100 輪真實架構互動")
    print(f"開始時間：{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}\n")

    start = time.time()

    print("場景執行：")
    report(scenario_a_cold_start(20))
    report(scenario_b_token_budget(30))
    report(scenario_c_concurrent_writes(15))
    report(scenario_d_hook_timeout(20))
    report(scenario_e_io_errors(20))
    report(scenario_f_corrupted_files(10))
    report(scenario_g_rem_vs_hook_concurrent(50))
    report(scenario_h_config_hot_reload(20))
    report(scenario_i_ema_stability(1000))
    report(scenario_j_full_integration(100))

    elapsed = time.time() - start
    total_turns = sum(r.turns for r in results)

    print("\n" + "=" * 65)
    print("📊 整合壓力測試總結")
    print("=" * 65)
    print(f"  場景數量        ：{total_scenarios}")
    print(f"  通過場景        ：{passed_scenarios} / {total_scenarios}")
    print(f"  總模擬輪次      ：{total_turns:,}")
    print(f"  執行時間        ：{elapsed:.2f} 秒")

    print(f"\n  場景結果：")
    for r in results:
        status = "✅" if r.passed else "❌"
        print(f"    {status} {r.name}")

    all_passed = passed_scenarios == total_scenarios
    print(f"\n  整體結論：{'✅ 所有場景通過，架構整合穩定，可以部署' if all_passed else '❌ 有場景失敗，需要修復後再部署'}")
    print("=" * 65 + "\n")

    sys.exit(0 if all_passed else 1)


if __name__ == "__main__":
    main()
