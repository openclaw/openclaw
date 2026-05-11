import Foundation

public enum OpenClawCanvasA2UIAction: Sendable {
    public struct AgentMessageContext: Sendable {
        public struct Session: Sendable {
            public var key: String
            public var surfaceId: String

            public init(key: String, surfaceId: String) {
                self.key = key
                self.surfaceId = surfaceId
            }
        }

        public struct Component: Sendable {
            public var id: String
            public var host: String
            public var instanceId: String

            public init(id: String, host: String, instanceId: String) {
                self.id = id
                self.host = host
                self.instanceId = instanceId
            }
        }

        public var actionName: String
        public var session: Session
        public var component: Component
        public var contextJSON: String?

        public init(actionName: String, session: Session, component: Component, contextJSON: String?) {
            self.actionName = actionName
            self.session = session
            self.component = component
            self.contextJSON = contextJSON
        }
    }

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

    public static func isTalkRealtimeActionName(_ name: String) -> Bool {
        switch name.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
        case "talk.realtime.toggle", "talk.realtime.start", "talk.realtime.stop":
            true
        default:
            false
        }
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

    public static func formatAgentMessage(_ context: AgentMessageContext) -> String {
        let ctxSuffix = context.contextJSON.flatMap { $0.isEmpty ? nil : " ctx=\($0)" } ?? ""
        return [
            "CANVAS_A2UI",
            "action=\(self.sanitizeTagValue(context.actionName))",
            "session=\(self.sanitizeTagValue(context.session.key))",
            "surface=\(self.sanitizeTagValue(context.session.surfaceId))",
            "component=\(self.sanitizeTagValue(context.component.id))",
            "host=\(self.sanitizeTagValue(context.component.host))",
            "instance=\(self.sanitizeTagValue(context.component.instanceId))\(ctxSuffix)",
            "default=update_canvas",
        ].joined(separator: " ")
    }

    public static func jsDispatchA2UIActionStatus(
        actionId: String,
        ok: Bool,
        error: String?,
        state: String? = nil,
        message: String? = nil)
        -> String
    {
        var payload: [String: Any] = [
            "id": actionId,
            "ok": ok,
            "error": error ?? "",
        ]
        if let state {
            payload["state"] = state
        }
        if let message {
            payload["message"] = message
        }
        let json: String = {
            if let data = try? JSONSerialization.data(withJSONObject: payload, options: []),
               let str = String(data: data, encoding: .utf8)
            {
                return str
            }
            return "{\"id\":\"\(actionId)\",\"ok\":\(ok ? "true" : "false"),\"error\":\"\"}"
        }()
        return """
        (() => {
          const detail = \(json);
          window.dispatchEvent(new CustomEvent('openclaw:a2ui-action-status', { detail }));
        })();
        """
    }

    public static func jsDispatchLiveThomasStatus(_ status: CanvasRealtimeTalkStatus) -> String {
        var payload: [String: Any] = [
            "ok": status.ok,
            "state": status.state,
            "message": status.message ?? "",
            "provider": status.provider ?? "",
            "model": status.model ?? "",
            "voice": status.voice ?? "",
        ]
        if let data = try? JSONSerialization.data(withJSONObject: payload, options: []),
           let str = String(data: data, encoding: .utf8)
        {
            return """
            (() => {
              const detail = \(str);
              window.dispatchEvent(new CustomEvent('openclaw:live-thomas-status', { detail }));
            })();
            """
        }
        payload["message"] = ""
        return """
        (() => {
          window.dispatchEvent(new CustomEvent('openclaw:live-thomas-status', {
            detail: { ok: \(status.ok ? "true" : "false"), state: "\(status.state)" }
          }));
        })();
        """
    }
}
