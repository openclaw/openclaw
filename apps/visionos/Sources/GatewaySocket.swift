//
//  GatewaySocket.swift
//  visionOS-node
//
//  OpenClaw visionOS Node — LOAM STUDIO
//
//  Manages the persistent WebSocket connection to the OpenClaw Gateway.
//  Uses URLSessionWebSocketTask wrapped in Swift Concurrency so frame
//  ingestion never blocks the main/rendering thread.
//

import Foundation

// MARK: - Frame types

enum GatewayFrame {
    case event(type: String, payload: [String: Any])
    case request(id: String, method: String, params: [String: Any])
    case response(id: String, ok: Bool, payload: [String: Any]?, error: [String: Any]?)
    case unknown([String: Any])
}

// MARK: - Socket delegate

protocol GatewaySocketDelegate: AnyObject {
    func socketDidConnect(_ socket: GatewaySocket)
    func socketDidDisconnect(_ socket: GatewaySocket, error: Error?)
    func socketDidReceiveChallenge(_ socket: GatewaySocket, nonce: String, ts: String)
    func socketDidReceiveHelloOk(_ socket: GatewaySocket)
    func socketDidReceiveHandshakeError(_ socket: GatewaySocket, code: String, message: String)
    func socketDidReceiveFrame(_ socket: GatewaySocket, frame: GatewayFrame)
}

// MARK: - GatewaySocket

final class GatewaySocket: NSObject {

    weak var delegate: GatewaySocketDelegate?

    private var task: URLSessionWebSocketTask?
    private var urlSession: URLSession?
    private var receiveTask: Task<Void, Never>?

    var isConnected = false

    // MARK: Connect

    func connect(to url: URL) {
        disconnect()

        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 30
        urlSession = URLSession(configuration: config, delegate: self, delegateQueue: nil)
        task = urlSession?.webSocketTask(with: url)
        task?.resume()
        startReceiving()
    }

    // MARK: Exit frame (graceful disconnect)

    /// Sends a `node.event` exit notification before closing, so the gateway
    /// distinguishes a clean disconnect from an unexpected drop.
    func sendExitFrame() async {
        guard isConnected, task != nil else { return }
        let frame: [String: Any] = [
            "type": "req",
            "id": UUID().uuidString.lowercased(),
            "method": "node.event",
            "params": [
                "event": "disconnect",
                "payloadJSON": "{\"reason\":\"clean-shutdown\"}"
            ]
        ]
        do {
            try await send(frame)
            // Brief wait to let the gateway process the exit frame before we close the socket.
            try await Task.sleep(nanoseconds: 300_000_000)
        } catch {
            // Best-effort — socket may already be gone, proceed to close regardless.
        }
    }

    // MARK: Disconnect

    func disconnect() {
        receiveTask?.cancel()
        receiveTask = nil
        task?.cancel(with: .normalClosure, reason: nil)
        task = nil
        urlSession?.invalidateAndCancel()
        urlSession = nil
        isConnected = false
    }

    // MARK: Send

    func send(_ dict: [String: Any]) async throws {
        guard let task else { throw GatewayError.notConnected }
        let data = try JSONSerialization.data(withJSONObject: dict)
        guard let text = String(data: data, encoding: .utf8) else { throw GatewayError.encodingError }
        try await task.send(.string(text))
    }

    // MARK: Receive loop

    private func startReceiving() {
        receiveTask = Task { [weak self] in
            guard let self else { return }
            while !Task.isCancelled {
                do {
                    guard let task = self.task else { break }
                    let message = try await task.receive()
                    switch message {
                    case .string(let text):
                        self.handleText(text)
                    case .data(let data):
                        if let text = String(data: data, encoding: .utf8) {
                            self.handleText(text)
                        }
                    @unknown default:
                        break
                    }
                } catch {
                    if !Task.isCancelled {
                        self.isConnected = false
                        self.delegate?.socketDidDisconnect(self, error: error)
                    }
                    break
                }
            }
        }
    }

    // MARK: Frame parsing

    private func handleText(_ text: String) {
        guard let data = text.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return
        }

        // Log raw frame type for debugging
        print("[GatewaySocket] RX: \(text.prefix(200))")

        let type = json["type"] as? String ?? ""

