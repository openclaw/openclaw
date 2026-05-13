# 日历 (calendar) 命令参考

## 命令总览

### 查询日程列表
```
Usage:
  dws calendar event list [flags]
Example:
  dws calendar event list --start "2026-03-10T14:00:00+08:00" --end "2026-03-10T18:00:00+08:00"
Flags:
      --end string     结束时间 ISO-8601 (例如 2026-03-10T18:00:00+08:00)
      --start string   开始时间 ISO-8601 (例如 2026-03-10T14:00:00+08:00)
```

### 获取日程详情
```
Usage:
  dws calendar event get [flags]
Example:
  dws calendar event get --id <EVENT_ID>
Flags:
      --id string   日程 ID (必填)
```

### 创建日程
```
Usage:
  dws calendar event create [flags]
Example:
  dws calendar event create --title "Q1 复盘会" \
    --start "2026-03-10T14:00:00+08:00" --end "2026-03-10T15:00:00+08:00"
Flags:
      --desc string    日程描述
      --end string     结束时间 ISO-8601 (必填)
      --start string   开始时间 ISO-8601 (必填)
      --title string   日程标题 (必填)
```

### 修改日程
```
Usage:
  dws calendar event update [flags]
Example:
  dws calendar event update --id <EVENT_ID> --title "新标题"
Flags:
      --end string     新结束时间
      --id string      日程 ID (必填)
      --start string   新开始时间
      --title string   新标题
```

### 删除日程
```
Usage:
  dws calendar event delete [flags]
Example:
  dws calendar event delete --id <EVENT_ID> --yes
Flags:
      --id string   日程 ID (必填)
```

### 查看参与者
```
Usage:
  dws calendar participant list [flags]
Example:
  dws calendar participant list --event <EVENT_ID>
Flags:
      --event string   日程 ID (必填)
```

### 添加参与者
```
Usage:
  dws calendar participant add [flags]
Example:
  dws calendar participant add --event <EVENT_ID> --users <USER_ID_1>,<USER_ID_2>
Flags:
      --event string   日程 ID (必填)
      --users string   用户 ID 列表 (必填)
```

### 移除参与者
```
Usage:
  dws calendar participant delete [flags]
Example:
  dws calendar participant delete --event <EVENT_ID> --users <USER_ID> --yes
Flags:
      --event string   日程 ID (必填)
      --users string   用户 ID 列表 (必填)
```

### 搜索会议室
```
Usage:
  dws calendar room search [flags]
Example:
  dws calendar room search --start "2026-03-10T14:00:00+08:00" --end "2026-03-10T15:00:00+08:00" --available
  dws calendar room search --start "2026-03-10T14:00:00+08:00" --end "2026-03-10T15:00:00+08:00" --group-id <GROUP_ID>
Flags:
      --available        仅查空闲会议室
      --end string       结束时间 ISO-8601 (必填)
      --group-id string  会议室分组ID（可选，留空查根目录；超100条时需按分组查询）
      --start string     开始时间 ISO-8601 (必填)
```

### 预定会议室
```
Usage:
  dws calendar room add [flags]
Example:
  dws calendar room add --event <EVENT_ID> --rooms <ROOM_ID>
Flags:
      --event string   日程 ID (必填)
      --rooms string   会议室 ID 列表 (必填)
```

### 移除会议室
```
Usage:
  dws calendar room delete [flags]
Example:
  dws calendar room delete --event <EVENT_ID> --rooms <ROOM_ID> --yes
Flags:
      --event string   日程 ID (必填)
      --rooms string   会议室 ID 列表 (必填)
```

### 会议室分组列表
```
Usage:
  dws calendar room list-groups [flags]
Example:
  dws calendar room list-groups
```

### 查询用户闲忙状态
```
Usage:
  dws calendar busy search [flags]
Example:
  dws calendar busy search --users <USER_ID_1>,<USER_ID_2> \
    --start "2026-03-10T14:00:00+08:00" --end "2026-03-10T18:00:00+08:00"
Flags:
      --end string     结束时间 ISO-8601 (必填)
      --start string   开始时间 ISO-8601 (必填)
      --users string   用户 ID 列表 (必填)
```

## 意图判断

用户说"日程/会议/约会/日历":
- 查看 → `event list`
- 详情 → `event get`
- 创建/约 → `event create`
- 修改/改时间 → `event update`
- 取消/删除 → `event delete`

用户说"参会人/与会者":
- 查看 → `participant list`
- 邀请/添加 → `participant add`
- 移除 → `participant delete`

用户说"会议室/订会议室":
- 哪个空闲 → `room search`
- 预定 → `room add`
- 取消预定 → `room delete`
- 分组 → `room list-groups`，取 groupId 后 `room search --group-id`

用户说"有空吗/忙不忙/闲忙":
- 查询 → `busy search`

## 核心工作流

```bash
# 1. 创建日程 — 提取 eventId
dws calendar event create --title "Q1 复盘会" \
  --start "2026-03-10T14:00:00+08:00" --end "2026-03-10T15:00:00+08:00" --format json

# 2. 添加参与者
dws calendar participant add --event <EVENT_ID> --users userId1,userId2 --format json

# 3. 预定会议室 (先搜空闲)
dws calendar room search --start "2026-03-10T14:00:00+08:00" --end "2026-03-10T15:00:00+08:00" --format json
# 若返回错误(会议室超100条)，先查分组再按分组搜索:
#   dws calendar room list-groups --format json
#   dws calendar room search --start ... --end ... --group-id <GROUP_ID> --format json
dws calendar room add --event <EVENT_ID> --rooms <ROOM_ID> --format json

# 4. 查看日程列表
dws calendar event list --start "2026-03-10T14:00:00+08:00" --end "2026-03-10T15:00:00+08:00" --format json
```

## 上下文传递表

| 操作 | 从返回中提取 | 用于 |
|------|-------------|------|
| `event create` | `eventId` | participant/room 操作的 --event |
| `event list` | `events[].eventId` | event get/update/delete 的 --id |
| `room search` | `rooms[].roomId` | room add 的 --rooms |
| `room list-groups` | `groups[].groupId` | room search 的 --group-id |

## 注意事项

- 时间格式: `event create/update`、`event list` 和 `busy search` 用 ISO-8601
- 创建日程不会自动预定会议室，需额外 `room add`
- `room search` 不带 `--group-id` 时查根目录；企业会议室超过 100 条会报错，此时需先 `room list-groups` 获取分组，再按分组逐一查询

## 自动化脚本

| 脚本 | 场景 | 用法 |
|------|------|------|
| [calendar_today_agenda.py](../../scripts/calendar_today_agenda.py) | 查看今天/明天/本周日程安排 | `python calendar_today_agenda.py today` |
| [calendar_schedule_meeting.py](../../scripts/calendar_schedule_meeting.py) | 一键创建日程+添加参与者+预定会议室 | `python calendar_schedule_meeting.py --title "复盘会" --start "2026-03-15T14:00" --end "2026-03-15T15:00" --users userId1 --book-room` |
| [calendar_free_slot_finder.py](../../scripts/calendar_free_slot_finder.py) | 查询多人共同空闲时段 | `python calendar_free_slot_finder.py --users userId1,userId2 --date 2026-03-15` |
