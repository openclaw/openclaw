public enum TalkTTSValidation: Sendable {
    private static let v3StabilityValues: Set<Double> = [0.0, 0.5, 1.0]

    public static func resolveSpeed(speed: Double?, rateWPM: Int?) -> Double? {
        if let rateWPM, rateWPM > 0 {
            let resolved = Double(rateWPM) / 175.0
            if resolved <= 0.5 || resolved >= 2.0 { return nil }
            return resolved
        }
        if let speed {
            if speed <= 0.5 || speed >= 2.0 { return nil }
            return speed
        }
        return nil
    }

    public static func validatedUnit(_ value: Double?) -> Double? {
        guard let value else { return nil }
        if value < 0 || value > 1 { return nil }
        return value
    }

    public static func validatedStability(_ value: Double?, modelId: String?) -> Double? {
        guard let value else { return nil }
        let normalizedModel = (modelId ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if normalizedModel == "eleven_v3" {
            return v3StabilityValues.contains(value) ? value : nil
        }
        return validatedUnit(value)
    }

    public static func validatedSeed(_ value: Int?) -> UInt32? {
        guard let value else { return nil }
        if value < 0 || value > 4294967295 { return nil }
        return UInt32(value)
    }

    public static func validatedLatencyTier(_ value: Int?) -> Int? {
        guard let value else { return nil }
        if value < 0 || value > 4 { return nil }
        return value
    }

    public static func pcmSampleRate(from outputFormat: String?) -> Double? {
        let trimmed = (outputFormat ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard trimmed.hasPrefix("pcm_") else { return nil }
        let parts = trimmed.split(separator: "_", maxSplits: 1)
        guard parts.count == 2, let rate = Double(parts[1]), rate > 0 else { return nil }
        return rate
    }
}
