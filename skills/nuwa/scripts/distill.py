#!/usr/bin/env python3
"""
女媧蒸餾腳本 — 六路並行採集任何人物的思維框架

使用方式：
  python distill.py --target "查理·芒格" --phase collect
  python distill.py --target "查理·芒格" --phase all
  python distill.py --list
"""

import argparse
import json
import os
import re
import sys
from datetime import datetime
from pathlib import Path
from typing import Any

# ─── 路徑設定 ─────────────────────────────────────────────────
SKILL_DIR = Path(__file__).parent.parent
EXAMPLES_DIR = SKILL_DIR / "examples"
REFERENCES_DIR = SKILL_DIR / "references"
EXAMPLES_DIR.mkdir(exist_ok=True)

# ─── 六路採集框架 ──────────────────────────────────────────────
COLLECTION_PATHS = {
    "works": {
        "name": "作品路徑",
        "description": "書籍、文章、演講稿、訪談紀要",
        "queries": [
            '"{name}" 書籍 著作 思想',
            '"{name}" 演講 keynote speech',
            '"{name}" 訪談 interview 觀點',
            '"{name}" site:medium.com OR site:substack.com',
        ],
    },
    "podcast": {
        "name": "播客路徑",
        "description": "Podcast、TED、YouTube 逐字稿",
        "queries": [
            '"{name}" podcast transcript',
            '"{name}" TED talk',
            '"{name}" YouTube interview transcript',
        ],
    },
    "social": {
        "name": "社交路徑",
        "description": "推特/X、部落格、公開信",
        "queries": [
            '"{name}" twitter tweets notable',
            '"{name}" blog post essay',
            '"{name}" open letter public statement',
        ],
    },
    "criticism": {
        "name": "批評路徑（必要）",
        "description": "反對者觀點、錯誤案例、爭議紀錄",
        "queries": [
            '"{name}" criticism critique wrong mistake',
            '"{name}" controversy failure',
            '"{name}" disagree counterargument',
        ],
    },
    "decisions": {
        "name": "決策路徑",
        "description": "重大決策記錄、失敗後的覆盤",
        "queries": [
            '"{name}" decision making process',
            '"{name}" investment decision business decision',
            '"{name}" retrospective lessons learned',
        ],
    },
    "timeline": {
        "name": "時間線路徑",
        "description": "思想演化過程，早期 vs 晚期對比",
        "queries": [
            '"{name}" early career vs later thinking evolution',
            '"{name}" changed mind updated belief',
            '"{name}" intellectual journey',
        ],
    },
}

# ─── 五維蒸餾模板 ──────────────────────────────────────────────
DISTILLATION_TEMPLATE = """# {name} 思維蒸餾包

> 蒸餾日期：{date}
> 資料來源數：{source_count} 個獨立來源
> 三重驗證通過：{validated_count} / {candidate_count} 個觀點
> 蒸餾版本：v1.0

---

## 表達風格

> 此人說話和寫作的特徵模式

{expression_style}

---

## 心智模型

> 此人慣用的認知框架，按使用頻率排序

{mental_models}

---

## 決策啟發式

> 此人做決策時的快速過濾器和判斷規則

{decision_heuristics}

---

## 價值觀邊界

> 此人絕對不做的事，以及反面模式

{value_boundaries}

---

## 誠實承認

> 此人公開承認的限制、弱點、不確定領域

{honest_acknowledgments}

---

## 使用方式

```
用 {name} 的方式分析 [具體問題]
{name} 會怎麼看 [具體情境]？
用 {name} 的決策框架評估 [選項A] vs [選項B]
```

---

## 蒸餾說明

此蒸餾包基於公開資料，包含批評路徑資料。
定期更新建議：每 6 個月，反映思想演化。
資料來源：作品、播客、社交媒體、批評者觀點、決策記錄、時間線分析。
"""


def slugify(name: str) -> str:
    """將人物名稱轉換為適合檔案名稱的格式"""
    import unicodedata
    # 移除特殊字元，保留字母數字和空格
    name = unicodedata.normalize("NFKD", name)
    name = re.sub(r"[^\w\s-]", "", name, flags=re.UNICODE)
    name = re.sub(r"[-\s]+", "-", name).strip("-")
    return name.lower()


def list_distilled() -> None:
    """列出所有已蒸餾的人物"""
    examples = list(EXAMPLES_DIR.glob("*.md"))
    if not examples:
        print("📭 尚未蒸餾任何人物。使用 --target '人物名稱' 開始蒸餾。")
        return

    print(f"\n🏺 已蒸餾人物（共 {len(examples)} 位）：\n")
    for f in sorted(examples):
        content = f.read_text(encoding="utf-8")
        # 從第一行提取名稱
        first_line = content.split("\n")[0].replace("# ", "").replace(" 思維蒸餾包", "")
        # 提取蒸餾日期
        date_match = re.search(r"蒸餾日期：(\S+)", content)
        date = date_match.group(1) if date_match else "未知"
        print(f"  ✅ {first_line:<20} （蒸餾於 {date}）")
    print()


