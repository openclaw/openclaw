use chinese_lunisolar_calendar::{ChineseVariant, LunisolarDate, LunisolarError, SolarDate};
use chrono::{Datelike, Days, Local, NaiveDate};
use serde::{Deserialize, Serialize};

use crate::model::DateReminder;

#[derive(Serialize, Deserialize, Debug)]
pub struct SummaryOutput {
    pub name: String,
    pub date_type: String,
    pub is_lunar: bool,
    pub month: u32,
    pub day: u32,
    pub year: Option<i32>,
    /// 天数 (如果有 year, 计算从出生/纪念日到今天的天数)
    pub days: Option<i64>,
    pub next_occur_timestamp: i64,
    pub next_occur_date_string: String,
    /// 属相-生肖
    pub chinese_zodiac: Option<String>,
    /// 星座
    pub constellation: Option<String>,
    /// 剩余天数
    pub remaining_days: i64,
    pub age: Option<i32>,
    pub week_day: String,
    /// 月日表示, 农历: 正月初九, 阳历: 1月9号
    pub month_day_str: String,
}

fn lunar2solar(
    year: u16,
    month: u8,
    leap: bool,
    day: u8,
) -> Result<(u16, u8, u8, String), LunisolarError> {
    let lunisolar_date = LunisolarDate::from_ymd(year, month, leap, day)?;
    let solar = lunisolar_date.to_solar_date();
    let y = solar.get_solar_year().to_u16();
    let m = solar.get_solar_month().to_u8();
    let d = solar.get_solar_day().to_u8();
    let zodiac = lunisolar_date
        .get_lunisolar_year()
        .get_zodiac()
        .to_str(ChineseVariant::Simple)
        .to_string();
    Ok((y, m, d, zodiac))
}

fn get_constellation(month: u32, day: u32) -> &'static str {
    let all = [
        "摩羯座", "水瓶座", "双鱼座", "白羊座", "金牛座", "双子座",
        "巨蟹座", "狮子座", "处女座", "天秤座", "天蝎座", "射手座",
    ];
    let dates = [20, 19, 21, 20, 21, 22, 23, 23, 23, 24, 23, 22];
    if day < dates[(month - 1) as usize] {
        all[(month - 1) as usize]
    } else if month < all.len() as u32 {
        all[month as usize]
    } else {
        all[(month - all.len() as u32) as usize]
    }
}

fn get_week_day_str(date: &NaiveDate) -> &'static str {
    let week_str = [
        "星期一", "星期二", "星期三", "星期四", "星期五", "星期六", "星期日",
    ];
    week_str[date.weekday().num_days_from_monday() as usize]
}

fn get_occur_date(reminder: &DateReminder) -> Result<NaiveDate, Box<dyn std::error::Error>> {
    let today = Local::now().date_naive();
    let mut year = today.year();
    let mut is_leap = false;

    if reminder.is_lunar && reminder.month >= 11 {
        year -= 1;
    }

    loop {
        let occur_date = if reminder.is_lunar {
            match lunar2solar(year as u16, reminder.month as u8, is_leap, reminder.day as u8) {
                Ok((y, m, d, _)) => NaiveDate::from_ymd_opt(y as i32, m as u32, d as u32)
                    .ok_or(format!(
                        "{}-{:02}-{:02} is not valid ymd",
                        year, reminder.month, reminder.day
                    ))?,
                Err(_) => today
                    .checked_sub_days(Days::new(1))
                    .ok_or("invalid date")?,
            }
        } else {
            NaiveDate::from_ymd_opt(year, reminder.month, reminder.day).ok_or(format!(
                "{}-{:02}-{:02} is not valid ymd",
                year, reminder.month, reminder.day
            ))?
        };

        if occur_date < today {
            if reminder.is_lunar && !is_leap {
                is_leap = true;
            } else {
                year += 1;
                is_leap = false;
            }
        } else {
            return Ok(occur_date);
        }
    }
}

pub fn calc_summary(reminder: &DateReminder) -> Result<SummaryOutput, Box<dyn std::error::Error>> {
    let today = Local::now().date_naive();
    let occur_date = get_occur_date(reminder)?;

    let next_occur_date_string = occur_date.format("%Y-%m-%d").to_string();
    let next_occur_timestamp = occur_date
        .and_hms_opt(0, 0, 0)
        .ok_or("invalid hms")?
        .and_utc()
        .timestamp();
    let remaining_days = occur_date.signed_duration_since(today).num_days();
    let week_day = get_week_day_str(&occur_date).to_string();

    // 星座
    let constellation = if reminder.is_lunar {
        if let Some(year) = reminder.year {
            lunar2solar(year as u16, reminder.month as u8, reminder.is_leap, reminder.day as u8)
                .ok()
                .map(|(_, m, d, _)| get_constellation(m as u32, d as u32).to_string())
        } else {
            None
        }
    } else {
        Some(get_constellation(reminder.month, reminder.day).to_string())
    };

    // 月日表示
    let month_day_str = if !reminder.is_lunar {
        format!("{}月{}日", reminder.month, reminder.day)
    } else {
        LunisolarDate::from_ymd(
            today.year() as u16,
            reminder.month as u8,
            false,
            reminder.day as u8,
        )
        .map(|l| {
            format!(
                "{}{}",
                l.get_lunar_month().to_str(ChineseVariant::Simple),
                l.get_lunar_day().to_str()
            )
        })
        .unwrap_or_else(|_| format!("农历{}月{}日", reminder.month, reminder.day))
    };

    // 年龄、天数、生肖
    let mut days = None;
    let mut age = None;
    let mut chinese_zodiac = None;

    if let Some(year) = reminder.year {
        let start = if reminder.is_lunar {
            let (y, m, d, zodiac) =
                lunar2solar(year as u16, reminder.month as u8, reminder.is_leap, reminder.day as u8)?;
            chinese_zodiac = Some(zodiac);
            NaiveDate::from_ymd_opt(y as i32, m as u32, d as u32).ok_or("invalid date")?
        } else {
            let solar_date = SolarDate::from_ymd(year as u16, reminder.month as u8, reminder.day as u8)?;
            let lunar = solar_date.to_lunisolar_date()?;
            chinese_zodiac = Some(lunar.get_lunisolar_year().get_zodiac().to_string());
            NaiveDate::from_ymd_opt(year, reminder.month, reminder.day).ok_or("invalid date")?
        };

        let diff = today.signed_duration_since(start).num_days();
        if diff > 0 {
            days = Some(diff + 1);
            age = Some(today.year() - year);
        }
    }

    let date_type = match reminder.date_type {
        crate::model::DateType::Birthday => "Birthday".to_string(),
        crate::model::DateType::Commemoration => "Commemoration".to_string(),
    };

    Ok(SummaryOutput {
        name: reminder.name.clone(),
        date_type,
        is_lunar: reminder.is_lunar,
        month: reminder.month,
        day: reminder.day,
        year: reminder.year,
        days,
        next_occur_timestamp,
        next_occur_date_string,
        chinese_zodiac,
        constellation,
        remaining_days,
        age,
        week_day,
        month_day_str,
    })
}

pub fn calc_all_summaries(
    reminders: &[DateReminder],
) -> Result<Vec<SummaryOutput>, Box<dyn std::error::Error>> {
    let mut results: Vec<SummaryOutput> = reminders
        .iter()
        .filter_map(|r| match calc_summary(r) {
            Ok(s) => Some(s),
            Err(e) => {
                eprintln!("跳过 '{}': {}", r.name, e);
                None
            }
        })
        .collect();
    results.sort_by_key(|x| x.next_occur_timestamp);
    Ok(results)
}
