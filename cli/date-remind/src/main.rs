mod model;
mod summary;

use clap::Parser;
use serde_json::json;

use crate::model::DateReminder;
use crate::summary::calc_all_summaries;

const DATA: &str = include_str!("data.json");

#[derive(Parser)]
#[command(
    name = "date-remind",
    version,
    about = "日期提醒 CLI - 查询内置的生日和纪念日数据（支持农历/阳历）",
    long_about = "\
日期提醒 CLI - 查询内置的生日和纪念日数据（支持农历/阳历）

数据已内置于二进制中，无需外部文件。包含家人、朋友的生日及纪念日。
支持农历（含闰月）和阳历日期，自动计算：
  - 下次发生日期和剩余天数
  - 年龄、生肖、星座（如有出生年份）
  - 农历月日的中文表示（如「正月初八」「冬月二十」）

输出为 JSON 格式，字段说明：
  name              姓名
  date_type         Birthday（生日）或 Commemoration（纪念日）
  is_lunar          是否农历
  month_day_str     月日中文表示
  next_occur_date_string  下次发生的阳历日期
  remaining_days    距今剩余天数（0=今天）
  week_day          星期几
  age               年龄（需有出生年份）
  chinese_zodiac    生肖（需有出生年份）
  constellation     星座

使用场景举例：
  - 「最近有谁过生日？」→ date-remind remind --days 30
  - 「某某生日什么时候？」→ date-remind summary | 搜索姓名
  - 「今天有什么提醒？」→ date-remind remind --days 0"
)]
struct Cli {
    #[command(subcommand)]
    action: Action,
}

#[derive(clap::Subcommand)]
enum Action {
    /// 查看所有日期摘要（按下次发生时间排序），输出 JSON {total, items}
    Summary,
    /// 查看 N 天内即将到来的提醒，输出 JSON {days, total, items}
    Remind {
        /// 提醒天数，显示 remaining_days <= N 的事件（0=仅今天）
        #[arg(long, default_value = "7")]
        days: i64,
    },
}

fn load_reminders() -> Result<Vec<DateReminder>, Box<dyn std::error::Error>> {
    let all: Vec<DateReminder> = serde_json::from_str(DATA)?;
    Ok(all)
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let cli = Cli::parse();

    match cli.action {
        Action::Summary => {
            let reminders = load_reminders()?;
            let summaries = calc_all_summaries(&reminders)?;
            println!("{}", serde_json::to_string(&json!({
                "total": summaries.len(),
                "items": summaries,
            }))?);
        }
        Action::Remind { days } => {
            let reminders = load_reminders()?;
            let summaries = calc_all_summaries(&reminders)?;
            let upcoming: Vec<_> = summaries
                .into_iter()
                .filter(|s| s.remaining_days <= days)
                .collect();
            println!("{}", serde_json::to_string(&json!({
                "days": days,
                "total": upcoming.len(),
                "items": upcoming,
            }))?);
        }
    }

    Ok(())
}