def build_search_queries(target: str) -> dict[str, list[str]]:
    """為目標人物建立所有搜尋查詢"""
    queries = {}
    for path_key, path_config in COLLECTION_PATHS.items():
        queries[path_key] = [
            q.replace("{name}", target) for q in path_config["queries"]
        ]
    return queries


def print_collection_plan(target: str) -> None:
    """列印採集計劃（供 Claude 執行）"""
    print(f"\n🏺 女媧蒸餾計劃：{target}")
    print("=" * 60)
    print("\n📋 六路並行採集計劃：\n")

    queries = build_search_queries(target)
    total_queries = 0

    for i, (path_key, path_config) in enumerate(COLLECTION_PATHS.items(), 1):
        is_critical = path_key == "criticism"
        marker = "⚠️ 必要" if is_critical else f"路徑 {i}"
        print(f"  [{marker}] {path_config['name']}")
        print(f"  說明：{path_config['description']}")
        print(f"  搜尋查詢：")
        for q in queries[path_key]:
            print(f"    - {q}")
            total_queries += 1
        print()

    print(f"  合計：{total_queries} 個搜尋查詢，六路並行執行")
    print("\n📌 注意：批評路徑是必要的，缺少批評資料的蒸餾不可信。\n")


def generate_skeleton(target: str) -> str:
    """生成蒸餾骨架（供 Claude 填寫）"""
    slug = slugify(target)
    output_path = EXAMPLES_DIR / f"{slug}.md"

    skeleton = DISTILLATION_TEMPLATE.format(
        name=target,
        date=datetime.now().strftime("%Y-%m-%d"),
        source_count="[採集完成後填入]",
        validated_count="[驗證完成後填入]",
        candidate_count="[驗證完成後填入]",
        expression_style="""- **語氣**：[直接/迂迴/諷刺/幽默]
- **標誌詞彙**：[列出 3-5 個特有詞彙]
- **句型結構**：[描述慣用句型]
- **比喻偏好**：[描述常用比喻領域]""",
        mental_models="""### 1. [心智模型名稱]
- **描述**：[簡短說明此框架]
- **使用條件**：[何時啟用此框架]
- **代表語錄**：[引用此人原話]

### 2. [心智模型名稱]
（重複以上格式，建議 5-10 個）""",
        decision_heuristics="""1. **[啟發式名稱]**：[一句話描述這個決策規則]
2. **[啟發式名稱]**：[一句話描述]
（建議 3-8 個啟發式）""",
        value_boundaries="""### 絕對不做
- [描述邊界 1]
- [描述邊界 2]

### 反面模式（此人批評的行為）
- [描述反面模式 1]
- [描述反面模式 2]""",
        honest_acknowledgments="""- **承認的弱點**：[具體描述]
- **能力邊界**：[描述此人認為自己不擅長的領域]
- **不確定領域**：[描述此人公開表示不確定的事]""",
    )

    output_path.write_text(skeleton, encoding="utf-8")
    print(f"\n✅ 已生成蒸餾骨架：{output_path}")
    print("   請根據採集結果填寫骨架內容。\n")
    return str(output_path)


def save_metadata(target: str, metadata: dict[str, Any]) -> None:
    """儲存蒸餾元資料"""
    meta_path = EXAMPLES_DIR / f"{slugify(target)}.meta.json"
    meta_path.write_text(json.dumps(metadata, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"✅ 元資料已儲存：{meta_path}")


def main() -> None:
    parser = argparse.ArgumentParser(
        description="女媧蒸餾腳本 — 提取任何人物的思維框架",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--target", "-t", help="要蒸餾的人物名稱")
    parser.add_argument(
        "--phase",
        choices=["plan", "skeleton", "all"],
        default="all",
        help="執行階段：plan=列印採集計劃, skeleton=生成骨架, all=全部",
    )
    parser.add_argument("--list", "-l", action="store_true", help="列出已蒸餾人物")
    parser.add_argument("--source-count", type=int, default=0, help="採集到的來源數量（供元資料記錄）")

    args = parser.parse_args()

    if args.list:
        list_distilled()
        return

    if not args.target:
        parser.print_help()
        sys.exit(1)

    target = args.target.strip()
    print(f"\n🏺 女媧蒸餾系統啟動")
    print(f"   目標人物：{target}")
    print(f"   執行階段：{args.phase}")

    if args.phase in ("plan", "all"):
        print_collection_plan(target)

    if args.phase in ("skeleton", "all"):
        output_path = generate_skeleton(target)

        # 儲存元資料
        metadata = {
            "target": target,
            "slug": slugify(target),
            "created_at": datetime.now().isoformat(),
            "phase": "skeleton_generated",
            "source_count": args.source_count,
            "evolution_integrated": False,
        }
        save_metadata(target, metadata)

    print("🏺 下一步：")
    print(f"   1. 執行六路搜尋查詢（見上方計劃）")
    print(f"   2. 填寫骨架：skills/nuwa/examples/{slugify(target)}.md")
    print(f"   3. 執行驗證：python validate.py --target '{target}'")
    print(f"   4. 整合進化：python integrate-evolution.py --target '{target}'")


if __name__ == "__main__":
    main()
