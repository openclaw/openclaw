---
name: feishu-calendar
description: |
  飞书日历：创建日程、邀请参与人。
  当用户提到创建日程、约会议、安排时间等意图时激活。
---

# 飞书日历

## 功能

创建日程并邀请参与人。日程在机器人日历中创建，自动同步到参与人日历。

## 使用方法

### 1. 解析参与人

用 `feishu-contacts` 按名字解析 open_id。

### 2. 创建日程 + 添加参与人

```typescript
import { createCalendarEvent } from "./src/calendar.js";

const result = await createCalendarEvent({
  cfg,
  event: {
    summary: "团队周会",
    description: "讨论本周工作进展",
    startTimestamp: "1772614800", // 秒级 Unix 时间戳（字符串）
    endTimestamp: "1772618400",
    location: "创新阁会议室",
    attendeeOpenIds: ["ou_xxx", "ou_yyy"], // 参与人 open_id
  },
});

if ("error" in result) {
  console.log(result.error); // 包含权限开启链接
} else {
  console.log(`日程已创建: ${result.eventId}`);
}
```

## 注意事项

- 时间戳必须是**字符串格式**的秒级时间戳
- `attendee_ability: "can_see_others"` — 参与者可看到其他参与者
- 参与人自动收到飞书通知，可接受/拒绝

## 权限要求

| Scope                        | 说明              |
| ---------------------------- | ----------------- |
| `calendar:calendar`          | 创建/修改日历日程 |
| `calendar:calendar:readonly` | 读取日历信息      |
