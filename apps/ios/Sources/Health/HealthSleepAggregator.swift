import Foundation
import HealthKit

// MARK: - HealthSleepAggregator

/// Aggregates raw `HKCategorySample` sleep-analysis intervals into a single numeric metric:
/// minutes asleep per night. Only intervals whose value is one of the `asleep*` cases count;
/// `inBed`/`awake` are ignored so the exported number reflects actual sleep, not time in bed.
enum HealthSleepAggregator {
    /// Groups asleep intervals by "night" and returns one `HealthMetricSample` per night with
    /// `qty` = total minutes asleep and `date` = the night's wake (latest interval end) in UTC.
    static func minutesAsleepPerNight(from samples: [HKCategorySample]) -> [HealthMetricSample] {
        let asleep = samples.filter { Self.isAsleep($0.value) }
        guard !asleep.isEmpty else { return [] }

        // Bucket by the calendar day of the night. A "sleep night" is keyed on the day the sleep
        // STARTED so a session crossing midnight stays in one bucket. We use a UTC calendar to
        // keep bucketing deterministic and aligned with the UTC timestamps we emit.
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC") ?? calendar.timeZone

        struct NightAccumulator {
            var seconds: Double = 0
            var latestEnd: Date
        }

        var nights: [Date: NightAccumulator] = [:]
        for sample in asleep {
            // Shift the start back 12h before taking the day, so an evening-start session and the
            // post-midnight continuation share the same night key.
            let shiftedStart = sample.startDate.addingTimeInterval(-12 * 60 * 60)
            let nightKey = calendar.startOfDay(for: shiftedStart)
            let seconds = sample.endDate.timeIntervalSince(sample.startDate)
            guard seconds > 0 else { continue }
            if var existing = nights[nightKey] {
                existing.seconds += seconds
                if sample.endDate > existing.latestEnd { existing.latestEnd = sample.endDate }
                nights[nightKey] = existing
            } else {
                nights[nightKey] = NightAccumulator(seconds: seconds, latestEnd: sample.endDate)
            }
        }

        return nights
            .map { _, accumulator in
                HealthMetricSample(
                    quantity: (accumulator.seconds / 60.0).rounded(),
                    date: HealthExportDateFormatter.string(from: accumulator.latestEnd))
            }
            .sorted { $0.date < $1.date }
    }

    /// True for the `asleep*` sleep-analysis values (Core, Deep, REM, or the legacy `asleep`).
    private static func isAsleep(_ rawValue: Int) -> Bool {
        guard let value = HKCategoryValueSleepAnalysis(rawValue: rawValue) else { return false }
        switch value {
        case .asleepUnspecified, .asleepCore, .asleepDeep, .asleepREM:
            return true
        case .inBed, .awake:
            return false
        @unknown default:
            return false
        }
    }
}
