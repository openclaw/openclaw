import CoreMotion
import Foundation
import OpenClawKit

/// The Core Motion activity query, injectable so tests can supply activities the Simulator lacks.
struct MotionActivitySource: Sendable {
    struct Sample: Equatable, Sendable {
        var startDate: Date
        var confidence: CMMotionActivityConfidence
        var walking = false
        var running = false
        var cycling = false
        var automotive = false
        var stationary = false
        var unknown = false
    }

    var isAvailable: @Sendable () -> Bool
    var authorizationStatus: @Sendable () -> CMAuthorizationStatus
    var query: @Sendable (_ start: Date, _ end: Date) async throws -> [Sample]

    static let live = MotionActivitySource(
        isAvailable: { CMMotionActivityManager.isActivityAvailable() },
        authorizationStatus: { CMMotionActivityManager.authorizationStatus() },
        query: { start, end in
            let manager = CMMotionActivityManager()
            return try await withCheckedThrowingContinuation { cont in
                manager.queryActivityStarting(from: start, to: end, to: OperationQueue()) { activity, error in
                    if let error {
                        cont.resume(throwing: error)
                    } else {
                        cont.resume(returning: (activity ?? []).map(Sample.init))
                    }
                }
            }
        })
}

extension MotionActivitySource.Sample {
    init(_ activity: CMMotionActivity) {
        self.init(
            startDate: activity.startDate,
            confidence: activity.confidence,
            walking: activity.walking,
            running: activity.running,
            cycling: activity.cycling,
            automotive: activity.automotive,
            stationary: activity.stationary,
            unknown: activity.unknown)
    }
}

final class MotionService: MotionServicing {
    private let activitySource: MotionActivitySource

    init(activitySource: MotionActivitySource = .live) {
        self.activitySource = activitySource
    }

    func activities(params: OpenClawMotionActivityParams) async throws -> OpenClawMotionActivityPayload {
        guard self.activitySource.isAvailable() else {
            throw NSError(domain: "Motion", code: 1, userInfo: [
                NSLocalizedDescriptionKey: "MOTION_UNAVAILABLE: activity not supported on this device",
            ])
        }
        guard Self.allowsMotionQuery(self.activitySource.authorizationStatus()) else {
            throw NSError(domain: "Motion", code: 3, userInfo: [
                NSLocalizedDescriptionKey: "MOTION_PERMISSION_REQUIRED: grant Motion & Fitness permission",
            ])
        }

        let (start, end) = Self.resolveRange(startISO: params.startISO, endISO: params.endISO)
        let limit = max(1, min(params.limit ?? 200, 1000))

        let activity = try await self.activitySource.query(start, end)
        let formatter = ISO8601DateFormatter()
        let recent = activity.sorted { $0.startDate < $1.startDate }.suffix(limit)
        let endDates = Self.activityEndDates(
            startDates: recent.map(\.startDate),
            queryEnd: end)
        let mapped = zip(recent, endDates).map { entry, entryEnd in
            OpenClawMotionActivityEntry(
                startISO: formatter.string(from: entry.startDate),
                endISO: formatter.string(from: entryEnd),
                confidence: Self.confidenceString(entry.confidence),
                isWalking: entry.walking,
                isRunning: entry.running,
                isCycling: entry.cycling,
                isAutomotive: entry.automotive,
                isStationary: entry.stationary,
                isUnknown: entry.unknown)
        }

        return OpenClawMotionActivityPayload(activities: mapped)
    }

    func pedometer(params: OpenClawPedometerParams) async throws -> OpenClawPedometerPayload {
        guard CMPedometer.isStepCountingAvailable() else {
            throw NSError(domain: "Motion", code: 2, userInfo: [
                NSLocalizedDescriptionKey: "PEDOMETER_UNAVAILABLE: step counting not supported",
            ])
        }
        guard Self.allowsMotionQuery(CMPedometer.authorizationStatus()) else {
            throw NSError(domain: "Motion", code: 4, userInfo: [
                NSLocalizedDescriptionKey: "MOTION_PERMISSION_REQUIRED: grant Motion & Fitness permission",
            ])
        }

        let (start, end) = Self.resolveRange(startISO: params.startISO, endISO: params.endISO)
        let pedometer = CMPedometer()
        return try await withCheckedThrowingContinuation { cont in
            pedometer.queryPedometerData(from: start, to: end) { data, error in
                if let error {
                    cont.resume(throwing: error)
                } else {
                    let formatter = ISO8601DateFormatter()
                    let payload = OpenClawPedometerPayload(
                        startISO: formatter.string(from: start),
                        endISO: formatter.string(from: end),
                        steps: data?.numberOfSteps.intValue,
                        distanceMeters: data?.distance?.doubleValue,
                        floorsAscended: data?.floorsAscended?.intValue,
                        floorsDescended: data?.floorsDescended?.intValue)
                    cont.resume(returning: payload)
                }
            }
        }
    }

    static func allowsMotionQuery(_ authorizationStatus: CMAuthorizationStatus) -> Bool {
        switch authorizationStatus {
        case .notDetermined, .authorized:
            // Core Motion only presents its first-use permission prompt when a query runs.
            return true
        case .restricted, .denied:
            return false
        @unknown default:
            return false
        }
    }

    /// CMMotionActivity has only a start date: each activity lasts until the next one starts.
    /// Only the most recent activity runs to the end of the query range.
    /// `startDates` must be in ascending order; the caller sorts the activities first.
    static func activityEndDates(startDates: [Date], queryEnd: Date) -> [Date] {
        startDates.indices.map { index in
            let next = startDates.index(after: index)
            return next < startDates.endIndex ? startDates[next] : max(queryEnd, startDates[index])
        }
    }

    private static func resolveRange(startISO: String?, endISO: String?) -> (Date, Date) {
        let formatter = ISO8601DateFormatter()
        let start = startISO.flatMap { formatter.date(from: $0) } ?? Calendar.current.startOfDay(for: Date())
        let end = endISO.flatMap { formatter.date(from: $0) } ?? Date()
        return (start, end)
    }

    private static func confidenceString(_ confidence: CMMotionActivityConfidence) -> String {
        switch confidence {
        case .low: "low"
        case .medium: "medium"
        case .high: "high"
        @unknown default: "unknown"
        }
    }
}
