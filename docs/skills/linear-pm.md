---
name: linear-pm
description: "Linear project management for OpenFinClaw — query issues, update status, create tasks, track UIUX progress. Use when: user asks about project progress, issue status, task management, creating/updating Linear issues, or says 'sync linear'. NOT for: GitHub issues (use gh CLI), code changes (use normal workflow)."
metadata: { "openclaw": { "emoji": "📋" } }
---

# Linear Project Management

OpenFinClaw 使用 Linear 跟踪开发进度。所有 UIUX 复刻任务、Phase D 功能、bug 修复都在 Linear 管理。

## Workspace 信息

| 项目         | 值                                                                 |
| ------------ | ------------------------------------------------------------------ |
| Workspace    | `xdan-product`                                                     |
| Team         | `XDAN-Product` (key: `XDA`)                                        |
| Project      | `openFinClaw`                                                      |
| Project Slug | `openfinclaw-86d56c914821`                                         |
| Project URL  | `https://linear.app/xdan-product/project/openfinclaw-86d56c914821` |

## 认证

API Key 存储在环境变量 `LINEAR_API_KEY` 中。

```bash
# 验证认证
curl -s https://api.linear.app/graphql \
  -H "Authorization: $LINEAR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"query": "{ viewer { name email } }"}' | python3 -m json.tool
```

## 常用操作

### 1. 查看项目进度

```bash
curl -s https://api.linear.app/graphql \
  -H "Authorization: $LINEAR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"query": "{ projects(filter: { slugId: { eq: \"openfinclaw-86d56c914821\" } }) { nodes { name progress } } }"}' \
  | python3 -c "import sys,json; p=json.load(sys.stdin)['data']['projects']['nodes'][0]; print(f'{p[\"name\"]}: {p[\"progress\"]*100:.0f}%')"
```

### 2. 列出所有 Issue（按状态分组）

```bash
curl -s https://api.linear.app/graphql \
  -H "Authorization: $LINEAR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"query": "{ projects(filter: { slugId: { eq: \"openfinclaw-86d56c914821\" } }) { nodes { issues(first: 50) { nodes { identifier title state { name } priorityLabel labels { nodes { name } } } } } } }"}' \
  | python3 -c "
import sys, json
issues = json.load(sys.stdin)['data']['projects']['nodes'][0]['issues']['nodes']
by_state = {}
for i in issues:
    s = i['state']['name']
    by_state.setdefault(s, []).append(i)
for state in ['In Progress', 'Todo', 'Backlog', 'Done']:
    items = by_state.get(state, [])
    if items:
        print(f'\n=== {state} ({len(items)}) ===')
        for i in items:
            labels = ', '.join(l['name'] for l in i['labels']['nodes'])
            print(f'  {i[\"identifier\"]:>6} [{i[\"priorityLabel\"]:>6}] {i[\"title\"]}  ({labels})')
"
```

### 3. 按 Tab 标签筛选 Issue

```bash
# 替换 LABEL_NAME 为: Overview / Strategy / Trader / Setting / Phase D
LABEL_NAME="Overview"
curl -s https://api.linear.app/graphql \
  -H "Authorization: $LINEAR_API_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"query\": \"{ issues(filter: { labels: { name: { eq: \\\"$LABEL_NAME\\\" } }, project: { slugId: { eq: \\\"openfinclaw-86d56c914821\\\" } } }, first: 30) { nodes { identifier title state { name } priorityLabel } } }\"}" \
  | python3 -m json.tool
```

### 4. 更新 Issue 状态

```bash
# State IDs:
#   Todo:        18aee933-46a4-4ec5-baa9-2a569ae74433
#   In Progress: 120a83fa-c1d9-48c5-9428-de5b446bbf51
#   Done:        e7e6168b-5623-47e8-9f90-4f37d3b3c260
#   Backlog:     458fb4b9-128c-49fd-a3f6-e351e9816e45

# 先查 Issue ID
IDENTIFIER="XDA-14"
ISSUE_ID=$(curl -s https://api.linear.app/graphql \
  -H "Authorization: $LINEAR_API_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"query\": \"{ issues(filter: { number: { eq: 14 }, team: { key: { eq: \\\"XDA\\\" } } }) { nodes { id } } }\"}" \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['issues']['nodes'][0]['id'])")

# 更新状态为 In Progress
STATE_ID="120a83fa-c1d9-48c5-9428-de5b446bbf51"
curl -s https://api.linear.app/graphql \
  -H "Authorization: $LINEAR_API_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"query\": \"mutation { issueUpdate(id: \\\"$ISSUE_ID\\\", input: { stateId: \\\"$STATE_ID\\\" }) { success issue { identifier title state { name } } } }\"}" \
  | python3 -m json.tool
```

