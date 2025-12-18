import Foundation

public enum ClawdisCanvasCommand: String, Codable, Sendable {
    case show = "canvas.show"
    case hide = "canvas.hide"
    case navigate = "canvas.navigate"
    case evalJS = "canvas.eval"
    case snapshot = "canvas.snapshot"
}
