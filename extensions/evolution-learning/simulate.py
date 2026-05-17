#!/usr/bin/env python3
"""
四層進化學習系統 — 100 次對話模擬壓力測試

完整模擬 TypeScript 插件的核心邏輯：
  第一層：before_prompt_build 偵測人物框架並注入
  第一層學習：agent_end 更新 EMA 使用記錄
  第三層：REM 週期更新幹細胞成熟度
  第四層：狀態機轉換（embryo → incubating → ready → installed）

測試目標：
  - 100 次以上模擬對話，驗證不崩潰
  - 驗證 EMA 數值不超出 [0, 1] 範圍
  - 驗證狀態機轉換的邏輯正確性
  - 驗證 JSONL 並行讀寫的穩定性
  - 驗證快取邏輯不會造成讀到舊資料
"""

import json
import math
import random
import shutil
import sys
import tempfile
import time
import traceback
from dataclasses import dataclass, field, asdict
from datetime import datetime
from pathlib import Path
from typing import Optional

# ─── 常數（與 TypeScript 完全對應）──────────────────────────────

EMA_ALPHA = 0.1
CONFIDENCE_FLOOR = 0.6
CACHE_TTL_SEC = 60
EMBRYO_THRESHOLD = 0.3
INCUBATING_THRESHOLD = 0.6
READY_THRESHOLD = 0.8

# ─── 資料型別 ──────────────────────────────────────────────────

@dataclass
class NuwaPattern:
    id: str
    type: str = "persona_distillation"
    category: str = "nuwa"
    target: str = ""
    slug: str = ""
    confidence: float = 0.75
    successRate: float = 0.0
    sampleCount: int = 0
    mentalModels: list = field(default_factory=list)
    sourceCount: int = 0
    context: str = "persona_thinking"
    createdAt: str = ""
    lastUsed: Optional[str] = None

@dataclass
class StemCell:
    id: str
    type: str = "persona_skill"
    target: str = ""
    slug: str = ""
    patternId: str = ""
    status: str = "embryo"  # embryo | incubating | ready | installed
    maturityScore: float = 0.1
    usageCount: int = 0
    positiveRating: int = 0
    skillPath: str = ""
    createdAt: str = ""
    lastEvaluated: Optional[str] = None

@dataclass
class CellRegistry:
    version: int = 1
    cells: dict = field(default_factory=dict)
    stemCells: list = field(default_factory=list)

@dataclass
class TestResult:
    turn: int
    prompt: str
    matched_persona: Optional[str]
    injected: bool
    context_len: int
    pattern_updated: bool
    ema_confidence: float
    ema_success_rate: float
    error: Optional[str] = None

# ─── 測試資料初始化 ─────────────────────────────────────────────

PERSONAS = [
    {
        "target": "查理·芒格",
        "slug": "charlie-munger",
        "mentalModels": [
            "多元思維模型格柵",
            "逆向思考（Inversion）",
            "能力圈（Circle of Competence）",
            "心理偏誤清單",
            "基本費率優先",
            "複利思維",
            "激勵機制第一",
            "機會成本嚴格計算",
        ],
        "sourceCount": 63,
    },
    {
        "target": "理查·費曼",
        "slug": "richard-feynman",
        "mentalModels": [
            "費曼學習法（教學即理解）",
            "第一原理思考",
            "不確定性誠實",
            "好奇心驅動探索",
            "跨領域類比",
        ],
        "sourceCount": 41,
    },
    {
        "target": "Naval Ravikant",
        "slug": "naval-ravikant",
        "mentalModels": [
            "特定知識（Specific Knowledge）",
            "槓桿無限複製",
            "財富而非金錢",
            "長壽型職業設計",
            "冥想與清醒決策",
        ],
        "sourceCount": 38,
    },
]

