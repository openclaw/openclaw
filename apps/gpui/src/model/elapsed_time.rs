//! Matches the Control UI elapsed-time and format-duration owners.
#[derive(Clone, Copy)]
pub enum ElapsedFormat {
    Compact,
    MinuteCompact,
    SingleUnit,
    Run,
}

pub fn format_elapsed(ms: u64, format: ElapsedFormat) -> String {
    let ms = u128::from(ms);
    let (rounded, count) = match format {
        ElapsedFormat::Run => {
            let seconds = ms / 1_000;
            return if seconds >= 3_600 {
                format!("{}h {}m", seconds / 3_600, seconds % 3_600 / 60)
            } else if seconds >= 60 {
                format!("{}m {}s", seconds / 60, seconds % 60)
            } else if ms >= 1_000 {
                format!("{seconds}s")
            } else {
                format!("{ms}ms")
            };
        }
        ElapsedFormat::MinuteCompact => (ms.max(60_000) / 60_000 * 60_000, 2),
        ElapsedFormat::Compact => (round_to(ms.max(1_000), 1_000), 2),
        ElapsedFormat::SingleUnit => {
            let ms = ms.max(1_000);
            let mut scale = 1;
            for next in [1_000, 60_000, 3_600_000, 86_400_000] {
                if round_to(ms, scale) < next {
                    break;
                }
                scale = next;
            }
            (round_to(ms, scale), 1)
        }
    };
    let mut remainder = rounded;
    let mut parts = Vec::new();
    for (unit, suffix) in [
        (86_400_000, "d"),
        (3_600_000, "h"),
        (60_000, "m"),
        (1_000, "s"),
    ] {
        let value = remainder / unit;
        remainder %= unit;
        if value > 0 {
            parts.push(format!("{value}{suffix}"));
            if parts.len() == count {
                break;
            }
        }
    }
    parts.join(" ")
}

fn round_to(ms: u128, unit: u128) -> u128 {
    (ms + unit / 2) / unit * unit
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn elapsed_labels_preserve_web_compound_units_and_single_unit_rounding() {
        for (ms, format, expected) in [
            (10_680_999, ElapsedFormat::MinuteCompact, "2h 58m"),
            (9_300_000, ElapsedFormat::Compact, "2h 35m"),
            (7_205_000, ElapsedFormat::Compact, "2h 5s"),
            (59_500, ElapsedFormat::Compact, "1m"),
            (9_300_000, ElapsedFormat::SingleUnit, "3h"),
            (59_500, ElapsedFormat::SingleUnit, "1m"),
            (0, ElapsedFormat::Compact, "1s"),
            (0, ElapsedFormat::MinuteCompact, "1m"),
            (0, ElapsedFormat::Run, "0ms"),
            (59_999, ElapsedFormat::Run, "59s"),
            (60_000, ElapsedFormat::Run, "1m 0s"),
            (86_400_000, ElapsedFormat::Run, "24h 0m"),
        ] {
            assert_eq!(format_elapsed(ms, format), expected);
        }
    }
}
