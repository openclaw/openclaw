import Foundation

/// What a person pastes to join a claw: the bare `openclaw-node://join#…` link, or the owner's
/// full `openclaw node join '<link>' --discovery-url <origin>` command (with or without `npx`).
/// Only the link and an explicit Discovery origin are taken; nothing else in the text is run.
struct OnboardingNodeInvitationInput: Equatable {
    let link: String
    let discoveryOrigin: String?

    init(_ text: String) throws {
        let tokens = Self.tokens(text)
        guard let link = tokens.first(where: { $0.hasPrefix("openclaw-node://join#") }) else {
            throw OpenClawIDNodeInvitationInputError.missingLink
        }
        self.link = link
        var origin: String?
        for (index, token) in tokens.enumerated() {
            for flag in ["--discovery-url", "--discovery"] {
                if token == flag, index + 1 < tokens.count {
                    origin = tokens[index + 1]
                } else if token.hasPrefix(flag + "=") {
                    origin = String(token.dropFirst(flag.count + 1))
                }
            }
        }
        self.discoveryOrigin = origin
    }

    /// Splits like a POSIX shell for the quoting the Control UI emits: single quotes (with the
    /// `'\''` escape), double quotes and whitespace. A token is never interpreted beyond that.
    private static func tokens(_ text: String) -> [String] {
        var tokens: [String] = []
        var current = ""
        var inToken = false
        var quote: Character?
        var escaped = false
        for character in text {
            if escaped {
                current.append(character)
                escaped = false
            } else if let open = quote {
                if character == open { quote = nil } else { current.append(character) }
            } else if character == "\\" {
                escaped = true
                inToken = true
            } else if character == "'" || character == "\"" {
                quote = character
                inToken = true
            } else if character.isWhitespace {
                if inToken { tokens.append(current) }
                current = ""
                inToken = false
            } else {
                current.append(character)
                inToken = true
            }
        }
        if inToken { tokens.append(current) }
        return tokens
    }
}

enum OpenClawIDNodeInvitationInputError: Error {
    case missingLink
}