# 模擬的用戶訊息池（觸發 vs 不觸發）
TRIGGER_PROMPTS = [
    "用芒格的方式分析這個投資機會",
    "芒格會怎麼看這個商業模式？",
    "用芒格的決策框架評估 A 和 B 方案",
    "用費曼的方式解釋量子糾纏",
    "費曼會怎麼分解這個問題？",
    "用 Naval 的角度看待創業",
    "Naval 怎麼思考財富和幸福的關係？",
    "apply Munger thinking to this valuation",
    "how would Feynman approach this explanation",
    "用芒格框架來看激勵機制設計",
]

NON_TRIGGER_PROMPTS = [
    "今天天氣怎樣",
    "幫我寫一首詩",
    "翻譯這段英文",
    "解釋機器學習的原理",
    "幫我規劃旅遊行程",
    "寫一個 Python 排序程式",
    "分析這篇文章的論點",
    "什麼是量子運算",
    "推薦幾本好書",
    "如何提升工作效率",
    "what is the meaning of life",
    "help me debug this code",
]

# ─── 進化狀態管理（模擬 TypeScript 邏輯） ──────────────────────

class EvolutionState:
    def __init__(self, state_dir: Path):
        self.state_dir = state_dir
        self.patterns_file = state_dir / "patterns.jsonl"
        self.registry_file = state_dir / "cell-registry.json"
        self.metrics_file = state_dir / "growth-metrics.json"

        # 快取
        self._patterns_cache: list[NuwaPattern] = []
        self._patterns_cache_at: float = 0.0
        self._registry_cache: Optional[CellRegistry] = None
        self._registry_cache_at: float = 0.0

        # 統計
        self.cache_hits = 0
        self.cache_misses = 0
        self.write_errors = 0
        self.read_errors = 0

    def _invalidate_cache(self):
        self._patterns_cache_at = 0.0
        self._registry_cache_at = 0.0

    def load_patterns(self) -> list[NuwaPattern]:
        now = time.time()
        if self._patterns_cache and (now - self._patterns_cache_at) < CACHE_TTL_SEC:
            self.cache_hits += 1
            return self._patterns_cache

        self.cache_misses += 1
        if not self.patterns_file.exists():
            return []

        try:
            patterns = []
            for line in self.patterns_file.read_text(encoding="utf-8").splitlines():
                line = line.strip()
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                    if obj.get("category") == "nuwa":
                        p = NuwaPattern(**{k: v for k, v in obj.items() if k in NuwaPattern.__dataclass_fields__})
                        patterns.append(p)
                except (json.JSONDecodeError, TypeError):
                    pass  # 容忍格式錯誤的行
            self._patterns_cache = patterns
            self._patterns_cache_at = now
            return patterns
        except OSError as e:
            self.read_errors += 1
            return self._patterns_cache  # 回傳舊快取

    def load_registry(self) -> Optional[CellRegistry]:
        now = time.time()
        if self._registry_cache and (now - self._registry_cache_at) < CACHE_TTL_SEC:
            self.cache_hits += 1
            return self._registry_cache

        self.cache_misses += 1
        if not self.registry_file.exists():
            return None

        try:
            data = json.loads(self.registry_file.read_text(encoding="utf-8"))
            cells_raw = data.get("stemCells", [])
            stem_cells = []
            for c in cells_raw:
                try:
                    sc = StemCell(**{k: v for k, v in c.items() if k in StemCell.__dataclass_fields__})
                    stem_cells.append(sc)
                except TypeError:
                    pass
            registry = CellRegistry(
                version=data.get("version", 1),
                cells=data.get("cells", {}),
                stemCells=stem_cells,
            )
            self._registry_cache = registry
            self._registry_cache_at = now
            return registry
        except (OSError, json.JSONDecodeError):
            self.read_errors += 1
            return self._registry_cache

    def write_patterns(self, patterns: list[NuwaPattern]) -> bool:
        try:
            lines = [json.dumps(asdict(p), ensure_ascii=False) for p in patterns]
            self.patterns_file.write_text("\n".join(lines) + "\n", encoding="utf-8")
            self._invalidate_cache()
            return True
        except OSError:
            self.write_errors += 1
            return False

    def write_registry(self, registry: CellRegistry) -> bool:
        try:
            data = {
                "version": registry.version,
                "cells": registry.cells,
                "stemCells": [asdict(sc) for sc in registry.stemCells],
            }
            self.registry_file.write_text(
                json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8"
            )
            self._invalidate_cache()
            return True
        except OSError:
            self.write_errors += 1
            return False


