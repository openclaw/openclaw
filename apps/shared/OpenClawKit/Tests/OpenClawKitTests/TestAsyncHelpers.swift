import Observation

/// Wakes on observed view-model mutations instead of a wall-clock deadline, for work no handle can reach.
@MainActor
func waitForObservedState(_ condition: @escaping @MainActor () -> Bool) async {
    while !condition() {
        await withCheckedContinuation { continuation in
            withObservationTracking { _ = condition() } onChange: { continuation.resume() }
        }
    }
}
