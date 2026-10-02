import CryptoKit
import Foundation
import Vision

enum Anchor {
    case text(String)
    case line(String)
    case decision(String)

    var value: String {
        switch self {
        case let .text(value), let .line(value), let .decision(value): value
        }
    }

    func matches(_ lines: [String]) -> Bool {
        switch self {
        case let .text(value): return lines.joined(separator: " ").contains(value)
        case let .line(value): return lines.contains(value)
        case let .decision(value):
            // Vision can include the review button's checkmark/xmark in its primary line.
            // Accept only these observed whole labels, never arbitrary prefixes or prose.
            let icon: String
            switch value {
            case "Allow once", "Always allow": icon = "V"
            case "Deny": icon = "X"
            default: return false
            }
            return lines.contains(value) || lines.contains("\(icon) \(value)")
        }
    }
}

enum Scenario: String {
    case payment
    case paymentTerms = "payment-terms"
    case standingGrant = "standing-grant"
    case standingGrantTerms = "standing-grant-terms"
    case unsupportedContext = "unsupported-context"
    case creationFailed = "creation-failed"
    case creationUnknown = "creation-unknown"
    case creationSucceeded = "creation-succeeded"
    case noConversation = "no-conversation"

    var visible: [Anchor] {
        switch self {
        case .payment, .standingGrant:
            [.text("Approvals"), .text("Review request"), .text("Confirm the terms below.")]
        case .paymentTerms:
            [.line("Pending"), .decision("Allow once"), .decision("Deny")]
        case .standingGrantTerms:
            [.line("Pending"), .decision("Always allow"), .decision("Deny")]
        case .unsupportedContext:
            [
                .text("Unsupported approval context: Visibility."),
                .text("Review on the Gateway before allowing."),
                .line("Pending"), .decision("Deny"),
            ]
        case .creationFailed:
            [.text("Conversations"), .text(Self.failed), .text("New conversation")]
        case .creationUnknown:
            [
                .text("Conversations"),
                .text("Delivery uncertain. Check the original conversation before sending again."),
                .text("New conversation"),
            ]
        case .creationSucceeded:
            [.text("Conversations"), .text("Conversation created"), .text("New conversation")]
        case .noConversation:
            [.text("Direct chat"), .text(Self.failed)]
        }
    }

    var pair: Scenario? {
        switch self {
        case .paymentTerms: .payment
        case .standingGrantTerms: .standingGrant
        default: nil
        }
    }

    var semantics: [Anchor] {
        switch self {
        case .paymentTerms:
            [.text("Amount: 149.95 USD"), .text("Pay to: Example Supplier")]
        case .standingGrantTerms:
            [
                .text("Automation: Daily report"),
                .text("Always allow runs this exact command without asking:"),
                .line("report --publish"),
                .text("Expires in 7 days; revocable"),
            ]
        default: []
        }
    }

    private static let failed = "Conversation could not be created. Try again after reconnecting."
}

struct ImageEvidence: Encodable {
    let scenario: String
    let sha256: String
    let recognizedLines: [String]
    let missingVisibleAnchors: [String]
    let unexpectedDecisions: [String]
}

struct Evidence: Encodable {
    let ok: Bool
    let images: [ImageEvidence]
    let missingSemanticAnchors: [String]
}

func recognize(_ path: String, scenario: Scenario) throws -> (ImageEvidence, [String]) {
    // Hash and recognize one immutable byte buffer, not separate reads of a mutable path.
    let data = try Data(contentsOf: URL(fileURLWithPath: path))
    guard data.starts(with: [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]) else {
        throw NSError(domain: "WatchCapture", code: 1, userInfo: [
            NSLocalizedDescriptionKey: "Expected a retained PNG",
        ])
    }
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.recognitionLanguages = ["en-US"]
    request.usesLanguageCorrection = false
    try VNImageRequestHandler(data: data, options: [:]).perform([request])
    // Only the primary candidate counts. Normalize whitespace, never punctuation,
    // digits, command spelling, or negation; hidden terms remain missing evidence.
    let lines = (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }
        .map { $0.split(whereSeparator: \.isWhitespace).joined(separator: " ") }
    let unexpected = scenario == .unsupportedContext
        ? ["Allow once", "Always allow"].filter { Anchor.decision($0).matches(lines) }
        : []
    return (
        ImageEvidence(
            scenario: scenario.rawValue,
            sha256: SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined(),
            recognizedLines: lines,
            missingVisibleAnchors: scenario.visible.filter { !$0.matches(lines) }.map(\.value),
            unexpectedDecisions: unexpected),
        lines)
}

do {
    let arguments = Array(CommandLine.arguments.dropFirst())
    guard arguments.count >= 2, let scenario = Scenario(rawValue: arguments[0]),
          arguments.count == (scenario.pair == nil ? 2 : 3)
    else {
        throw NSError(domain: "WatchCapture", code: 1, userInfo: [
            NSLocalizedDescriptionKey: "Expected scenario PNG and, for terms, the retained overview PNG",
        ])
    }
    let current = try recognize(arguments[1], scenario: scenario)
    var images = [current.0]
    var texts = [current.1]
    if let pair = scenario.pair {
        let previous = try recognize(arguments[2], scenario: pair)
        images.append(previous.0)
        texts.append(previous.1)
    }
    // A complete semantic anchor must be visible in one of the two real images;
    // concatenating fragments across viewports could manufacture absent terms.
    let missing = scenario.semantics.filter { anchor in !texts.contains { anchor.matches($0) } }.map(\.value)
    let evidence = Evidence(
        ok: missing.isEmpty && images.allSatisfy {
            $0.missingVisibleAnchors.isEmpty && $0.unexpectedDecisions.isEmpty
        },
        images: images,
        missingSemanticAnchors: missing)
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
    try FileHandle.standardOutput.write(encoder.encode(evidence))
    FileHandle.standardOutput.write(Data("\n".utf8))
    exit(evidence.ok ? 0 : 1)
} catch {
    FileHandle.standardError.write(Data("Watch capture check failed: \(error.localizedDescription)\n".utf8))
    exit(2)
}