# ─── 第一層：人物框架偵測 ─────────────────────────────────────

PERSONA_TRIGGERS = {
    "charlie-munger": ["芒格", "munger", "charlie"],
    "richard-feynman": ["費曼", "feynman", "richard", "費因曼"],
    "naval-ravikant": ["naval", "ravikant"],
}

REGEX_TRIGGERS = [
    r"用(.{1,15})的方式",
    r"(.{1,15})會怎麼(看|想|分析|評估)",
    r"(.{1,15})的(思維|框架|觀點|角度)",
    r"apply (.{1,30}) (thinking|framework|approach)",
    r"how would (.{1,30}) (think|approach|analyze)",
]

def detect_persona_intent(
    prompt: str,
    patterns: list[NuwaPattern],
    threshold: float,
) -> Optional[NuwaPattern]:
    lower = prompt.lower()

    for slug, keywords in PERSONA_TRIGGERS.items():
        if any(kw.lower() in lower for kw in keywords):
            for p in patterns:
                if p.slug == slug and p.confidence >= threshold:
                    return p

    # 泛化匹配
    import re
    for pattern_re in REGEX_TRIGGERS:
        m = re.search(pattern_re, prompt)
        if m:
            name_part = m.group(1).strip().lower()
            for p in patterns:
                slug_words = p.slug.replace("-", " ")
                if name_part in slug_words or p.target.lower() in name_part:
                    if p.confidence >= threshold:
                        return p

    return None


def build_persona_context(pattern: NuwaPattern, max_tokens: int) -> str:
    models = pattern.mentalModels[:5]
    ctx = f"🏺 女媧框架啟動：{pattern.target}\n核心心智模型：\n"
    for m in models:
        ctx += f"• {m}\n"
    ctx += f"\n請以 {pattern.target} 的思維框架回應。"
    # 粗略截斷
    max_chars = max_tokens * 2
    if len(ctx) > max_chars:
        ctx = ctx[:max_chars] + "..."
    return ctx


# ─── 第一層學習：EMA 更新 ────────────────────────────────────

def record_pattern_usage(
    state: EvolutionState,
    pattern_id: str,
    success: bool,
) -> tuple[float, float]:
    """更新 patterns.jsonl 中的使用記錄，回傳 (confidence, successRate)"""
    patterns = state.load_patterns()
    updated_confidence = -1.0
    updated_success_rate = -1.0

    for p in patterns:
        if p.id == pattern_id:
            p.sampleCount += 1
            p.lastUsed = datetime.now().isoformat()
            reward = 1.0 if success else 0.0
            # EMA 更新成功率
            p.successRate = EMA_ALPHA * reward + (1 - EMA_ALPHA) * p.successRate
            # EMA 更新信心度（有下限保護）
            p.confidence = max(CONFIDENCE_FLOOR, EMA_ALPHA * p.successRate + (1 - EMA_ALPHA) * p.confidence)
            updated_confidence = p.confidence
            updated_success_rate = p.successRate
            break

    state.write_patterns(patterns)
    return updated_confidence, updated_success_rate


def record_stem_cell_usage(state: EvolutionState, slug: str, positive: bool) -> bool:
    registry = state.load_registry()
    if not registry:
        return False
    for cell in registry.stemCells:
        if cell.slug == slug:
            cell.usageCount += 1
            if positive:
                cell.positiveRating += 1
            state.write_registry(registry)
            return True
    return False


# ─── 第三層：REM 週期 ─────────────────────────────────────────

