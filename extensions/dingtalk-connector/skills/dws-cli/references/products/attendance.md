# 考勤 (attendance) 命令参考

## 命令总览

### 查询个人考勤详情
```
Usage:
  dws attendance record get [flags]
Example:
  dws attendance record get --user <USER_ID> --date 2026-03-08
Flags:
      --date string   查询日期, 格式 YYYY-MM-DD (必填)
      --user string   钉钉用户 ID (必填)
```

### 批量查询员工班次信息
```
Usage:
  dws attendance shift list [flags]
Example:
  dws attendance shift list --users userId1,userId2 --start 2026-03-03 --end 2026-03-07
Flags:
      --end string     结束日期, 格式 YYYY-MM-DD (必填)
      --start string   开始日期, 格式 YYYY-MM-DD (必填)
      --users string   用户 ID 列表, 逗号分隔, 最多 50 个 (必填)
```

返回每条记录含：用户 ID、工作日期、打卡类型（OnDuty/OffDuty）、计划打卡时间、是否休息日。间隔不超过 7 天，最多 50 人。

### 查询某个人的考勤统计摘要
```
Usage:
  dws attendance summary [flags]
Example:
  dws attendance summary --user USER_ID --date "2026-03-12 15:00:00"
Flags:
      --date string   工作日期, 格式 yyyy-MM-dd HH:mm:ss (必填)
      --user string   钉钉用户 ID (必填)
```

### 查询考勤组与考勤规则
```
Usage:
  dws attendance rules [flags]
Example:
  dws attendance rules --date 2026-03-14
  dws attendance rules --date "2026-03-14 09:00:00"
Flags:
      --date string   考勤日期, 格式 YYYY-MM-DD 或 yyyy-MM-dd HH:mm:ss (必填)
```

查询考勤组/考勤规则。例如：我属于哪个考勤组、打卡范围是什么、弹性工时怎么算。

## 意图判断

用户说"打卡记录/出勤/考勤" → `record get`
用户说"排班/班次/当班" → `shift list`
用户说"考勤汇总/统计" → `summary`
用户说"考勤组/考勤规则/打卡规则" → `rules`

## 核心工作流

```bash
# 查看某人考勤
dws attendance record get --user <USER_ID> --date 2026-03-08 --format json

# 批量查排班
dws attendance shift list --users userId1,userId2 \
  --start 2026-03-03 --end 2026-03-07 --format json

# 查看考勤统计摘要
dws attendance summary --user <USER_ID> --date "2026-03-12 15:00:00" --format json

# 查看考勤组和规则
dws attendance rules --date 2026-03-14 --format json
```
## 上下文传递表
| 操作 | 提取 | 用于 |
|------|------|------|
| `contact user get-self` | `userId` | record get 的 --user, shift list 的 --users, summary 的 --user |
## 注意事项
- `record get` 的 `--date` 格式: YYYY-MM-DD（如 `2026-03-08`），CLI 自动转换为毫秒时间戳
- `shift list` 的 `--start/--end` 同样使用 YYYY-MM-DD 格式，间隔不超过 7 天
- `summary` 的 `--date` 格式: yyyy-MM-dd HH:mm:ss（如 `2026-03-12 15:00:00`）
- `rules` 的 `--date` 支持 YYYY-MM-DD 或 yyyy-MM-dd HH:mm:ss 两种格式
- 用户 ID 需从 `contact user get-self` 或 `contact user search` 获取

## 自动化脚本

| 脚本 | 场景 | 用法 |
|------|------|------|
| [attendance_my_record.py](../../scripts/attendance_my_record.py) | 查看我今天/指定日期的考勤记录 | `python attendance_my_record.py today` |
| [attendance_team_shift.py](../../scripts/attendance_team_shift.py) | 查询团队成员本周排班 | `python attendance_team_shift.py --users userId1,userId2` |
