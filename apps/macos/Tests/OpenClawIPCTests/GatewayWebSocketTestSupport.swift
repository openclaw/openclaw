import OpenClawKit
import Foundation

extension WebSocketTasking {
    // Keep unit-test doubles resilient to protocol additions.
    func sendPing(pongReceiveHandler: @escaping @Sendable (Error?) -> Void) {
        pongReceiveHandler(nil)
    }
}

enum GatewayWebSocketTestSupport {
    static func connectRequestID(from message: URLSessionWebSocketTask.Message) -> String? {
        let data: Data? = switch message {
        case let .data(d): d
        case let .string(s): s.data(using: .utf8)
        @unknown default: nil
        }
        guard let data else { return nil }
        guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return nil
        }
        guard (obj["type"] as? String) == "req", (obj["method"] as? String) == "connect" else {
            return nil
        }
        return obj["id"] as? String
    }

    static func connectOkData(id: String) -> Data {
        let json = """
        {
          "type": "res",
          "id": "\(id)",
          "ok": true,
          "payload": {
            "type": "hello-ok",
            "protocol": 2,
            "server": { "version": "test", "connId": "test" },
            "features": { "methods": [], "events": [] },
            "snapshot": {
              "presence": [ { "ts": 1 } ],
              "health": {},
              "stateVersion": { "presence": 0, "health": 0 },
              "uptimeMs": 0
            },
            "policy": { "maxPayload": 1, "maxBufferedBytes": 1, "tickIntervalMs": 30000 }
          }
        }
        """
        return Data(json.utf8)
    }

    static func okResponseData(id: String) -> Data {
        let json = """
        {
          "type": "res",
          "id": "\(id)",
          "ok": true,
          "payload": { "ok": true }
        }
        """
        return Data(json.utf8)
    }
}