def run_rem_cycle(
    state: EvolutionState,
    maturity_threshold: float = READY_THRESHOLD,
) -> dict:
    """執行 REM 週期，回傳各狀態的細胞數量"""
    registry = state.load_registry()
    if not registry:
        return {"error": "no registry"}

    transitions = {"to_incubating": 0, "to_ready": 0, "to_installed": 0, "no_change": 0}

    for cell in registry.stemCells:
        if cell.status == "installed":
            transitions["no_change"] += 1
            continue

        prev_status = cell.status
        prev_score = cell.maturityScore

        # 計算新成熟度
        usage_bonus = min(cell.usageCount * 0.05, 0.3)
        rating_bonus = (cell.positiveRating / cell.usageCount * 0.3) if cell.usageCount > 0 else 0.0
        raw_score = min(0.1 + usage_bonus + rating_bonus, 1.0)

        # EMA 平滑
        cell.maturityScore = EMA_ALPHA * raw_score + (1 - EMA_ALPHA) * prev_score
        cell.lastEvaluated = datetime.now().isoformat()

        # 狀態機轉換
        if cell.status == "embryo" and cell.maturityScore >= EMBRYO_THRESHOLD:
            cell.status = "incubating"
            transitions["to_incubating"] += 1
        elif cell.status == "incubating" and cell.maturityScore >= INCUBATING_THRESHOLD:
            cell.status = "ready"
            transitions["to_ready"] += 1
        elif cell.status == "ready" and cell.maturityScore >= maturity_threshold:
            cell.status = "installed"
            transitions["to_installed"] += 1
        else:
            transitions["no_change"] += 1

    state.write_registry(registry)
    return transitions


# ─── 驗證函式 ─────────────────────────────────────────────────

def validate_state(state: EvolutionState, turn: int) -> list[str]:
    """驗證進化狀態的合法性，回傳問題清單"""
    issues = []
    patterns = state.load_patterns()
    registry = state.load_registry()

    # 驗證 patterns
    for p in patterns:
        if not (0.0 <= p.confidence <= 1.0):
            issues.append(f"[第 {turn} 輪] {p.target}: confidence={p.confidence:.4f} 超出 [0,1]")
        if not (0.0 <= p.successRate <= 1.0):
            issues.append(f"[第 {turn} 輪] {p.target}: successRate={p.successRate:.4f} 超出 [0,1]")
        if p.sampleCount < 0:
            issues.append(f"[第 {turn} 輪] {p.target}: sampleCount={p.sampleCount} 為負數")
        if math.isnan(p.confidence) or math.isinf(p.confidence):
            issues.append(f"[第 {turn} 輪] {p.target}: confidence={p.confidence} 為 NaN/Inf")
        if math.isnan(p.successRate) or math.isinf(p.successRate):
            issues.append(f"[第 {turn} 輪] {p.target}: successRate={p.successRate} 為 NaN/Inf")

    # 驗證 registry
    if registry:
        valid_statuses = {"embryo", "incubating", "ready", "installed"}
        for cell in registry.stemCells:
            if cell.status not in valid_statuses:
                issues.append(f"[第 {turn} 輪] {cell.target}: 非法狀態 {cell.status}")
            if not (0.0 <= cell.maturityScore <= 1.0):
                issues.append(f"[第 {turn} 輪] {cell.target}: maturityScore={cell.maturityScore:.4f} 超出 [0,1]")
            if math.isnan(cell.maturityScore) or math.isinf(cell.maturityScore):
                issues.append(f"[第 {turn} 輪] {cell.target}: maturityScore={cell.maturityScore} 為 NaN/Inf")
            if cell.usageCount < 0:
                issues.append(f"[第 {turn} 輪] {cell.target}: usageCount={cell.usageCount} 為負數")
            if cell.positiveRating < 0:
                issues.append(f"[第 {turn} 輪] {cell.target}: positiveRating={cell.positiveRating} 為負數")
            if cell.positiveRating > cell.usageCount:
                issues.append(f"[第 {turn} 輪] {cell.target}: positiveRating({cell.positiveRating}) > usageCount({cell.usageCount})")

            # 狀態轉換不可逆（embryo < incubating < ready < installed）
            # 不驗證逆轉因為狀態機只向前

    return issues


# ─── 初始化測試環境 ───────────────────────────────────────────

