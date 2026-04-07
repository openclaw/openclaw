---
name: wecom-send-template-card
description: 当需要通过企业微信发送结构化卡片消息时使用，包括：通知提醒、投票表决、方案选择、多维度选择等需要用户交互或查看结构化信息的场景。即使用户未明确要求"发卡片"，只要语境适合（如"帮我问一下选A还是B"），也应主动激活。仅限 wecom 通道。
metadata:
  {
    "openclaw": { "emoji": "🃏", "requires": { "config": ["channels.wecom"] } },
  }
---

## 使用方式

在回复中输出 ` ```json ``` ` 代码块，内容为符合 [JSON Schema](./references/api-template-card-types.md) 的模板卡片 JSON。插件自动提取并发送。

````
你的回复文本...

```json
{
  "card_type": "...",
  ...
}
```
````

## 生成规则

1. **严格按 schema 生成**：字段名、类型、嵌套结构必须与 [./references/api-template-card-types.md](./references/api-template-card-types.md) 中的 JSON Schema 定义完全一致
2. **每张卡片必须有 `task_id`**：格式 `task_{场景}_{时间戳}`，只能包含数字、字母、`_-@`
3. 不要使用 MCP 工具调用，直接在回复中输出 JSON 代码块
4. 代码块外的文本会作为普通回复发送

## 卡片类型选择

### 决策流程

```
用户需求是否需要交互？
├─ 否（纯通知/信息推送）
│  ├─ 需要图片展示？ → news_notice
│  └─ 不需要图片   → text_notice
│
└─ 是（需要用户操作）
   ├─ 从有限选项中做一个操作（≤6个按钮）→ button_interaction
   ├─ 从一组选项中投票/选择（可多选）    → vote_interaction
   └─ 提供多个维度的选择（≤3个下拉框）  → multiple_interaction
```

### 场景速查

| card_type | 典型场景 |
|-----------|---------|
| `text_notice` | 系统告警、部署通知、数据日报、审批结果、放假公告 |
| `news_notice` | 新闻推送、活动宣传、产品发布、带图表的周报、新员工介绍 |
| `button_interaction` | 审批（同意/驳回）、工单处理（接单/转派）、确认操作、满意度评价、二次确认（是/否） |
| `vote_interaction` | 团建投票、会议时间协调、问卷单题、意见征集、方案评选 |
| `multiple_interaction` | 多维度信息收集（部门+楼层+时间）、报障工单（类型+紧急程度）、会议室预定（日期+时间+房间） |

### 易混淆卡片区分

- **button_interaction vs vote_interaction**：按钮型适合"少量选项+即时操作"（如确认/取消），投票型适合"选项多+可多选+统一提交"（如投票）
- **vote_interaction vs multiple_interaction**：投票型是"一个问题选多项"，多项选择型是"多个独立问题各选一项"（如同时选时间和地点）

## 必填字段速查

| card_type | required |
|-----------|----------|
| `text_notice` | `card_type`, `task_id`, `card_action`, (`main_title` 或 `sub_title_text` 至少一个) |
| `news_notice` | `card_type`, `task_id`, `main_title`, `card_action` |
| `button_interaction` | `card_type`, `task_id`, `main_title`, `button_list` |
| `vote_interaction` | `card_type`, `task_id`, `title`, `options` |
| `multiple_interaction` | `card_type`, `task_id`, `title`, `selectors` |

## 最小示例

### text_notice

```json
{
  "card_type": "text_notice",
  "main_title": { "title": "项目进度更新", "desc": "进度已达 80%" },
  "emphasis_content": { "title": "80%", "desc": "完成度" },
  "card_action": { "type": 1, "url": "https://work.weixin.qq.com" },
  "task_id": "task_progress_1711234567"
}
```

### news_notice

```json
{
  "card_type": "news_notice",
  "main_title": { "title": "新功能上线", "desc": "v5.0 已发布" },
  "card_image": { "url": "https://wework.qpic.cn/wwpic/xxx/0" },
  "card_action": { "type": 1, "url": "https://work.weixin.qq.com" },
  "task_id": "task_release_1711234568"
}
```

### button_interaction

```json
{
  "card_type": "button_interaction",
  "main_title": { "title": "方案选择", "desc": "请选择技术方案" },
  "button_list": [
    { "text": "A方案-重构", "style": 1, "key": "plan_a" },
    { "text": "B方案-兼容", "style": 4, "key": "plan_b" }
  ],
  "task_id": "task_plan_select_1711234569"
}
```

### vote_interaction（简化格式）

```json
{
  "card_type": "vote_interaction",
  "title": "团建投票",
  "description": "选择你想参加的活动",
  "options": [
    { "id": "hiking", "text": "爬山" },
    { "id": "dinner", "text": "聚餐" },
    { "id": "escape", "text": "密室逃脱" }
  ],
  "mode": 1,
  "submit_text": "提交投票",
  "task_id": "task_team_vote_1711234570"
}
```

### multiple_interaction（简化格式）

```json
{
  "card_type": "multiple_interaction",
  "title": "团建安排",
  "description": "分别选择时间和地点",
  "selectors": [
    {
      "title": "时间",
      "options": [
        { "id": "sat", "text": "周六" },
        { "id": "sun", "text": "周日" }
      ]
    },
    {
      "title": "地点",
      "options": [
        { "id": "park", "text": "公园" },
        { "id": "resort", "text": "度假村" }
      ]
    }
  ],
  "submit_text": "提交选择",
  "task_id": "task_arrange_1711234571"
}
```
