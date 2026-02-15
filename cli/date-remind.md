# date-remind（日期提醒）

日期提醒 CLI（Rust 静态二进制）。源码在 `cli/date-remind/`。

## 功能

- 内置生日和纪念日数据（编译时嵌入 `data.json`，无需外部文件）
- 支持农历（含闰月）和阳历日期
- 自动计算下次发生日期、剩余天数、年龄、生肖、星座
- 输出 JSON 格式，~845KB

## 本地交叉编译（Windows → Linux 静态二进制）

```bash
$env:CARGO_TARGET_X86_64_UNKNOWN_LINUX_MUSL_LINKER='rust-lld'
cargo build --release --target x86_64-unknown-linux-musl --manifest-path cli/date-remind/Cargo.toml

# 产物：cli/date-remind/target/x86_64-unknown-linux-musl/release/date-remind (~845KB)
```

## 上传到服务器

```bash
scp cli/date-remind/target/x86_64-unknown-linux-musl/release/date-remind root@c.leot.fun:/opt/leot_svr/tools/bin/
ssh root@c.leot.fun chmod +x /opt/leot_svr/tools/bin/date-remind
```

## 用法示例

```bash
date-remind summary                    # 所有人的日期摘要 JSON {total, items}
date-remind remind --days 30           # 未来 30 天内的提醒
date-remind remind --days 0            # 今天的提醒
date-remind remind                     # 默认未来 7 天的提醒
```

## 输出字段说明

| 字段 | 说明 |
|---|---|
| `name` | 姓名 |
| `date_type` | Birthday（生日）或 Commemoration（纪念日） |
| `is_lunar` | 是否农历 |
| `month_day_str` | 月日中文表示（如「正月初八」「冬月二十」） |
| `next_occur_date_string` | 下次发生的阳历日期 |
| `remaining_days` | 距今剩余天数（0=今天） |
| `week_day` | 星期几 |
| `age` | 年龄（需有出生年份） |
| `chinese_zodiac` | 生肖（需有出生年份） |
| `constellation` | 星座 |

## 数据维护

生日/纪念日数据内嵌在二进制中（`src/data.json`）。修改数据后需要重新编译并上传。