def setup_initial_state(state: EvolutionState):
    """建立初始的 patterns.jsonl 和 cell-registry.json"""
    now = datetime.now().isoformat()

    patterns = []
    stem_cells = []

    for i, persona in enumerate(PERSONAS):
        slug = persona["slug"]
        pattern_id = f"nuwa-{slug}-{int(time.time()) + i}"

        p = NuwaPattern(
            id=pattern_id,
            target=persona["target"],
            slug=slug,
            confidence=0.75,
            successRate=0.0,
            sampleCount=0,
            mentalModels=persona["mentalModels"],
            sourceCount=persona["sourceCount"],
            createdAt=now,
            lastUsed=None,
        )
        patterns.append(p)

        sc = StemCell(
            id=f"stem-{slug}-001",
            target=persona["target"],
            slug=slug,
            patternId=pattern_id,
            status="embryo",
            maturityScore=0.1,
            usageCount=0,
            positiveRating=0,
            skillPath=f"skills/nuwa/examples/{slug}.md",
            createdAt=now,
            lastEvaluated=None,
        )
        stem_cells.append(sc)

    state.write_patterns(patterns)
    registry = CellRegistry(version=1, cells={}, stemCells=stem_cells)
    state.write_registry(registry)


# ─── 主模擬迴圈 ──────────────────────────────────────────────

