from __future__ import annotations

import importlib.util
import subprocess
from html.parser import HTMLParser
from pathlib import Path


DOCS_DIR = Path(__file__).resolve().parent
BUILDER_PATH = DOCS_DIR / "build_operating_dashboard_web.py"
REPO_MISSING_DEFS_PATH = DOCS_DIR / "MoClaw_Operating_Dashboard_missing_definitions.txt"


class AnchorParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.anchors: list[dict[str, str]] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attr_map = {name: value or "" for name, value in attrs}
        if "data-anchor-id" in attr_map:
            self.anchors.append(attr_map)


def load_builder():
    spec = importlib.util.spec_from_file_location("dashboard_builder", BUILDER_PATH)
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def git_status_for(path: Path) -> str:
    result = subprocess.run(
        ["git", "status", "--short", "--", str(path.relative_to(DOCS_DIR.parent))],
        cwd=DOCS_DIR.parent,
        check=True,
        capture_output=True,
        text=True,
    )
    return result.stdout.strip()


def expected_anchor_id(anchor: dict[str, str]) -> str:
    section = anchor.get("data-anchor-section") or "_"
    row = anchor.get("data-anchor-row") or "_"
    column = anchor.get("data-anchor-column") or "_"
    return ":".join(
        [
            anchor.get("data-anchor-page", ""),
            anchor.get("data-anchor-version", ""),
            anchor.get("data-anchor-sheet", ""),
            section,
            row,
            column,
            anchor.get("data-anchor-type", ""),
        ]
    )


def test_generated_dashboard_cells_have_stable_comment_anchors(tmp_path: Path) -> None:
    builder = load_builder()
    assert builder.ROOT == DOCS_DIR
    output_path = tmp_path / "MoClaw_Operating_Dashboard_Web.html"
    missing_defs_path = tmp_path / "MoClaw_Operating_Dashboard_missing_definitions.txt"
    builder.OUT = output_path
    builder.MISSING_DEFS_OUT = missing_defs_path

    builder.main()

    parser = AnchorParser()
    parser.feed(output_path.read_text(encoding="utf-8"))
    if missing_defs_path.exists():
        assert "Count: 0" in missing_defs_path.read_text(encoding="utf-8")

    row_anchors = [anchor for anchor in parser.anchors if anchor.get("data-anchor-type") == "row"]
    section_anchors = [anchor for anchor in parser.anchors if anchor.get("data-anchor-type") == "section"]
    cell_anchors = [anchor for anchor in parser.anchors if anchor.get("data-anchor-type") == "cell"]
    header_row_anchors = [
        anchor
        for anchor in row_anchors
        if anchor.get("data-anchor-section") == "header" and anchor.get("data-anchor-row") == "header"
    ]
    header_cell_anchors = [
        anchor
        for anchor in cell_anchors
        if anchor.get("data-anchor-section") == "header" and anchor.get("data-anchor-row") == "header"
    ]
    assert row_anchors
    assert section_anchors
    assert cell_anchors
    assert header_row_anchors
    assert header_cell_anchors
    assert not any(anchor.get("data-anchor-type") == "header" for anchor in parser.anchors)

    for anchor in parser.anchors:
        assert anchor.get("data-anchor-page") == "moclaw_operating_dashboard"
        assert anchor.get("data-anchor-version") == "v1"
        assert anchor.get("data-anchor-sheet")
        assert anchor.get("data-anchor-sheet-title")
        assert anchor["data-anchor-id"] == expected_anchor_id(anchor)
        if anchor.get("data-anchor-type") == "section":
            assert anchor.get("data-anchor-section")
            assert anchor.get("data-anchor-section-title")
            assert anchor.get("data-anchor-row") == ""
            assert anchor.get("data-anchor-column") == ""
        elif anchor.get("data-anchor-type") == "row":
            assert anchor.get("data-anchor-section")
            assert anchor.get("data-anchor-row")
            assert anchor.get("data-anchor-row-label")
            assert anchor.get("data-anchor-column") == ""
        elif anchor.get("data-anchor-type") == "cell":
            assert anchor.get("data-anchor-section")
            assert anchor.get("data-anchor-row")
            assert anchor.get("data-anchor-column")
            assert anchor.get("data-anchor-row-label")
            assert anchor.get("data-anchor-column-label")

    anchor_ids = [anchor["data-anchor-id"] for anchor in parser.anchors]
    assert len(anchor_ids) == len(set(anchor_ids))


def sheet_by_title(sheets: list[dict], title: str) -> dict:
    return next(sheet for sheet in sheets if sheet["title"] == title)