### 5. 创建新 Issue

```python
# 用 Python 创建（避免 shell 转义问题）
import json, urllib.request

def create_linear_issue(title, description, priority=3, state="todo", labels=None):
    """
    priority: 1=Urgent, 2=High, 3=Medium, 4=Low
    state: "todo" | "in_progress" | "done" | "backlog"
    labels: list of label names
    """
    import os
    API_KEY = os.environ["LINEAR_API_KEY"]
    TEAM_ID = "4c68c244-a576-4895-af7e-e13ee756f0f5"
    PROJECT_ID = "d1edd787-df46-454b-986f-8ab9332eb26c"

    STATE_MAP = {
        "todo":        "18aee933-46a4-4ec5-baa9-2a569ae74433",
        "in_progress": "120a83fa-c1d9-48c5-9428-de5b446bbf51",
        "done":        "e7e6168b-5623-47e8-9f90-4f37d3b3c260",
        "backlog":     "458fb4b9-128c-49fd-a3f6-e351e9816e45",
    }

    LABEL_MAP = {
        "Overview":  "5f9d2e18-6f1c-4428-9ca9-9f68e12cfd71",
        "Strategy":  "a1e98f09-79f9-4441-932a-aac1cc0f5f88",
        "Trader":    "46f19a5b-2872-4850-8c31-39fd7a539f0e",
        "Setting":   "220fac7a-f6e9-4e97-96e1-bd0ee1a803b3",
        "Phase D":   "ff0137f6-9e61-4cd4-9eec-2e4dd8b7e709",
        "UIUX":      "1eae392d-d497-4558-9365-73d86eb6ae98",
        "P0":        "a1aca3a4-3003-4dfb-be10-295ec81d5ca7",
        "P1":        "701cb2be-fbae-4fbe-82e0-1cf7f1bb7662",
        "P2":        "d04f555c-48ec-4098-a6a6-d026e21c9b95",
        "Feature":   "4e33da92-e5d6-4fb3-ad2c-8916d63a38fd",
        "Bug":       "1d564928-86c9-4f94-a6eb-1a97721d730b",
        "Improvement": "3cee5d9a-0350-4305-b6de-5768fb45b1e0",
    }

    label_ids = [LABEL_MAP[l] for l in (labels or []) if l in LABEL_MAP]
    label_str = ", ".join(f'"{lid}"' for lid in label_ids)
    escaped_title = title.replace('"', '\\"')
    escaped_desc = json.dumps(description)[1:-1]

    query = f'''mutation {{
      issueCreate(input: {{
        title: "{escaped_title}",
        description: "{escaped_desc}",
        teamId: "{TEAM_ID}",
        projectId: "{PROJECT_ID}",
        priority: {priority},
        stateId: "{STATE_MAP[state]}",
        labelIds: [{label_str}]
      }}) {{ success issue {{ identifier title }} }}
    }}'''

    data = json.dumps({"query": query}).encode()
    req = urllib.request.Request(
        "https://api.linear.app/graphql",
        data=data,
        headers={"Authorization": API_KEY, "Content-Type": "application/json"}
    )
    result = json.loads(urllib.request.urlopen(req).read())
    issue = result["data"]["issueCreate"]["issue"]
    return f'{issue["identifier"]}: {issue["title"]}'


# 示例: 创建 bug issue
create_linear_issue(
    title="[Bug] Trader K-line 切换时间周期后不刷新",
    description="## 复现步骤\n1. 打开 Trader Tab\n2. 切换到 4h\n3. 图表无变化\n\n## 预期\n切换后重新加载 OHLCV 数据",
    priority=2,
    state="todo",
    labels=["Trader", "Bug", "UIUX"]
)
```

### 6. 添加评论到 Issue