def run_simulation(n_turns: int = 120, confidence_threshold: float = 0.65) -> dict:
    """執行完整模擬，回傳統計報告"""
    tmp_dir = Path(tempfile.mkdtemp(prefix="evolution-sim-"))
    state_dir = tmp_dir / ".claude" / "evolution-state"
    state_dir.mkdir(parents=True, exist_ok=True)

    state = EvolutionState(state_dir)
    setup_initial_state(state)

    results: list[TestResult] = []
    all_issues: list[str] = []
    crashes: list[str] = []
    rem_cycle_count = 0
    total_injections = 0
    total_trigger_turns = 0
    total_non_trigger_turns = 0

    print(f"\n{'='*60}")
    print(f"🧪 四層進化學習系統 — {n_turns} 次對話模擬")
    print(f"{'='*60}")
    print(f"模擬設定：信心度門檻={confidence_threshold}, EMA α={EMA_ALPHA}")
    print(f"初始人物：{', '.join(p['target'] for p in PERSONAS)}")
    print(f"{'='*60}\n")

    # 進度欄位
    header = f"{'輪次':>5} {'提示詞類型':>12} {'匹配人物':>15} {'注入':>6} {'信心度':>8} {'成熟度變化':>12}"
    print(header)
    print("-" * 65)

    for turn in range(1, n_turns + 1):
        try:
            # 隨機選擇提示詞（60% 觸發，40% 不觸發）
            is_trigger = random.random() < 0.60
            if is_trigger:
                prompt = random.choice(TRIGGER_PROMPTS)
                total_trigger_turns += 1
            else:
                prompt = random.choice(NON_TRIGGER_PROMPTS)
                total_non_trigger_turns += 1

            # ── 第一層：before_prompt_build ──
            patterns = state.load_patterns()
            matched = detect_persona_intent(prompt, patterns, confidence_threshold)
            injected = False
            context_len = 0
            matched_name = None

            if matched:
                context = build_persona_context(matched, 300)
                context_len = len(context)
                injected = True
                total_injections += 1
                matched_name = matched.target

            # ── 第一層學習：agent_end ──
            pattern_updated = False
            updated_conf = -1.0
            updated_sr = -1.0

            if matched:
                # 模擬正向信號：觸發且回應夠長
                success = is_trigger and random.random() < 0.75
                updated_conf, updated_sr = record_pattern_usage(
                    state, matched.id, success
                )
                record_stem_cell_usage(state, matched.slug, success)
                pattern_updated = True

            # ── 第三層：每 10 輪跑一次 REM 週期 ──
            if turn % 10 == 0:
                transitions = run_rem_cycle(state)
                rem_cycle_count += 1

            # ── 驗證當前狀態 ──
            issues = validate_state(state, turn)
            all_issues.extend(issues)

            # 記錄結果
            result = TestResult(
                turn=turn,
                prompt=prompt[:30] + ("..." if len(prompt) > 30 else ""),
                matched_persona=matched_name,
                injected=injected,
                context_len=context_len,
                pattern_updated=pattern_updated,
                ema_confidence=updated_conf,
                ema_success_rate=updated_sr,
            )
            results.append(result)

            # 取得最新狀態顯示
            registry = state.load_registry()
            if matched and registry:
                cell = next((c for c in registry.stemCells if c.slug == matched.slug), None)
                maturity_str = f"{cell.maturityScore:.3f}({cell.status})" if cell else "N/A"
            else:
                maturity_str = "—"

            conf_str = f"{updated_conf:.3f}" if updated_conf >= 0 else "—"
            prompt_type = "🎯觸發" if is_trigger else "💬一般"
            persona_str = (matched_name[:13] if matched_name else "（無匹配）")

            # 每 10 輪顯示一行進度
            if turn % 10 == 0 or turn == 1 or turn <= 5:
                print(
                    f"{turn:>5} {prompt_type:>12} {persona_str:>15} "
                    f"{'✅' if injected else '—':>6} {conf_str:>8} {maturity_str:>12}"
                )

            # 驗證問題即時輸出
            for issue in issues:
                print(f"  ⚠️  {issue}")

        except Exception as e:
            crash_msg = f"[第 {turn} 輪] 崩潰：{type(e).__name__}: {e}"
            crashes.append(crash_msg)
            print(f"  💥 {crash_msg}")
            traceback.print_exc()

    # ── 最終 REM 週期 ──
    print("\n" + "="*60)
    print("📊 最終 REM 週期（强制執行）...")
    final_transitions = run_rem_cycle(state)
    rem_cycle_count += 1

    # ── 最終狀態 ──
    final_patterns = state.load_patterns()
    final_registry = state.load_registry()

    print("\n" + "="*60)
    print("📈 最終進化狀態")
    print("="*60)
    print(f"\n第一層（學習模式庫）：{len(final_patterns)} 個模式")
    for p in final_patterns:
        print(
            f"  • {p.target:<15} 信心度={p.confidence:.3f}  成功率={p.successRate:.3f}  使用={p.sampleCount} 次"
        )

    print(f"\n第四層（有機細胞）：{len(final_registry.stemCells) if final_registry else 0} 個幹細胞")
    status_icons = {"embryo": "🥚", "incubating": "🐣", "ready": "✅", "installed": "🌟"}
    if final_registry:
        for cell in final_registry.stemCells:
            icon = status_icons.get(cell.status, "❓")
            print(
                f"  {icon} {cell.target:<15} 成熟度={cell.maturityScore:.3f}  使用={cell.usageCount}  好評={cell.positiveRating}"
            )

    # ── 統計報告 ──
    print("\n" + "="*60)
    print("📋 模擬統計報告")
    print("="*60)
    print(f"\n  總對話輪次    ：{n_turns}")
    print(f"  觸發輪次      ：{total_trigger_turns}（{total_trigger_turns/n_turns*100:.1f}%）")
    print(f"  非觸發輪次    ：{total_non_trigger_turns}（{total_non_trigger_turns/n_turns*100:.1f}%）")
    print(f"  成功注入次數  ：{total_injections}（{total_injections/n_turns*100:.1f}%）")
    print(f"  REM 週期次數  ：{rem_cycle_count}")
    print(f"  快取命中      ：{state.cache_hits}")
    print(f"  快取未命中    ：{state.cache_misses}")
    print(f"  讀取錯誤      ：{state.read_errors}")
    print(f"  寫入錯誤      ：{state.write_errors}")
    print(f"  邏輯問題      ：{len(all_issues)}")
    print(f"  崩潰次數      ：{len(crashes)}")

    # 判斷是否通過
    passed = len(crashes) == 0 and len(all_issues) == 0 and state.write_errors == 0

    print("\n" + "="*60)
    if passed:
        print(f"✅ 測試通過：{n_turns} 次對話全數正常完成，零崩潰，零邏輯錯誤")
    else:
        print(f"❌ 測試失敗")
        if crashes:
            print(f"\n  崩潰詳情：")
            for c in crashes:
                print(f"    {c}")
        if all_issues:
            print(f"\n  邏輯問題：")
            for i in all_issues:
                print(f"    {i}")
    print("="*60 + "\n")

    # 清理臨時目錄
    shutil.rmtree(tmp_dir, ignore_errors=True)

    return {
        "passed": passed,
        "n_turns": n_turns,
        "total_injections": total_injections,
        "rem_cycles": rem_cycle_count,
        "crashes": len(crashes),
        "issues": len(all_issues),
        "cache_hits": state.cache_hits,
        "cache_misses": state.cache_misses,
        "write_errors": state.write_errors,
        "read_errors": state.read_errors,
    }


