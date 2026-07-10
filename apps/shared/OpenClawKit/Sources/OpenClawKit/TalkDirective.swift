import Foundation
import OpenClawMobileCore

public struct TalkDirective: Equatable, Sendable {
    public var voiceId: String?
    public var modelId: String?
    public var speed: Double?
    public var rateWPM: Int?
    public var stability: Double?
    public var similarity: Double?
    public var style: Double?
    public var speakerBoost: Bool?
    public var seed: Int?
    public var normalize: String?
    public var language: String?
    public var outputFormat: String?
    public var latencyTier: Int?
    public var once: Bool?

    public init(
        voiceId: String? = nil,
        modelId: String? = nil,
        speed: Double? = nil,
        rateWPM: Int? = nil,
        stability: Double? = nil,
        similarity: Double? = nil,
        style: Double? = nil,
        speakerBoost: Bool? = nil,
        seed: Int? = nil,
        normalize: String? = nil,
        language: String? = nil,
        outputFormat: String? = nil,
        latencyTier: Int? = nil,
        once: Bool? = nil)
    {
        self.voiceId = voiceId
        self.modelId = modelId
        self.speed = speed
        self.rateWPM = rateWPM
        self.stability = stability
        self.similarity = similarity
        self.style = style
        self.speakerBoost = speakerBoost
        self.seed = seed
        self.normalize = normalize
        self.language = language
        self.outputFormat = outputFormat
        self.latencyTier = latencyTier
        self.once = once
    }
}

public struct TalkDirectiveParseResult: Equatable, Sendable {
    public let directive: TalkDirective?
    public let stripped: String
    public let unknownKeys: [String]

    public init(directive: TalkDirective?, stripped: String, unknownKeys: [String]) {
        self.directive = directive
        self.stripped = stripped
        self.unknownKeys = unknownKeys
    }
}

public enum TalkDirectiveParser {
    public static func parse(_ text: String) -> TalkDirectiveParseResult {
        let parsed = MobileCoreBridge.shared.parseTalkDirectiveForApple(text: text)
        return TalkDirectiveParseResult(
            directive: parsed.directive.map(TalkDirective.init(core:)),
            stripped: parsed.stripped,
            unknownKeys: parsed.unknownKeys)
    }
}

private extension TalkDirective {
    init(core: OpenClawMobileCore.TalkDirective) {
        self.init(
            voiceId: core.voiceId,
            modelId: core.modelId,
            speed: core.speed?.doubleValue,
            rateWPM: core.rateWpm?.intValue,
            stability: core.stability?.doubleValue,
            similarity: core.similarity?.doubleValue,
            style: core.style?.doubleValue,
            speakerBoost: core.speakerBoost?.boolValue,
            seed: core.seed.flatMap { Int(exactly: $0.int64Value) },
            normalize: core.normalize,
            language: core.language,
            outputFormat: core.outputFormat,
            latencyTier: core.latencyTier?.intValue,
            once: core.once?.boolValue)
    }
}
