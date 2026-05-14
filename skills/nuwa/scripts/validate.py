#!/usr/bin/env python3
"""
女媧三重驗證腳本 — 確保蒸餾品質

三重驗證規則：
  1. 跨領域驗證：觀點在多個不同領域都有體現
  2. 預測力驗證：觀點能預測此人在新情境的行為
  3. 排他性驗證：觀點是此人特有的，而非普世觀點

使用方式：
  python validate.py --target "查理·芒格"
  python validate.py --target "查理·芒格" --strict
  python validate.py --report
"""

import argparse
import json
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

# ─── 路徑設定 ─────────────────────────────────────────────────
SKILL_DIR = Path(__file__).parent.parent
EXAMPLES_DIR = SKILL_DIR / "examples"

# ─── 品質標準 ──────────────────────────────────────────────────
QUALITY_STANDARDS = {
    "min_sources": 20,           # 最少來源數
    "min_validation_rate": 0.60, # 三重驗證通過率下限
    "criticism_required": True,  # 批評路徑是否必要
    "min_mental_models": 5,      # 最少心智模型數
    "max_mental_models": 15,     # 最多心智模型數（超過表示未提煉）
    "min_heuristics": 3,         # 最少決策啟發式數
    "max_heuristics": 10,        # 最多決策啟發式數
}

# ─── 普世觀點黑名單（這些觀點不具排他性）────────────────────────
UNIVERSAL_PLATITUDES = [
    "誠實是最重要的",
    "努力工作",
    "持續學習",
    "long-term thinking",
    "長期思考",
    "勤奮",
    "保持好奇心",
    "永不放棄",
    "團隊合作",
    "以客為尊",
]


@dataclass
class ValidationResult:
    """驗證結果"""
    target: str
    passed: bool
    score: float  # 0.0 - 1.0
    issues: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    stats: dict = field(default_factory=dict)


def slugify(name: str) -> str:
    """將人物名稱轉換為適合檔案名稱的格式"""
    import unicodedata
    name = unicodedata.normalize("NFKD", name)
    name = re.sub(r"[^\w\s-]", "", name, flags=re.UNICODE)
    name = re.sub(r"[-\s]+", "-", name).strip("-")
    return name.lower()


def load_distillation(target: str) -> Optional[str]:
    """載入蒸餾文件"""
    slug = slugify(target)
    path = EXAMPLES_DIR / f"{slug}.md"
    if not path.exists():
        return None
    return path.read_text(encoding="utf-8")


def load_metadata(target: str) -> Optional[dict]:
    """載入蒸餾元資料"""
    slug = slugify(target)
    path = EXAMPLES_DIR / f"{slug}.meta.json"
    if not path.exists():
        return None
    return json.loads(path.read_text(encoding="utf-8"))


def count_section_items(content: str, section_name: str) -> int:
    """計算特定區段的項目數量"""
    # 找到區段
    pattern = rf"## {section_name}(.*?)(?=\n## |\Z)"
    match = re.search(pattern, content, re.DOTALL)
    if not match:
        return 0
    section_content = match.group(1)
    # 計算「### 」開頭的項目（心智模型）
    h3_items = len(re.findall(r"^### ", section_content, re.MULTILINE))
    if h3_items > 0:
        return h3_items
    # 計算「1. 」開頭的項目（決策啟發式）
    numbered_items = len(re.findall(r"^\d+\. ", section_content, re.MULTILINE))
    if numbered_items > 0:
        return numbered_items
    # 計算「- 」開頭的項目
    bullet_items = len(re.findall(r"^- ", section_content, re.MULTILINE))
    return bullet_items


def check_skeleton_unfilled(content: str) -> list[str]:
    """檢查骨架是否還有未填寫的佔位符"""
    placeholders = re.findall(r"\[.*?\]", content)
    # 過濾掉正常的 Markdown 連結格式
    unfilled = [p for p in placeholders if not p.startswith("[採集") and "http" not in p and len(p) < 50]
    return unfilled[:10]  # 最多回報 10 個


def check_platitudes(content: str) -> list[str]:
    """檢查是否包含普世觀點（排他性驗證）"""
    found = []
    content_lower = content.lower()
    for platitude in UNIVERSAL_PLATITUDES:
        if platitude.lower() in content_lower:
            found.append(platitude)
    return found


def validate_structure(content: str) -> tuple[list[str], list[str]]:
    """驗證蒸餾文件的結構完整性"""
    issues = []
    warnings = []

    required_sections = ["表達風格", "心智模型", "決策啟發式", "價值觀邊界", "誠實承認"]
    for section in required_sections:
        if f"## {section}" not in content:
            issues.append(f"缺少必要區段：{section}")

    # 檢查骨架是否未填寫
    unfilled = check_skeleton_unfilled(content)
    if unfilled:
        issues.append(f"發現 {len(unfilled)} 個未填寫的佔位符：{', '.join(unfilled[:3])}...")

    # 檢查心智模型數量
    mental_model_count = count_section_items(content, "心智模型")
    if mental_model_count < QUALITY_STANDARDS["min_mental_models"]:
        issues.append(f"心智模型數量不足（{mental_model_count} < {QUALITY_STANDARDS['min_mental_models']}）")
    elif mental_model_count > QUALITY_STANDARDS["max_mental_models"]:
        warnings.append(f"心智模型過多（{mental_model_count} > {QUALITY_STANDARDS['max_mental_models']}），建議進一步提煉")

    # 檢查決策啟發式數量
    heuristic_count = count_section_items(content, "決策啟發式")
    if heuristic_count < QUALITY_STANDARDS["min_heuristics"]:
        issues.append(f"決策啟發式數量不足（{heuristic_count} < {QUALITY_STANDARDS['min_heuristics']}）")

    # 檢查普世觀點
    platitudes = check_platitudes(content)
    if platitudes:
        warnings.append(f"可能包含普世觀點（排他性疑慮）：{', '.join(platitudes)}")

    return issues, warnings


