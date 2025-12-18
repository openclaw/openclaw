import Foundation

public enum ClawdisCanvasCommand: String, Codable, Sendable {
    case show = "canvas.show"
    case hide = "canvas.hide"
    case setMode = "canvas.setMode"
    case navigate = "canvas.navigate"
    case evalJS = "canvas.eval"
    case snapshot = "canvas.snapshot"
}

public enum ClawdisInvokeCommandAliases {
    public static func canonicalizeCanvasToScreen(_ command: String) -> String {
        if command.hasPrefix(ClawdisCanvasCommand.namespacePrefix) {
            return ClawdisScreenCommand.namespacePrefix +
                command.dropFirst(ClawdisCanvasCommand.namespacePrefix.count)
        }
        return command
    }
}

extension ClawdisCanvasCommand {
    public static var namespacePrefix: String { "canvas." }
}

extension ClawdisScreenCommand {
    public static var namespacePrefix: String { "screen." }
}