def row_labels(sheet: dict) -> list[str]:
    return [row["values"][0] for row in sheet["rows"] if row.get("values")]


def row_by_label(sheet: dict, label: str) -> dict:
    return next(row for row in sheet["rows"] if row.get("values") and row["values"][0] == label)


def children_of(sheet: dict, label: str) -> list[dict]:
    parent = row_by_label(sheet, label)
    return [row for row in sheet["rows"] if row.get("parent") == parent["id"]]


def children_of_row(sheet: dict, parent: dict) -> list[dict]:
    return [row for row in sheet["rows"] if row.get("parent") == parent["id"]]


def top_level_labels_in_section(sheet: dict, section_suffix: str) -> list[str]:
    labels: list[str] = []
    in_section = False
    for row in sheet["rows"]:
        label = row["values"][0]
        if row["kind"] == "section":
            if in_section:
                break
            in_section = label.endswith(section_suffix)
            continue
        if in_section and row.get("level") == 0 and row["kind"] == "row":
            labels.append(label)
    return labels


def nonblank_metric_values(row: dict) -> list[str]:
    return [value for value in row["values"][1:] if value not in {"", "—", "-", "–", "None"}]


def test_backlog_decisions_are_reflected_in_current_schema() -> None:
    builder = load_builder()
    sheets = builder.workbook_model()
    assert builder.display_label_text("人均日任务数") == "人均日任务数"

    dashboard = sheet_by_title(sheets, "Dashboard")
    dashboard_labels = row_labels(dashboard)
    for label in ["1. 新用户链路", "2. 用户活跃与留存", "3. 用户使用", "4. Agent & 工程质量", "5. 业务经营"]:
        assert label in dashboard_labels
    assert "新增注册用户" in dashboard_labels
    assert "新增 DAU" in dashboard_labels
    assert "新增付费用户" in dashboard_labels
    assert "新增任务完成用户" not in dashboard_labels
    assert "CPA (美元)" not in dashboard_labels
    assert "CAC（待数据）" not in dashboard_labels
    assert "活跃时长 P50（分钟）" in dashboard_labels
    assert "人均日消息数" in dashboard_labels
    assert "消息失败率 (百分比)" in dashboard_labels
    assert "Chat 页面首次加载 P50（秒）" in dashboard_labels
    assert "现金收入" in dashboard_labels
    assert "推理成本 credits" in dashboard_labels
    assert "结账失败率 (百分比)" not in dashboard_labels
    assert "任务数" not in dashboard_labels
    assert "DAU D1 留存率 (百分比)" not in dashboard_labels
    assert "DAU D7 留存率 (百分比)" not in dashboard_labels
    assert top_level_labels_in_section(dashboard, "用户活跃与留存") == [
        "DAU",
        "WAU",
        "MAU",
        "D1 留存率",
        "D7 留存率",
    ]
    assert [row["values"][0] for row in children_of(dashboard, "DAU")] == ["新增 DAU", "回访 DAU"]
    assert top_level_labels_in_section(dashboard, "用户使用") == [
        "活跃时长 P50（分钟）",
        "活跃时长 P90（分钟）",
        "人均日消息数",
        "人均日任务数",
        "人均任务完成率",
        "功能-IM 连接比例",
        "功能-Connector 连接比例",
        "功能-定时任务比例",
        "功能-附件上传比例",
    ]
    assert "消息 tool 渗透率" in dashboard_labels
    assert "含 tool 消息平均 tool 调用数" in dashboard_labels
    for label in ["D1 留存率", "功能-IM 连接比例", "功能-Connector 连接比例", "功能-定时任务比例", "功能-附件上传比例"]:
        assert row_by_label(dashboard, label)
    for label in ["D1 留存率", "功能-IM 连接比例", "功能-Connector 连接比例", "功能-附件上传比例"]:
        assert nonblank_metric_values(row_by_label(dashboard, label))

    activation = sheet_by_title(sheets, "用户激活与转化")
    for label in [
        "首次任务开始用户数",
        "首次任务完成用户数",
        "首次发起任务率 (百分比)",
        "首次任务完成率 (百分比)",
    ]:
        assert row_by_label(activation, label)

    acquisition = sheet_by_title(sheets, "用户获取")
    acquisition_labels = row_labels(acquisition)
    assert "KOC / KOL（待成本与映射）" in acquisition_labels
    for label in ["CPA（待数据）", "CAC（待数据）", "KOC 成本（待数据）", "LTV（待数据）", "Payback（待数据）"]:
        assert label not in acquisition_labels
    for label in ["首日人均消息数", "前三日人均消息数"]:
        child_labels = [row["values"][0] for row in children_of(acquisition, label)]
        assert "Direct" in child_labels
        assert "Google Ads" in child_labels
        assert "KOC / KOL（待映射）" in child_labels

    activity = sheet_by_title(sheets, "用户活跃与使用分布")
    activity_labels = row_labels(activity)
    assert any(label.endswith("Agent 使用量与深度") for label in activity_labels)
    for label in [
        "活跃频次分层",
        "DAU地域分布",
        "DAU Interface 分布",
    ]:
        assert label in activity_labels
    assert top_level_labels_in_section(activity, "Agent 使用量与深度")[:3] == [
        "会话时长 P50（分钟）",
        "会话时长 P90（分钟）",
        "对话数",
    ]
    session_duration_definition = row_by_label(activity, "会话时长 P50（分钟）")["definition"]
    assert "30 分钟无对话活动切分" in session_duration_definition
    assert top_level_labels_in_section(sheet_by_title(sheets, "用户活跃与使用分布"), "功能使用量与深度") == [
        "IM 连接",
        "Connector 连接",
        "定时任务",
        "附件上传",
    ]
    for label in [
        "skill 使用次数",
        "附件上传用户数",
        "IM 连接完成",
        "Workspace connector 连接完成",
        "connector 连接完成",
        "Google connected",
        "Google Workspace 设置完成",
        "DAU 占比",
        "新增使用 DAU 占比",
        "下探项",
        "授权失败率",
        "调用成功率",
        "AI Gateway 请求",
        "Tool / Skill 使用",
        "tool use 请求占比",
        "附件处理次数",
        "附件查看次数",
        "附件上传成功率",
        "附件上传失败率",
        "自动化",
    ]:
        assert label not in activity_labels
    for parent_label in ["IM 连接", "Connector 连接", "定时任务", "附件上传"]:
        assert row_by_label(activity, parent_label)
        child_labels = [row["values"][0] for row in children_of(activity, parent_label)]
        assert child_labels[:3] == ["新增使用用户", "存量使用用户", "使用次数"]
        assert "DAU 占比" not in child_labels
        assert "新增使用 DAU 占比" not in child_labels
        assert "下探项" not in child_labels
    assert [row["values"][0] for row in children_of(activity, "附件上传")] == [
        "新增使用用户",
        "存量使用用户",
        "使用次数",
    ]
    im_new = next(row for row in children_of(activity, "IM 连接") if row["values"][0] == "新增使用用户")
    im_existing = next(row for row in children_of(activity, "IM 连接") if row["values"][0] == "存量使用用户")
    assert {"Telegram", "Slack", "Discord"}.issubset({row["values"][0] for row in children_of_row(activity, im_new)})
    assert {"Telegram", "Slack", "Discord"}.issubset({row["values"][0] for row in children_of_row(activity, im_existing)})
    connector_new = next(row for row in children_of(activity, "Connector 连接") if row["values"][0] == "新增使用用户")
    connector_existing = next(row for row in children_of(activity, "Connector 连接") if row["values"][0] == "存量使用用户")
    assert "Google Workspace" in [row["values"][0] for row in children_of_row(activity, connector_new)]
    assert "Google Workspace" in [row["values"][0] for row in children_of_row(activity, connector_existing)]
    for label in ["Top 地域", "Top Interface", "渠道"]:
        assert label not in activity_labels
    for label in ["存量国家 / 地区分布", "新增国家 / 地区分布", "存量端类型分布", "新增端类型分布"]:
        assert label not in activity_labels
    for label in ["DAU地域分布", "DAU Interface 分布"]:
        child_labels = [row["values"][0] for row in children_of(activity, label)]
        assert child_labels == ["新增", "回访"]
        assert nonblank_metric_values(row_by_label(activity, label))
    region_new = children_of(activity, "DAU地域分布")[0]
    region_new_children = children_of_row(activity, region_new)
    assert len(region_new_children) >= 3
    assert "渠道" not in [row["values"][0] for row in region_new_children]
    assert any(row["values"][0] == "Indonesia" for row in region_new_children)
    interface_new = children_of(activity, "DAU Interface 分布")[0]
    interface_new_children = children_of_row(activity, interface_new)
    assert [row["values"][0] for row in interface_new_children] == ["Web App", "IM"]
    interface_new_im = next(row for row in interface_new_children if row["values"][0] == "IM")
    assert nonblank_metric_values(interface_new_im)
    assert {"Telegram", "Slack", "Discord"}.issubset(
        {row["values"][0] for row in children_of_row(activity, interface_new_im)}
    )
    interface_returning = children_of(activity, "DAU Interface 分布")[1]
    interface_returning_children = children_of_row(activity, interface_returning)
    assert [row["values"][0] for row in interface_returning_children] == ["Web App", "IM"]
    interface_returning_im = next(row for row in interface_returning_children if row["values"][0] == "IM")
    assert nonblank_metric_values(interface_returning_im)
    assert {"Telegram", "Slack", "Discord"}.issubset(
        {row["values"][0] for row in children_of_row(activity, interface_returning_im)}
    )
    assert "freetrial 用户总数" not in activity_labels

    sheet_titles = [sheet["title"] for sheet in sheets]
    assert "工程质量" not in sheet_titles
    assert "用户留存与流失" not in sheet_titles

    agent_engineering_labels = row_labels(sheet_by_title(sheets, "Agent 质量"))
    for label in [
        "Chat 页面首次加载 P50（秒）",
        "Chat 页面首次加载 P95（秒）",
        "沙盒启动 P50（秒）",
        "用户每日首次沙盒启动 P50（秒）",
        "沙盒启动 P95（秒）",
        "用户每日首次沙盒启动 P95（秒）",
        "首 token P50（秒）",
        "用户首条消息 首 token P50（秒）",
        "LLM 首 token P95（秒）",
        "用户首条消息 首 token P95（秒）",
        "完整响应 P50（秒）",
        "用户首条消息 完整响应 P50（秒）",
        "完整响应 P95（秒）",
        "用户首条消息 完整响应 P95（秒）",
        "消息失败率 (百分比)",
        "流式错误率 (百分比)",
        "对话流中断率 (百分比)",
        "实时连接错误率 (百分比)",
        "AI Gateway 错误",
        "AI Gateway 错误率 (百分比)",
        "超时",
        "上游错误",
        "API 失败",
        "API 失败率 (百分比)",
        "沙盒启动次数",
        "沙盒启动失败",
        "沙盒启动失败率 (百分比)",
    ]:
        assert label in agent_engineering_labels
    assert "Chat 页面首次加载次数" not in agent_engineering_labels
    assert top_level_labels_in_section(sheet_by_title(sheets, "Agent 质量"), "Agent 响应体验") == [
        "Chat 页面首次加载 P50（秒）",
        "Chat 页面首次加载 P95（秒）",
        "沙盒启动 P50（秒）",
        "沙盒启动 P95（秒）",
        "首 token P50（秒）",
        "LLM 首 token P95（秒）",
        "完整响应 P50（秒）",
        "完整响应 P95（秒）",
    ]
    for label in [
        "API 请求",
        "API 成功",
        "沙盒启动耗时",
        "沙盒检查次数",
        "沙盒可达",
        "沙盒不可达",
        "沙盒不可达率 (百分比)",
        "沙盒启动成功",
        "沙盒重启失败",
        "沙盒重启失败率（待重启尝试数）",
    ]:
        assert label not in agent_engineering_labels
    assert [row["values"][0] for row in children_of(sheet_by_title(sheets, "Agent 质量"), "API 失败")] == [
        "API 失败率 (百分比)",
    ]
    assert [row["values"][0] for row in children_of(sheet_by_title(sheets, "Agent 质量"), "沙盒启动次数")] == [
        "沙盒启动失败",
        "沙盒启动失败率 (百分比)",
    ]
    gateway_children = children_of(sheet_by_title(sheets, "Agent 质量"), "AI Gateway 错误")
    assert [row["values"][0] for row in gateway_children[:2]] == ["AI Gateway 错误率 (百分比)", "流式中断"]
    assert [row["values"][0] for row in children_of(sheet_by_title(sheets, "Agent 质量"), "实时连接错误")] == [
        "实时连接错误率 (百分比)",
    ]
    assert [row["values"][0] for row in children_of(sheet_by_title(sheets, "Agent 质量"), "沙盒启动 P50（秒）")] == [
        "用户每日首次沙盒启动 P50（秒）",
    ]
    assert [row["values"][0] for row in children_of(sheet_by_title(sheets, "Agent 质量"), "沙盒启动 P95（秒）")] == [
        "用户每日首次沙盒启动 P95（秒）",
    ]
    assert "credits" not in agent_engineering_labels
    assert "tokens" not in agent_engineering_labels

    finance = sheet_by_title(sheets, "财务")
    finance_labels = row_labels(finance)
    for label in ["推理成本 credits", "LLM Cost Dashboard credits", "AI Gateway 请求", "credits / 消息", "credits / 任务"]:
        assert label in finance_labels
