use super::now_ms;

pub fn relative_timestamp(timestamp: Option<u64>) -> String {
    timestamp
        .map(|timestamp| relative_time_at(timestamp, now_ms()))
        .unwrap_or_default()
}
fn relative_time_at(timestamp: u64, now: u64) -> String {
    if timestamp > now.saturating_add(120_000) || now.saturating_sub(timestamp) >= 604_800_000 {
        return local_time(timestamp, true);
    }
    let seconds = now.saturating_sub(timestamp) / 1000;
    match seconds {
        0..60 => "Just now".into(),
        60..3600 => format!("{}m ago", seconds / 60),
        3600..86400 => format!("{}h ago", seconds / 3600),
        _ => format!("{}d ago", seconds / 86400),
    }
}
pub fn exact_time(timestamp: u64) -> String {
    local_time(timestamp, false)
}

#[cfg(target_os = "macos")]
fn local_time(timestamp: u64, compact: bool) -> String {
    if timestamp > 8_640_000_000_000_000 {
        return "Unknown date".into();
    }
    use objc2::{class, msg_send, rc::Retained, runtime::AnyObject};
    use objc2_foundation::{NSDate, NSString};
    // Foundation owns locale/time-zone formatting; never mutate process TZ.
    unsafe {
        let formatter: Retained<AnyObject> = msg_send![class!(NSDateFormatter), new];
        let date = NSDate::dateWithTimeIntervalSince1970(timestamp as f64 / 1000.);
        let template = if compact {
            let year = NSString::from_str("yyyy");
            let _: () = msg_send![&*formatter, setDateFormat: &*year];
            let date_year: Retained<NSString> = msg_send![&*formatter, stringFromDate: &*date];
            let now = NSDate::date();
            let current_year: Retained<NSString> = msg_send![&*formatter, stringFromDate: &*now];
            if date_year == current_year {
                "MMM d"
            } else {
                "MMM d yyyy"
            }
        } else {
            "EEEE MMMM d yyyy j:mm:ss z"
        };
        let template = NSString::from_str(template);
        let _: () = msg_send![&*formatter, setLocalizedDateFormatFromTemplate: &*template];
        let result: Retained<NSString> = msg_send![&*formatter, stringFromDate: &*date];
        result.to_string()
    }
}
#[cfg(not(target_os = "macos"))]
fn local_time(timestamp: u64, compact: bool) -> String {
    let seconds = timestamp / 1000;
    let days = (seconds / 86400) as i64 + 719468;
    let era = days / 146097;
    let day_of_era = days - era * 146097;
    let year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36524 - day_of_era / 146096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_prime = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_prime + 2) / 5 + 1;
    let month = month_prime + if month_prime < 10 { 3 } else { -9 };
    let year = year_of_era + era * 400 + i64::from(month <= 2);
    if compact {
        format!("{year:04}-{month:02}-{day:02}")
    } else {
        format!(
            "{year:04}-{month:02}-{day:02} {:02}:{:02}:{:02} UTC",
            seconds / 3600 % 24,
            seconds / 60 % 60,
            seconds % 60
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_near_future_clock_skew_gets_a_relative_label() {
        let now = 1_800_000_000_000;
        assert_eq!(relative_time_at(now + 120_000, now), "Just now");
        assert_ne!(relative_time_at(now + 120_001, now), "Just now");
        assert_eq!(relative_time_at(now - 60_000, now), "1m ago");
        assert_eq!(relative_time_at(now - 6 * 86_400_000, now), "6d ago");
        assert!(!relative_time_at(now - 7 * 86_400_000, now).contains("ago"));
        #[cfg(target_os = "macos")]
        assert_eq!(relative_time_at(u64::MAX, now), "Unknown date");
    }
}