```bash
ISSUE_ID="<issue-uuid>"  # 从查询获取
COMMENT="实现完成，已通过 L1 测试。待 L5 Playwright 验证。"
curl -s https://api.linear.app/graphql \
  -H "Authorization: $LINEAR_API_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"query\": \"mutation { commentCreate(input: { issueId: \\\"$ISSUE_ID\\\", body: \\\"$COMMENT\\\" }) { success } }\"}" \
  | python3 -m json.tool
```

## IDs 速查表

### Workflow States

| 状态        | ID                                     | 类型      |
| ----------- | -------------------------------------- | --------- |
| Backlog     | `458fb4b9-128c-49fd-a3f6-e351e9816e45` | backlog   |
| Todo        | `18aee933-46a4-4ec5-baa9-2a569ae74433` | unstarted |
| In Progress | `120a83fa-c1d9-48c5-9428-de5b446bbf51` | started   |
| Done        | `e7e6168b-5623-47e8-9f90-4f37d3b3c260` | completed |
| Canceled    | `4b74647a-c8ea-4953-94df-92d475c88072` | canceled  |

### Labels — 三维标签体系 (每个 Issue 必须同时具备 Module + Priority + Type)

**Module 维度**:

| 标签     | ID                                     | 用途               |
| -------- | -------------------------------------- | ------------------ |
| Overview | `5f9d2e18-6f1c-4428-9ca9-9f68e12cfd71` | Overview Tab 相关  |
| Strategy | `a1e98f09-79f9-4441-932a-aac1cc0f5f88` | Strategy Tab 相关  |
| Trader   | `46f19a5b-2872-4850-8c31-39fd7a539f0e` | Trader Tab 相关    |
| Setting  | `220fac7a-f6e9-4e97-96e1-bd0ee1a803b3` | Setting Tab 相关   |
| Phase D  | `ff0137f6-9e61-4cd4-9eec-2e4dd8b7e709` | Phase D 跨模块功能 |

**Priority 维度**:

| 标签 | ID                                     | 含义                 | Sprint          |
| ---- | -------------------------------------- | -------------------- | --------------- |
| P0   | `a1aca3a4-3003-4dfb-be10-295ec81d5ca7` | 必须 — 阻塞核心旅程  | Sprint 5 (本周) |
| P1   | `701cb2be-fbae-4fbe-82e0-1cf7f1bb7662` | 重要 — Mock 明确偏差 | Sprint 6 (下周) |
| P2   | `d04f555c-48ec-4098-a6a6-d026e21c9b95` | 可选 — 视觉/增强     | Sprint 7        |

**Type 维度**:

| 标签        | ID                                     | 含义                  |
| ----------- | -------------------------------------- | --------------------- |
| Feature     | `4e33da92-e5d6-4fb3-ad2c-8916d63a38fd` | 全新功能/面板/交互    |
| Bug         | `1d564928-86c9-4f94-a6eb-1a97721d730b` | 功能异常/数据不正确   |
| Improvement | `3cee5d9a-0350-4305-b6de-5768fb45b1e0` | 已有功能增强/视觉优化 |

**辅助维度**:

| 标签        | ID                                     | 用途                      |
| ----------- | -------------------------------------- | ------------------------- |
| UIUX        | `1eae392d-d497-4558-9365-73d86eb6ae98` | UIUX 设计稿复刻相关       |
| Data Layer  | `da7d6c89-00ad-4a46-b169-ba60a206fe7f` | 数据管道/API 改动         |
| Visual/CSS  | `fbe44d3e-6fe6-498b-8f1f-08eb48f38861` | 纯视觉/样式/动效          |
| Interaction | `d7e14b29-8368-49a8-bcfb-1c54afa56cbc` | 交互逻辑 (拖拽/排序/筛选) |

### Team & Project

| 实体                  | ID                                     |
| --------------------- | -------------------------------------- |
| Team (XDAN-Product)   | `4c68c244-a576-4895-af7e-e13ee756f0f5` |
| Project (openFinClaw) | `d1edd787-df46-454b-986f-8ab9332eb26c` |

## 开发工作流 — Linear 集成

### 开始一个 Issue

```
1. 在 Linear 找到要做的 Issue (如 XDA-14)
2. 更新状态: Todo → In Progress
3. 创建分支: git checkout -b feat/xda-14-equity-hero
4. 开发 + 测试
5. 完成后更新状态: In Progress → Done
6. 提交时在 commit message 中引用: feat(overview): equity hero SSE 实时更新 (XDA-14)
```

