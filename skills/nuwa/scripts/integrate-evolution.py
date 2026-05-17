#!/usr/bin/env python3
"""
女媧進化整合腳本 — 將蒸餾結果整合到四層進化架構

整合目標：
  第一層（運行即學習）：蒸餾結果寫入 patterns.jsonl
  第三層（增長心跳）  ：新增技能包為待孵化目標
  第四層（有機細胞）  ：將人物技能包登記為幹細胞胚胎

使用方式：
  python integrate-evolution.py --target "查理·芒格"
  python integrate-evolution.py --list
  python integrate-evolution.py --status
"""

import argparse
import json
import re
import sys
from datetime import datetime
from pathlib import Path
from typing import Optional

# ─── 路徑設定 ─────────────────────────────────────────────────
SKILL_DIR = Path(__file__).parent.parent
REPO_ROOT = SKILL_DIR.parent.parent  # OpenClaw repo 根目錄

EXAMPLES_DIR = SKILL_DIR / "examples"

# 進化系統的狀態檔案路徑（Plugin State 目錄）
# 實際執行時路徑由 OpenClaw 的 plugin state API 決定
# 此處使用相對路徑作為示意，實際由 api.pluginState 管理
EVOLUTION_STATE_DIR = REPO_ROOT / ".claude" / "evolution-state"
PATTERNS_FILE = EVOLUTION_STATE_DIR / "patterns.jsonl"
CELL_REGISTRY_FILE = EVOLUTION_STATE_DIR / "cell-registry.json"
GROWTH_METRICS_FILE = EVOLUTION_STATE_DIR / "growth-metrics.json"


def slugify(name: str) -> str:
    """將人物名稱轉換為適合 ID 的格式"""
    import unicodedata
    name = unicodedata.normalize("NFKD", name)
    name = re.sub(r"[^\w\s-]", "", name, flags=re.UNICODE)
    name = re.sub(r"[-\s]+", "-", name).strip("-")
    return name.lower()


def ensure_dirs() -> None:
    """確保進化狀態目錄存在"""
    EVOLUTION_STATE_DIR.mkdir(parents=True, exist_ok=True)


def load_distillation(target: str) -> Optional[str]:
    """載入蒸餾文件"""
    slug = slugify(target)
    path = EXAMPLES_DIR / f"{slug}.md"
    if not path.exists():
        return None
    return path.read_text(encoding="utf-8")


def load_metadata(target: str) -> dict:
    """載入蒸餾元資料"""
    slug = slugify(target)
    path = EXAMPLES_DIR / f"{slug}.meta.json"
    if path.exists():
        return json.loads(path.read_text(encoding="utf-8"))
    return {"target": target, "slug": slug}


def extract_mental_models(content: str) -> list[str]:
    """從蒸餾文件提取心智模型清單"""
    models = []
    pattern = r"### (\d+)\.\s+(.+?)(?=\n### |\n---|\Z)"
    matches = re.findall(pattern, content, re.DOTALL)
    for _, model_content in matches:
        first_line = model_content.strip().split("\n")[0].strip()
        if first_line:
            models.append(first_line)
    # 備選：直接找 ### 標題
    if not models:
        h3_matches = re.findall(r"^### (.+)$", content, re.MULTILINE)
        models = h3_matches[:10]
    return models


def write_to_patterns(target: str, content: str, metadata: dict) -> str:
    """將蒸餾結果寫入第一層學習模式庫"""
    ensure_dirs()

    pattern_id = f"nuwa-{slugify(target)}-{int(datetime.now().timestamp())}"
    mental_models = extract_mental_models(content)

    pattern = {
        "id": pattern_id,
        "type": "persona_distillation",
        "category": "nuwa",
        "target": target,
        "slug": slugify(target),
        "confidence": 0.75,  # 初始信心度（需透過使用驗證）
        "successRate": 0.0,   # 初始成功率（尚無使用記錄）
        "sampleCount": 0,
        "mentalModels": mental_models,
        "sourceCount": metadata.get("source_count", 0),
        "context": "persona_thinking",
        "createdAt": datetime.now().isoformat(),
        "lastUsed": None,
    }

    # 追加寫入 JSONL（每行一個 JSON 物件）
    with open(PATTERNS_FILE, "a", encoding="utf-8") as f:
        f.write(json.dumps(pattern, ensure_ascii=False) + "\n")

    return pattern_id


