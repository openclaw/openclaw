# reminders 字段参考

提醒设置对象，用于 `create_schedule` 和 `update_schedule` 接口。

## 字段说明

| 字段 | 类型 | 说明 |
|------|------|------|
| `is_remind` | integer | 是否提醒：`0`-否，`1`-是 |
| `remind_before_event_secs` | integer | 提前提醒秒数，可选值：`0`/`300`/`900`/`3600`/`86400` |
| `remind_time_diffs` | array | 提醒时间差（秒），可选值：`-604800`/`-172800`/`-86400`/`-3600`/`-900`/`-300`/`0`/`32400` |
| `timezone` | integer | 时区，`-12` ~ `12`，中国为 `8` |

## 使用示例

### 基本提醒（提前 1 小时）

```json
{
    "is_remind": 1,
    "remind_before_event_secs": 3600,
    "timezone": 8
}
```