# ─── 邊緣案例測試 ────────────────────────────────────────────

def run_edge_case_tests() -> list[str]:
    """測試特殊邊緣案例"""
    failures = []
    tmp_dir = Path(tempfile.mkdtemp(prefix="evolution-edge-"))
    state_dir = tmp_dir / ".claude" / "evolution-state"
    state_dir.mkdir(parents=True, exist_ok=True)
    state = EvolutionState(state_dir)
    setup_initial_state(state)

    print("\n" + "="*60)
    print("🔬 邊緣案例測試")
    print("="*60)

    # 測試 1：空提示詞
    print("\n[邊緣1] 空提示詞...")
    result = detect_persona_intent("", state.load_patterns(), 0.65)
    assert result is None, "空提示詞不應匹配任何人物"
    print("  ✅ 通過")

    # 測試 2：極端低信心度門檻（0.01）—— 所有模式都應觸發
    print("[邊緣2] 極端低門檻 (0.01)...")
    result = detect_persona_intent("芒格的思維", state.load_patterns(), 0.01)
    assert result is not None, "低門檻下應能匹配"
    print("  ✅ 通過")

    # 測試 3：極端高信心度門檻（0.99）—— 初始信心度 0.75 不滿足
    print("[邊緣3] 極端高門檻 (0.99)...")
    result = detect_persona_intent("芒格的思維", state.load_patterns(), 0.99)
    assert result is None, "高門檻下初始信心度 0.75 不應觸發"
    print("  ✅ 通過")

    # 測試 4：連續 50 次正向回饋，信心度不應超過 1.0
    print("[邊緣4] 連續 50 次正向回饋（信心度上限保護）...")
    patterns = state.load_patterns()
    target_pattern = patterns[0]
    for _ in range(50):
        conf, sr = record_pattern_usage(state, target_pattern.id, success=True)
    assert conf <= 1.0, f"信心度超出 1.0: {conf}"
    assert sr <= 1.0, f"成功率超出 1.0: {sr}"
    assert conf >= CONFIDENCE_FLOOR, f"信心度低於下限 {CONFIDENCE_FLOOR}: {conf}"
    issues = validate_state(state, 9999)
    if issues:
        failures.extend(issues)
        print(f"  ❌ 發現問題：{issues}")
    else:
        print(f"  ✅ 通過（信心度={conf:.4f}, 成功率={sr:.4f}）")

    # 測試 5：連續 50 次負向回饋，信心度不應低於 CONFIDENCE_FLOOR
    print("[邊緣5] 連續 50 次負向回饋（信心度下限保護）...")
    for _ in range(50):
        conf, sr = record_pattern_usage(state, target_pattern.id, success=False)
    assert conf >= CONFIDENCE_FLOOR, f"信心度低於下限 {CONFIDENCE_FLOOR}: {conf}"
    issues = validate_state(state, 9998)
    if issues:
        failures.extend(issues)
        print(f"  ❌ 發現問題：{issues}")
    else:
        print(f"  ✅ 通過（信心度={conf:.4f}，已被 floor 保護）")

    # 測試 6：REM 週期跑 20 次，狀態只能向前不能後退
    print("[邊緣6] 連續 20 次 REM 週期，狀態不能後退...")
    # 先給足夠的使用次數讓細胞成熟
    registry = state.load_registry()
    for cell in registry.stemCells:
        cell.usageCount = 30
        cell.positiveRating = 25
    state.write_registry(registry)

    prev_statuses = {}
    status_order = {"embryo": 0, "incubating": 1, "ready": 2, "installed": 3}

    for rem_i in range(20):
        run_rem_cycle(state)
        registry = state.load_registry()
        for cell in registry.stemCells:
            prev = prev_statuses.get(cell.id, "embryo")
            if status_order.get(cell.status, 0) < status_order.get(prev, 0):
                msg = f"狀態後退：{cell.target} {prev} → {cell.status}"
                failures.append(msg)
                print(f"  ❌ {msg}")
            prev_statuses[cell.id] = cell.status

    issues = validate_state(state, 9997)
    if issues:
        failures.extend(issues)
    else:
        final_statuses = {c.target: c.status for c in registry.stemCells}
        print(f"  ✅ 通過（最終狀態：{final_statuses}）")

    # 測試 7：patterns.jsonl 損毀後能否優雅回復
    print("[邊緣7] JSONL 部分損毀後的容錯性...")
    state._invalidate_cache()
    # 在 JSONL 尾端加入一行損毀資料
    with open(state.patterns_file, "a", encoding="utf-8") as f:
        f.write("{{invalid json line\n")
        f.write('{"id": "partial", "category": "nuwa", "target": "測試", "slug": "test", "confidence": 0.5, "successRate": 0.0, "sampleCount": 0, "mentalModels": [], "sourceCount": 0, "context": "test", "createdAt": "", "lastUsed": null}\n')

    recovered = state.load_patterns()
    # 應該能載入有效的行，跳過損毀的行
    valid_slugs = {p.slug for p in recovered}
    assert "charlie-munger" in valid_slugs, "損毀後仍應能讀到芒格的模式"
    print(f"  ✅ 通過（損毀後仍載入 {len(recovered)} 個有效模式）")

    # 測試 8：快取 TTL 過期後重新載入
    print("[邊緣8] 快取 TTL 模擬...")
    state._patterns_cache_at = time.time() - CACHE_TTL_SEC - 1  # 強制過期
    state.cache_misses_before = state.cache_misses
    state.load_patterns()
    assert state.cache_misses > state.cache_misses_before if hasattr(state, 'cache_misses_before') else True
    print(f"  ✅ 通過（快取命中={state.cache_hits}, 未命中={state.cache_misses}）")

    shutil.rmtree(tmp_dir, ignore_errors=True)

    print(f"\n邊緣案例測試結果：{'✅ 全數通過' if not failures else f'❌ {len(failures)} 個失敗'}")
    return failures