def register_stem_cell(target: str, pattern_id: str) -> str:
    """將人物技能包登記為第四層有機細胞的幹細胞胚胎"""
    ensure_dirs()

    stem_cell_id = f"stem-{slugify(target)}-001"

    # 讀取現有的細胞登記
    registry: dict = {"version": 1, "cells": {}, "stemCells": []}
    if CELL_REGISTRY_FILE.exists():
        try:
            registry = json.loads(CELL_REGISTRY_FILE.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            pass

    # 確保 stemCells 欄位存在
    if "stemCells" not in registry:
        registry["stemCells"] = []

    # 檢查是否已登記
    existing = next((sc for sc in registry["stemCells"] if sc["id"] == stem_cell_id), None)
    if existing:
        print(f"  ⚠️  幹細胞 {stem_cell_id} 已登記（狀態：{existing['status']}）")
        return stem_cell_id

    # 新增幹細胞胚胎
    stem_cell = {
        "id": stem_cell_id,
        "type": "persona_skill",
        "target": target,
        "slug": slugify(target),
        "patternId": pattern_id,
        "status": "embryo",           # embryo → incubating → ready → installed
        "maturityScore": 0.1,          # 初始成熟度
        "usageCount": 0,               # 使用次數
        "positiveRating": 0,           # 正向評分次數
        "skillPath": f"skills/nuwa/examples/{slugify(target)}.md",
        "createdAt": datetime.now().isoformat(),
        "lastEvaluated": None,
    }

    registry["stemCells"].append(stem_cell)
    CELL_REGISTRY_FILE.write_text(
        json.dumps(registry, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    return stem_cell_id


def update_growth_metrics(target: str, stem_cell_id: str) -> None:
    """通知第三層增長心跳，新增一個待孵化的技能胚胎"""
    ensure_dirs()

    metrics: dict = {
        "version": 1,
        "lastUpdated": datetime.now().isoformat(),
        "embryos": [],
    }
    if GROWTH_METRICS_FILE.exists():
        try:
            metrics = json.loads(GROWTH_METRICS_FILE.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            pass

    if "embryos" not in metrics:
        metrics["embryos"] = []

    # 檢查是否已存在
    existing_ids = [e["id"] for e in metrics["embryos"]]
    if stem_cell_id not in existing_ids:
        metrics["embryos"].append({
            "id": stem_cell_id,
            "target": target,
            "maturityScore": 0.1,
            "status": "embryo",
            "addedAt": datetime.now().isoformat(),
            "nextEvaluation": "next-rem-cycle",  # 下次快速眼動週期評估
        })
        metrics["lastUpdated"] = datetime.now().isoformat()
        GROWTH_METRICS_FILE.write_text(
            json.dumps(metrics, ensure_ascii=False, indent=2), encoding="utf-8"
        )


def update_metadata(target: str, pattern_id: str, stem_cell_id: str) -> None:
    """更新蒸餾元資料，標記為已整合"""
    slug = slugify(target)
    meta_path = EXAMPLES_DIR / f"{slug}.meta.json"

    metadata: dict = {"target": target, "slug": slug}
    if meta_path.exists():
        try:
            metadata = json.loads(meta_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            pass

    metadata["evolution_integrated"] = True
    metadata["integration_date"] = datetime.now().isoformat()
    metadata["pattern_id"] = pattern_id
    metadata["stem_cell_id"] = stem_cell_id

    meta_path.write_text(json.dumps(metadata, ensure_ascii=False, indent=2), encoding="utf-8")


def list_integrated() -> None:
    """列出所有已整合到進化系統的人物"""
    if not CELL_REGISTRY_FILE.exists():
        print("📭 尚未有任何蒸餾結果整合到進化系統。")
        return

    registry = json.loads(CELL_REGISTRY_FILE.read_text(encoding="utf-8"))
    stem_cells = registry.get("stemCells", [])

    if not stem_cells:
        print("📭 幹細胞池為空。")
        return

    print(f"\n🧬 幹細胞池（共 {len(stem_cells)} 個）：\n")
    status_icons = {
        "embryo": "🥚",
        "incubating": "🐣",
        "ready": "✅",
        "installed": "🌟",
    }
    for sc in stem_cells:
        icon = status_icons.get(sc["status"], "❓")
        maturity = f"{sc.get('maturityScore', 0):.0%}"
        print(f"  {icon} {sc['target']:<20} 成熟度：{maturity:<8} 狀態：{sc['status']}")
    print()


def show_status() -> None:
    """顯示進化整合狀態總覽"""
    print("\n🏺 女媧 × 四層進化系統整合狀態\n")

    # 第一層：patterns.jsonl
    pattern_count = 0
    if PATTERNS_FILE.exists():
        with open(PATTERNS_FILE, encoding="utf-8") as f:
            pattern_count = sum(1 for line in f if line.strip())
    print(f"  第一層（學習模式庫）：{pattern_count} 個女媧模式已寫入")

    # 第四層：cell-registry.json
    stem_count = 0
    if CELL_REGISTRY_FILE.exists():
        registry = json.loads(CELL_REGISTRY_FILE.read_text(encoding="utf-8"))
        stem_count = len(registry.get("stemCells", []))
    print(f"  第四層（幹細胞池）  ：{stem_count} 個人物技能胚胎")

    # 第三層：growth-metrics.json
    embryo_count = 0
    if GROWTH_METRICS_FILE.exists():
        metrics = json.loads(GROWTH_METRICS_FILE.read_text(encoding="utf-8"))
        embryo_count = len(metrics.get("embryos", []))
    print(f"  第三層（增長心跳）  ：{embryo_count} 個胚胎待下次 REM 週期評估")

    # 本地蒸餾文件
    local_count = len(list(EXAMPLES_DIR.glob("*.md")))
    print(f"\n  本地蒸餾文件：{local_count} 位")
    print(f"  進化整合比例：{stem_count}/{local_count}")
    print()


def main() -> None:
    parser = argparse.ArgumentParser(
        description="女媧進化整合腳本 — 將蒸餾結果整合到四層進化架構",
    )
    parser.add_argument("--target", "-t", help="要整合的人物名稱")
    parser.add_argument("--list", "-l", action="store_true", help="列出已整合的人物")
    parser.add_argument("--status", "-s", action="store_true", help="顯示整合狀態總覽")

    args = parser.parse_args()

    if args.list:
        list_integrated()
        return

    if args.status:
        show_status()
        return

    if not args.target:
        parser.print_help()
        sys.exit(1)

    target = args.target.strip()
    print(f"\n🏺 女媧進化整合啟動")
    print(f"   目標人物：{target}")
    print()

    # 載入蒸餾文件
    content = load_distillation(target)
    if not content:
        print(f"❌ 找不到蒸餾文件：skills/nuwa/examples/{slugify(target)}.md")
        print(f"   請先執行：python distill.py --target '{target}'")
        sys.exit(1)

    metadata = load_metadata(target)

    # 第一層整合：寫入 patterns.jsonl
    print("  [1/3] 第一層整合：寫入學習模式庫...")
    pattern_id = write_to_patterns(target, content, metadata)
    print(f"        ✅ 模式 ID：{pattern_id}")

    # 第四層整合：登記幹細胞胚胎
    print("  [2/3] 第四層整合：登記幹細胞胚胎...")
    stem_cell_id = register_stem_cell(target, pattern_id)
    print(f"        ✅ 幹細胞 ID：{stem_cell_id}")

    # 第三層整合：通知增長心跳
    print("  [3/3] 第三層整合：通知增長心跳...")
    update_growth_metrics(target, stem_cell_id)
    print(f"        ✅ 已排入下次 REM 週期評估")

    # 更新元資料
    update_metadata(target, pattern_id, stem_cell_id)

    print()
    print(f"🎉 整合完成！{target} 的思維框架已進入進化系統。")
    print()
    print("  後續流程（自動）：")
    print("  ├─ 第三層 REM 週期：評估技能胚胎成熟度")
    print("  ├─ 成熟度 > 0.8：幹細胞狀態升為 'ready'")
    print("  └─ 使用者確認後：技能包晉升為常駐細胞")
    print()
    print("  立即使用：")
    print(f"  「用 {target} 的方式分析這個問題」")
    print()


if __name__ == "__main__":
    main()
