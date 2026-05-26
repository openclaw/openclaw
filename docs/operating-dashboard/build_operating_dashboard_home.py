#!/usr/bin/env python3
"""Generate the operations dashboard home HTML variants.

This file intentionally does not define its own Dashboard schema. The canonical
home tab is built by build_operating_dashboard_web.py via build_dashboard_home_schema().
"""
from __future__ import annotations

import html
import importlib.util
from pathlib import Path


ROOT = Path(__file__).resolve().parent
BASE_SCRIPT = ROOT / "build_operating_dashboard_web.py"
OUT = ROOT / "MoClaw_Operating_Dashboard_Web_home.html"
COMPAT_OUT = ROOT / "MoClaw_Operating_Dashboard_Web_v2_home.html"


def load_base_builder():
    spec = importlib.util.spec_from_file_location("operating_dashboard", BASE_SCRIPT)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Cannot load {BASE_SCRIPT}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


base = load_base_builder()


def render_html(sheets: list[dict]) -> str:
    comments_css = base.COMMENTS_CSS_PATH.read_text(encoding="utf-8")
    comment_scripts = [path.read_text(encoding="utf-8") for path in base.COMMENT_SCRIPT_PATHS]
    parts = [
        "<!doctype html>",
        '<html lang="zh-CN"><head><meta charset="utf-8">',
        '<meta name="viewport" content="width=device-width, initial-scale=1">',
        "<title>MoClaw Operating Dashboard · Home</title>",
        f"<script>{base.THEME_JS}</script>",
        f"<style>{base.render_css()}</style>",
        f"<style>{comments_css}</style></head><body>",
        '<nav class="topbar"><div class="tabs">',
    ]
    for i, sheet in enumerate(sheets):
        if sheet["title"] in {"用户获取", "Agent 质量", "财务", "附录1_口径裁决"}:
            parts.append('<span class="tab-divider" aria-hidden="true"></span>')
        parts.append(
            f'<button class="tab" data-sheet="{i}">'
            f'{html.escape(base.display_sheet_title(sheet["title"]))}</button>'
        )
    parts.extend(["</div></nav>", '<main><p class="history-hint">左滑查看更多历史数据</p>'])
    for i, sheet in enumerate(sheets):
        parts.append(base.render_sheet(sheet, i))
    parts.extend(
        [
            "</main>",
            *[f"<script>{script}</script>" for script in comment_scripts],
            f"<script>{base.render_js(sheets)}</script>",
            "</body></html>",
        ]
    )
    return "\n".join(parts)


def main() -> None:
    base.MISSING_DEFINITIONS.clear()
    sheets = base.workbook_model()
    html_output = render_html(sheets)
    OUT.write_text(html_output, encoding="utf-8")
    COMPAT_OUT.write_text(html_output, encoding="utf-8")
    print(OUT)
    print("sheets", len(sheets), "rows", sum(len(sheet["rows"]) for sheet in sheets))
    print("home_rows", len(sheets[0]["rows"]))


if __name__ == "__main__":
    main()
