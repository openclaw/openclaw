import Foundation
import Synchronization

final class ManualTestClock: Clock, Sendable {
    typealias Instant = ContinuousClock.Instant
    typealias Duration = Swift.Duration

    private struct Sleep {
        let deadline: Instant
        let registration: UInt64
        let continuation: CheckedContinuation<Void, any Error>
    }

    private struct State {
        var now = ContinuousClock.now
        var registrations: UInt64 = 0
        var sleeps: [UUID: Sleep] = [:]
        var admissions: [(deadline: Instant, after: UInt64, gate: AsyncTestGate)] = []
    }

    private let state = Mutex(State())

    var now: Instant {
        self.state.withLock { $0.now }
    }

    var minimumResolution: Duration {
        .nanoseconds(1)
    }

    var sleepRegistrations: UInt64 {
        self.state.withLock { $0.registrations }
    }

    func sleep(until deadline: Instant, tolerance: Duration?) async throws {
        let id = UUID()
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                let (result, gates) = self.state.withLock { state -> (Result<Void, any Error>?, [AsyncTestGate]) in
                    guard !Task.isCancelled else { return (.failure(CancellationError()), []) }
                    guard deadline > state.now else { return (.success(()), []) }
                    state.registrations += 1
                    let registration = state.registrations
                    state.sleeps[id] = Sleep(
                        deadline: deadline, registration: registration, continuation: continuation)
                    let admitted = { (admission: (deadline: Instant, after: UInt64, gate: AsyncTestGate)) in
                        admission.deadline == deadline && admission.after < registration
                    }
                    let gates = state.admissions.filter(admitted).map(\.gate)
                    state.admissions.removeAll(where: admitted)
                    return (nil, gates)
                }
                gates.forEach { $0.open() }
                if let result { continuation.resume(with: result) }
            }
        } onCancel: {
            let sleep = self.state.withLock { $0.sleeps.removeValue(forKey: id) }
            sleep?.continuation.resume(throwing: CancellationError())
        }
    }

    func waitForSleep(until deadline: Instant, after registration: UInt64 = 0) async {
        let gate = AsyncTestGate()
        let admitted = self.state.withLock { state in
            if state.sleeps.values.contains(where: { $0.deadline == deadline && $0.registration > registration }) {
                return true
            }
            state.admissions.append((deadline, registration, gate))
            return false
        }
        if admitted { gate.open() }
        await gate.wait()
    }

    func advance(by duration: Duration) {
        precondition(duration >= .zero)
        let ready = self.state.withLock { state in
            state.now = state.now.advanced(by: duration)
            let ready = state.sleeps.filter { $0.value.deadline <= state.now }
            for id in ready.keys {
                state.sleeps.removeValue(forKey: id)
            }
            return ready.values.map(\.continuation)
        }
        ready.forEach { $0.resume() }
    }
}