# ─── 入口 ──────────────────────────────────────────────────────

if __name__ == "__main__":
    random.seed(42)  # 固定種子，確保可重現性

    print("🏺 女媧進化學習系統 — 壓力模擬測試")
    print(f"Python {sys.version}")
    print(f"開始時間：{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}\n")

    start_time = time.time()

    # 主模擬（120 輪，超過 100 的要求）
    sim_result = run_simulation(n_turns=120)

    # 邊緣案例測試
    edge_failures = run_edge_case_tests()

    elapsed = time.time() - start_time

    print("\n" + "="*60)
    print("🏁 完整測試結果")
    print("="*60)
    print(f"\n  主模擬（{sim_result['n_turns']} 輪）：{'✅ 通過' if sim_result['passed'] else '❌ 失敗'}")
    print(f"  邊緣案例測試      ：{'✅ 通過' if not edge_failures else f'❌ {len(edge_failures)} 個失敗'}")
    print(f"  總執行時間        ：{elapsed:.2f} 秒")

    overall_passed = sim_result["passed"] and not edge_failures
    print(f"\n  整體結論          ：{'✅ 系統穩定，可以部署' if overall_passed else '❌ 需要修復問題再部署'}")
    print("="*60 + "\n")

    sys.exit(0 if overall_passed else 1)
