import Foundation
import HealthKit

// MARK: - HealthWorkoutActivityName

/// Maps `HKWorkoutActivityType` to a stable, human-readable name for the workout `name` field.
/// Deliberately limited to the common activity types; everything else falls back to "Workout"
/// so we never leak an unexpected raw value.
enum HealthWorkoutActivityName {
    private static let labels: [HKWorkoutActivityType: String] = [
        .running: "Running",
        .walking: "Walking",
        .cycling: "Cycling",
        .hiking: "Hiking",
        .swimming: "Swimming",
        .yoga: "Yoga",
        .functionalStrengthTraining: "Functional Strength Training",
        .traditionalStrengthTraining: "Strength Training",
        .highIntensityIntervalTraining: "HIIT",
        .elliptical: "Elliptical",
        .rowing: "Rowing",
        .stairClimbing: "Stair Climbing",
        .stairs: "Stair Climbing",
        .coreTraining: "Core Training",
        .pilates: "Pilates",
        .dance: "Dance",
        .cardioDance: "Dance",
        .socialDance: "Dance",
        .mixedCardio: "Mixed Cardio",
        .jumpRope: "Jump Rope",
        .tennis: "Tennis",
        .basketball: "Basketball",
        .soccer: "Soccer",
        .golf: "Golf",
    ]

    static func label(for activityType: HKWorkoutActivityType) -> String {
        self.labels[activityType] ?? "Workout"
    }
}