### 发现 Bug 时

```
1. 创建 Issue: labels=[Tab名, "Bug", 优先级]
2. 描述包含: 复现步骤 / 预期行为 / 实际行为
3. 修复后: 更新为 Done + 添加评论说明修复方案
```

### 完成一个 Tab 时

```
1. 筛选该 Tab 所有 Issue
2. 确认全部 Done
3. 运行 L5 Playwright 测试验证
4. 在 Linear 写 Project Update
```

## UIUX 设计稿对标

每个 Issue 的验收标准以设计稿为准:

| Tab      | 设计稿                                        | Issue 范围                          |
| -------- | --------------------------------------------- | ----------------------------------- |
| Overview | `dev/交易系统/05-交互设计/UIUX/overview.html` | XDA-14~23, XDA-146~154              |
| Strategy | `dev/交易系统/05-交互设计/UIUX/strategy.html` | XDA-24~29, XDA-155~165              |
| Trader   | `dev/交易系统/05-交互设计/UIUX/trader.html`   | XDA-30~35, XDA-120~131, XDA-166~175 |
| Setting  | `dev/交易系统/05-交互设计/UIUX/setting.html`  | XDA-36~41, XDA-132~142, XDA-177~185 |
| Phase D  | 跨 Tab                                        | XDA-42~45, XDA-135~136              |

详细需求文档: `dev/交易系统/04-模块设计/产品需求总览.md`

## 推荐 Custom Views

在 Linear UI 中手动创建以下视图 (API 不支持程序化创建):

| View              | Layout | Group by         | Filter                        | 用途                   |
| ----------------- | ------ | ---------------- | ----------------------------- | ---------------------- |
| Sprint Board      | Board  | State            | Cycle = current               | 每日站会看进度         |
| Module Heatmap    | List   | Label (Module)   | State != Done                 | 各模块剩余工作量       |
| Priority Burndown | List   | Label (P0/P1/P2) | State != Done                 | 按优先级追踪燃尽       |
| Type Triage       | Board  | Label (Type)     | State != Done                 | Bug 优先，Feature 次之 |
| UIUX Audit        | List   | Label (Module)   | Label has UIUX, State != Done | Mock 设计稿验收        |

## Sprint 规划

| Sprint   | 时间          | 目标                      | Issue 数 |
| -------- | ------------- | ------------------------- | -------- |
| Sprint 5 | 03/06 - 03/13 | P0 Cleanup — 消灭所有 P0  | 5        |
| Sprint 6 | 03/13 - 03/20 | P1 Polish — Mock 对标完整 | 21       |
| Sprint 7 | 03/20 - 03/27 | P2 Visual + Phase D       | 22       |

## Issue 创建规范

**标题格式**: `[Module/PX] 功能描述`

**Description 模板**:

```markdown
## 现状

（当前行为/缺失说明）

## 需求

（Mock 设计描述 + 具体实现要求）

## 验收标准

- [ ] 条件 1
- [ ] 条件 2

## 涉及文件

- `extensions/findoo-trader-plugin/dashboard/xxx.html`
- `extensions/findoo-trader-plugin/src/core/xxx.ts`
```

## Workflow 状态流转

```
Backlog  →  Todo  →  In Progress  →  Done
  P2/未排期    排入Sprint    写代码中       L5验证通过
```

- `Backlog`: P2 级别 + 未排期项
- `Todo`: 已排入当前/下个 Sprint
- `In Progress`: 正在开发中（同时只能有 1-2 个）
- `Done`: L5 Playwright 验证通过（不只是代码写完）

## 注意事项

- Linear 免费版无 API 调用限制，但 GraphQL 查询复杂度上限 10,000
- 查询 issues 时用 `first: 50` 分页，不要一次拉太多嵌套字段
- Issue description 的 `maxLength` 是无限制的，但 Project description 限 255 字符
- 创建 Issue 时用 Python 脚本避免 shell JSON 转义问题
- `LINEAR_API_KEY` 是个人 token，不要提交到代码仓库
- 三维标签强制: 每个 Issue 必须同时有 Module + Priority + Type 标签
- 当前项目: 114 issues, 66 Done / 48 Open, 3 Sprint cycles
