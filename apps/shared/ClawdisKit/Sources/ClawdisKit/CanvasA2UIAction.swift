import Foundation

public enum ClawdisCanvasA2UIAction: Sendable {
    public static func extractActionName(_ userAction: [String: Any]) -> String? {
        let keys = ["name", "action"]
        for key in keys {
            if let raw = userAction[key] as? String {
                let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
                if !trimmed.isEmpty { return trimmed }
            }
        }
        return nil
    }

    public static func sanitizeTagValue(_ value: String) -> String {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        let nonEmpty = trimmed.isEmpty ? "-" : trimmed
        let normalized = nonEmpty.replacingOccurrences(of: " ", with: "_")
        let allowed = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-.:")
        let scalars = normalized.unicodeScalars.map { allowed.contains($0) ? Character($0) : "_" }
        return String(scalars)
    }

    public static func compactJSON(_ obj: Any?) -> String? {
        guard let obj else { return nil }
        guard JSONSerialization.isValidJSONObject(obj) else { return nil }
        guard let data = try? JSONSerialization.data(withJSONObject: obj, options: []),
              let str = String(data: data, encoding: .utf8)
        else { return nil }
        return str
    }

    public static func formatAgentMessage(
        actionName: String,
        sessionKey: String,
        surfaceId: String,
        sourceComponentId: String,
        host: String,
        instanceId: String,
        contextJSON: String?)
        -> String
    {
        let ctxSuffix = contextJSON.flatMap { $0.isEmpty ? nil : " ctx=\($0)" } ?? ""
        return [
            "CANVAS_A2UI",
            "action=\(self.sanitizeTagValue(actionName))",
            "session=\(self.sanitizeTagValue(sessionKey))",
            "surface=\(self.sanitizeTagValue(surfaceId))",
            "component=\(self.sanitizeTagValue(sourceComponentId))",
            "host=\(self.sanitizeTagValue(host))",
            "instance=\(self.sanitizeTagValue(instanceId))\(ctxSuffix)",
            "default=update_canvas",
        ].joined(separator: " ")
    }

    public static func jsDispatchA2UIActionStatus(actionId: String, ok: Bool, error: String?) -> String {
        let payload: [String: Any] = [
            "id": actionId,
            "ok": ok,
            "error": error ?? "",
        ]
        let json: String = {
            if let data = try? JSONSerialization.data(withJSONObject: payload, options: []),
               let str = String(data: data, encoding: .utf8)
            {
                return str
            }
            return "{\"id\":\"\(actionId)\",\"ok\":\(ok ? "true" : "false"),\"error\":\"\"}"
        }()
        return "window.dispatchEvent(new CustomEvent('clawdis:a2ui-action-status', { detail: \(json) }));"
    }
}