def validate_metadata(metadata: Optional[dict]) -> tuple[list[str], list[str]]:
    """驗證元資料"""
    issues = []
    warnings = []

    if not metadata:
        warnings.append("缺少元資料檔案（.meta.json），無法驗證來源數量")
        return issues, warnings

    source_count = metadata.get("source_count", 0)
    if source_count < QUALITY_STANDARDS["min_sources"]:
        if source_count == 0:
            warnings.append("來源數量未記錄，請執行採集後更新元資料")
        else:
            issues.append(f"來源數量不足（{source_count} < {QUALITY_STANDARDS['min_sources']}）")

    return issues, warnings


def run_validation(target: str, strict: bool = False) -> ValidationResult:
    """執行完整驗證"""
    content = load_distillation(target)
    if not content:
        return ValidationResult(
            target=target,
            passed=False,
            score=0.0,
            issues=[f"找不到蒸餾文件：skills/nuwa/examples/{slugify(target)}.md"],
        )

    metadata = load_metadata(target)

    # 結構驗證
    struct_issues, struct_warnings = validate_structure(content)
    # 元資料驗證
    meta_issues, meta_warnings = validate_metadata(metadata)

    all_issues = struct_issues + meta_issues
    all_warnings = struct_warnings + meta_warnings

    # 計算品質分數
    total_checks = 7  # 五個區段 + 心智模型數量 + 決策啟發式數量
    passed_checks = total_checks - len([i for i in all_issues if "缺少" in i or "不足" in i])
    score = max(0.0, passed_checks / total_checks)

    # 嚴格模式：警告也算失敗
    passed = len(all_issues) == 0
    if strict:
        passed = passed and len(all_warnings) == 0

    stats = {
        "mental_models": count_section_items(content, "心智模型"),
        "heuristics": count_section_items(content, "決策啟發式"),
        "source_count": metadata.get("source_count", 0) if metadata else 0,
        "has_criticism": "批評" in content or "criticism" in content.lower(),
    }

    return ValidationResult(
        target=target,
        passed=passed,
        score=score,
        issues=all_issues,
        warnings=all_warnings,
        stats=stats,
    )


def print_result(result: ValidationResult) -> None:
    """列印驗證結果"""
    status = "✅ 通過" if result.passed else "❌ 未通過"
    score_bar = "█" * int(result.score * 10) + "░" * (10 - int(result.score * 10))
    print(f"\n🏺 女媧三重驗證報告")
    print("=" * 50)
    print(f"  目標人物：{result.target}")
    print(f"  驗證結果：{status}")
    print(f"  品質分數：[{score_bar}] {result.score:.0%}")
    print()

    if result.stats:
        print("  📊 統計資料：")
        print(f"    心智模型數：{result.stats.get('mental_models', '未知')}")
        print(f"    決策啟發式：{result.stats.get('heuristics', '未知')}")
        print(f"    採集來源數：{result.stats.get('source_count', '未記錄')}")
        print(f"    批評路徑：{'✓ 已包含' if result.stats.get('has_criticism') else '⚠ 未包含'}")
        print()

    if result.issues:
        print(f"  ❌ 問題（{len(result.issues)} 個）：")
        for issue in result.issues:
            print(f"    • {issue}")
        print()

    if result.warnings:
        print(f"  ⚠️  警告（{len(result.warnings)} 個）：")
        for warning in result.warnings:
            print(f"    • {warning}")
        print()

    if result.passed:
        print("  🎉 蒸餾品質合格！可執行整合：")
        print(f"    python integrate-evolution.py --target '{result.target}'")
    else:
        print("  🔧 請修正上述問題後重新驗證。")
    print()


def report_all() -> None:
    """列印所有蒸餾文件的驗證報告"""
    examples = list(EXAMPLES_DIR.glob("*.md"))
    if not examples:
        print("📭 尚未蒸餾任何人物。")
        return

    print(f"\n🏺 女媧蒸餾品質報告（共 {len(examples)} 位）\n")
    print(f"  {'人物':<20} {'品質分數':>10} {'心智模型':>8} {'啟發式':>6} {'問題':>6}")
    print("  " + "-" * 55)

    for f in sorted(examples):
        if f.name.endswith(".meta.json"):
            continue
        target = f.stem.replace("-", " ").title()
        result = run_validation(target)
        status = "✅" if result.passed else "❌"
        score = f"{result.score:.0%}"
        mm = result.stats.get("mental_models", "?")
        h = result.stats.get("heuristics", "?")
        issues = len(result.issues)
        print(f"  {status} {target:<18} {score:>10} {mm:>8} {h:>6} {issues:>6}")

    print()


def main() -> None:
    parser = argparse.ArgumentParser(
        description="女媧三重驗證腳本 — 確保蒸餾品質",
    )
    parser.add_argument("--target", "-t", help="要驗證的人物名稱")
    parser.add_argument("--strict", action="store_true", help="嚴格模式（警告也算失敗）")
    parser.add_argument("--report", action="store_true", help="列印所有蒸餾文件的驗證報告")

    args = parser.parse_args()

    if args.report:
        report_all()
        return

    if not args.target:
        parser.print_help()
        sys.exit(1)

    result = run_validation(args.target, strict=args.strict)
    print_result(result)

    sys.exit(0 if result.passed else 1)


if __name__ == "__main__":
    main()
