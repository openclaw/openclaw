public enum TalkTTSValidation: Sendable {
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

    public static func validatedSeed(_ value: Int?) -> UInt32? {
        guard let value else { return nil }
        if value < 0 || value > 4294967295 { return nil }
        return UInt32(value)
    }
}