        switch type {
        case "connect.challenge":
            // Legacy bare frame (kept for compatibility)
            let nonce = json["nonce"] as? String ?? ""
            let ts = (json["ts"] as? Int).map(String.init) ?? (json["ts"] as? String ?? "")
            delegate?.socketDidReceiveChallenge(self, nonce: nonce, ts: ts)

        case "hello-ok":
            // Legacy bare frame (kept for compatibility)
            delegate?.socketDidReceiveHelloOk(self)

        case "res":
            // Protocol v3: connect response → { type:"res", ok:true, payload:{ type:"hello-ok" } }
            let ok = json["ok"] as? Bool ?? false
            let payload = json["payload"] as? [String: Any] ?? [:]
            let payloadType = payload["type"] as? String ?? ""
            if ok && (payloadType == "hello-ok" || payloadType == "connect.ok") {
                delegate?.socketDidReceiveHelloOk(self)
            } else if !ok {
                // Surface error details so NodeManager can show them in the UI log
                let error = json["error"] as? [String: Any] ?? payload
                let code = error["code"] as? String ?? "UNKNOWN"
                // Check nested error.details for richer diagnostic codes
                let details = error["details"] as? [String: Any] ?? [:]
                let detailCode = details["code"] as? String ?? ""
                let reason = details["reason"] as? String ?? ""
                let message = error["message"] as? String
                    ?? error["detail"] as? String
                    ?? (detailCode.isEmpty ? code : "\(code) · \(detailCode): \(reason)")
                delegate?.socketDidReceiveHandshakeError(self, code: code, message: message)
            }
            // Other res frames (RPC replies) are not currently handled

        case "event":
            let eventType = json["event"] as? String ?? ""
            let payload = json["payload"] as? [String: Any] ?? [:]

            // Gateway sends: { type:"event", event:"connect.challenge", payload:{ nonce:"…", ts:1234 } }
            if eventType == "connect.challenge" {
                // nonce/ts may be in payload or at top level (both covered)
                let nonce = (payload["nonce"] as? String)
                    ?? (json["nonce"] as? String)
                    ?? ""
                let ts = (payload["ts"] as? Int).map(String.init)
                    ?? (payload["ts"] as? String)
                    ?? (json["ts"] as? Int).map(String.init)
                    ?? (json["ts"] as? String)
                    ?? ""
                delegate?.socketDidReceiveChallenge(self, nonce: nonce, ts: ts)
            } else if eventType == "hello-ok" || eventType == "connect.ok" {
                delegate?.socketDidReceiveHelloOk(self)
            } else {
                delegate?.socketDidReceiveFrame(self, frame: .event(type: eventType, payload: payload))
            }

        case "req":
            let id = json["id"] as? String ?? ""
            let method = json["method"] as? String ?? ""
            let params = json["params"] as? [String: Any] ?? [:]
            delegate?.socketDidReceiveFrame(self, frame: .request(id: id, method: method, params: params))

        default:
            delegate?.socketDidReceiveFrame(self, frame: .unknown(json))
        }
    }
}

// MARK: - URLSessionWebSocketDelegate

extension GatewaySocket: URLSessionWebSocketDelegate {
    func urlSession(_ session: URLSession,
                    webSocketTask: URLSessionWebSocketTask,
                    didOpenWithProtocol protocol: String?) {
        isConnected = true
        delegate?.socketDidConnect(self)
    }

    func urlSession(_ session: URLSession,
                    webSocketTask: URLSessionWebSocketTask,
                    didCloseWith closeCode: URLSessionWebSocketTask.CloseCode,
                    reason: Data?) {
        // Only mark disconnected if we haven't already (e.g. from an explicit disconnect() call).
        // Do not set isConnected = false here — let disconnect() own that flag so sendExitFrame()
        // doesn't race against the delegate callback and attempt writes on a dead socket.
        guard isConnected else { return }
        isConnected = false
        delegate?.socketDidDisconnect(self, error: nil)
    }
}

// MARK: - Errors

enum GatewayError: LocalizedError {
    case notConnected
    case encodingError
    case handshakeFailed(String)

    var errorDescription: String? {
        switch self {
        case .notConnected: return "Not connected to Gateway"
        case .encodingError: return "Failed to encode frame"
        case .handshakeFailed(let reason): return "Handshake failed: \(reason)"
        }
    }
}
