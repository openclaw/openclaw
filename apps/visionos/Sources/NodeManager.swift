//
//  NodeManager.swift
//  visionOS-node
//
//  OpenClaw visionOS Node — LOAM STUDIO
//
//  Central state manager and RPC dispatcher.
//  Drives the connection lifecycle and routes node.invoke commands
//  to the appropriate handler.
//

import Foundation
import SwiftUI
import Combine
import CoreLocation

// MARK: - Connection state

enum NodeConnectionState: String {
    case disconnected   = "Disconnected"
    case connecting     = "Connecting…"
    case challenging    = "Handshaking…"
    case pending        = "Awaiting Gateway Approval"
    case connected      = "Connected"
    case error          = "Error"
}

// MARK: - NodeManager

@MainActor
final class NodeManager: ObservableObject {

    // Published state (drives UI)
    @Published var connectionState: NodeConnectionState = .disconnected
    @Published var gatewayURL: String = ""
    @Published var gatewayToken: String = ""
    @Published var lastError: String?
    @Published var immersiveSpaceActive: Bool = false
    @Published var isBackgrounded: Bool = false
    @Published var commandLog: [String] = []

    // Sub-managers
    let spatialManager = SpatialManager()
    let locationManager = LocationManager()

    var isSocketConnected: Bool { socket.isConnected }

    // Private
    private let socket = GatewaySocket()
    private var reconnectTask: Task<Void, Never>?
    private var reconnectDelay: TimeInterval = 2.0
    private let maxReconnectDelay: TimeInterval = 60.0

    init() {
        socket.delegate = self
        loadConfig()
    }

    // MARK: - Scene phase callbacks

    func onBackground() {
        log("App backgrounded — camera/canvas unavailable")
    }

    func onForeground() {
        log("App foregrounded — resuming")
    }

    // MARK: - Config persistence

    private func loadConfig() {
        if let saved = UserDefaults.standard.string(forKey: "gatewayURL"), !saved.isEmpty {
            gatewayURL = saved
        }
        if let saved = UserDefaults.standard.string(forKey: "gatewayToken"), !saved.isEmpty {
            gatewayToken = saved
        }
    }

    func saveConfig() {
        UserDefaults.standard.set(gatewayURL, forKey: "gatewayURL")
        UserDefaults.standard.set(gatewayToken, forKey: "gatewayToken")
    }

    // MARK: - Connect / Disconnect

    func connect() {
        guard !gatewayURL.isEmpty else {
            lastError = "Gateway URL is required"
            connectionState = .error
            return
        }

        // Normalise: wss:// or ws://
        var urlString = gatewayURL
        if !urlString.hasPrefix("ws://") && !urlString.hasPrefix("wss://") {
            urlString = "wss://\(urlString)"
        }

        guard let url = URL(string: urlString) else {
            lastError = "Invalid gateway URL"
            connectionState = .error
            return
        }

        connectionState = .connecting
        lastError = nil
        log("Connecting to \(url.absoluteString)…")
        socket.connect(to: url)
    }

    func disconnect() {
        reconnectTask?.cancel()
        reconnectTask = nil
        Task {
            await socket.sendExitFrame()
            socket.disconnect()
        }
        connectionState = .disconnected
        log("Disconnected")
    }

    // MARK: - Reconnect (exponential backoff)

    private func scheduleReconnect() {
        reconnectTask?.cancel()
        let delay = reconnectDelay
        reconnectDelay = min(reconnectDelay * 2, maxReconnectDelay)

        reconnectTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
            guard !Task.isCancelled else { return }
            await self?.connect()
        }
        log("Reconnecting in \(Int(delay))s…")
    }

    // MARK: - RPC response helpers

    func sendOK(id: String, payload: [String: Any]) {
        Task {
            try? await socket.send([
                "type": "req",
                "id": UUID().uuidString.lowercased(),
                "method": "node.invoke.result",
                "params": [
                    "id": id,
                    "nodeId": HandshakeManager.deviceID(),
                    "ok": true,
                    "payload": payload
                ] as [String: Any]
            ])
        }
    }

    func sendError(id: String, code: String, detail: String? = nil) {
        Task {
            var err: [String: Any] = ["code": code]
            if let detail { err["detail"] = detail }
            try? await socket.send([
                "type": "req",
                "id": UUID().uuidString.lowercased(),
                "method": "node.invoke.result",
                "params": [
                    "id": id,
                    "nodeId": HandshakeManager.deviceID(),
                    "ok": false,
                    "error": err
                ] as [String: Any]
            ])
        }
    }

    // MARK: - Outbound RPC requests

    func sendRequest(method: String, params: [String: Any]) {
        Task {
            try? await socket.send([
                "type": "req",
                "id": UUID().uuidString.lowercased(),
                "method": method,
                "params": params
            ])
        }
    }

    // MARK: - Logging

    func log(_ message: String) {
        let timestamp = DateFormatter.localizedString(from: Date(), dateStyle: .none, timeStyle: .medium)
        commandLog.append("[\(timestamp)] \(message)")
        if commandLog.count > 200 { commandLog.removeFirst() }
    }
}

// MARK: - GatewaySocketDelegate

extension NodeManager: GatewaySocketDelegate {

    nonisolated func socketDidConnect(_ socket: GatewaySocket) {
        Task { @MainActor in
            self.log("Socket connected — awaiting challenge")
            self.connectionState = .challenging
        }
    }

    nonisolated func socketDidDisconnect(_ socket: GatewaySocket, error: Error?) {
        Task { @MainActor in
            let msg = error?.localizedDescription ?? "Connection closed"
            self.log("Disconnected: \(msg)")
            self.connectionState = .disconnected
            // Always attempt reconnect — connection is app-level, not ImmersiveSpace-level.
            self.scheduleReconnect()
        }
    }

    nonisolated func socketDidReceiveChallenge(_ socket: GatewaySocket, nonce: String, ts: String) {
        Task { @MainActor in
            self.log("Challenge received — responding")
            let frame = HandshakeManager.buildConnectFrame(
                nonce: nonce,
                ts: ts,
                gatewayToken: self.gatewayToken
            )
            try? await socket.send(frame)
        }
    }

    nonisolated func socketDidReceiveHelloOk(_ socket: GatewaySocket) {
        Task { @MainActor in
            self.reconnectDelay = 2.0  // reset backoff on successful handshake
            self.connectionState = .connected
            self.log("✅ Node paired and connected")
        }
    }

    nonisolated func socketDidReceiveHandshakeError(_ socket: GatewaySocket, code: String, message: String) {
        Task { @MainActor in
            self.lastError = message
            self.connectionState = .error
            self.log("❌ Handshake rejected: \(message)")
        }
    }

    nonisolated func socketDidReceiveFrame(_ socket: GatewaySocket, frame: GatewayFrame) {
        Task { @MainActor in
            switch frame {
            case .request(let id, let method, let params):
                await self.dispatchCommand(id: id, method: method, params: params)
            case .event(let type, let payload):
                self.log("Event: \(type)")
                if type == "connect.pending" {
                    self.connectionState = .pending
                    self.log("⏳ Waiting for Gateway admin approval — run: openclaw devices approve <id>")
                } else if type == "node.invoke.request" {
                    // Gateway delivers node commands as events to nodes
                    let id = payload["id"] as? String ?? ""
                    let command = payload["command"] as? String ?? ""
                    let params = payload["params"] as? [String: Any] ?? [:]
                    self.log("→ invoke: \(command) (id: \(id))")
                    await self.dispatchCommand(id: id, method: command, params: params)
                }
            case .unknown(let raw):
                self.log("Unknown frame: \(raw["type"] as? String ?? "?")")
            case .response:
                break
            }
        }
    }

    // MARK: - RPC Dispatch

    private func dispatchCommand(id: String, method: String, params: [String: Any]) async {
        log("→ \(method)")

        // Zero-trust: never trust approval flags in params
        // Reference: CVE-2026-28466 mitigation
        guard !containsSmuggledApproval(params) else {
            log("⚠️ Rejected: smuggled approval field detected in \(method)")
            sendError(id: id, code: "FORBIDDEN", detail: "Parameter injection rejected")
            return
        }

        switch method {

        case "camera.list", "camera.snap", "camera.clip":
            if isBackgrounded {
                sendError(id: id, code: "NODE_BACKGROUND_UNAVAILABLE", detail: "camera-unavailable-in-background")
            } else {
                sendError(id: id, code: "UNAVAILABLE", detail: "enterprise-entitlement-required")
            }

        case "spatial.hands":
            await handleSpatialHands(id: id, params: params)

        case "spatial.planes":
            await handleSpatialPlanes(id: id, params: params)

        case "spatial.mesh":
            await handleSpatialMesh(id: id, params: params)

        case "device.position":
            await handleDevicePosition(id: id, params: params)

        case "device.info":
            sendOK(id: id, payload: [
                "platform": "visionos",
                "modelIdentifier": "RealityDevice14,1",
                "nodeVersion": "0.1.0",
                "deviceID": HandshakeManager.deviceID()
            ])

        case "canvas.present", "canvas.navigate", "canvas.eval", "canvas.snapshot", "canvas.hide":
            if isBackgrounded {
                sendError(id: id, code: "NODE_BACKGROUND_UNAVAILABLE", detail: "canvas-unavailable-in-background")
            } else {
                // Canvas via WKWebView — Phase 5
                sendError(id: id, code: "UNAVAILABLE", detail: "canvas-not-implemented")
            }

        case "location.get":
            await handleLocationGet(id: id, params: params)

        default:
            log("Unknown command: \(method)")
            sendError(id: id, code: "UNKNOWN_COMMAND")
        }
    }

    // MARK: - CVE-2026-28466 mitigation

    /// Reject any payload that attempts to smuggle approval overrides.
    private func containsSmuggledApproval(_ params: [String: Any]) -> Bool {
        let blockedKeys = ["approved", "approvalDecision", "bypass", "override", "authorized"]
        return blockedKeys.contains { params[$0] != nil }
    }

    // MARK: - Spatial handlers

    private func handleSpatialHands(id: String, params: [String: Any]) async {
        guard spatialManager.isRunning else {
            sendError(id: id, code: "UNAVAILABLE", detail: "arkit-not-running — open the immersive space first")
            return
        }
        let snapshot = await spatialManager.handsSnapshot()
        sendOK(id: id, payload: snapshot)
    }

    private func handleSpatialPlanes(id: String, params: [String: Any]) async {
        guard spatialManager.isRunning else {
            sendError(id: id, code: "UNAVAILABLE", detail: "arkit-not-running — open the immersive space first")
            return
        }
        let planes = await spatialManager.planesSnapshot()
        sendOK(id: id, payload: ["planes": planes, "count": planes.count])
    }

    private func handleSpatialMesh(id: String, params: [String: Any]) async {
        guard spatialManager.isRunning else {
            sendError(id: id, code: "UNAVAILABLE", detail: "arkit-not-running — open the immersive space first")
            return
        }
        let chunks = await spatialManager.meshSnapshot()
        sendOK(id: id, payload: ["chunks": chunks, "count": chunks.count])
    }

    private func handleLocationGet(id: String, params: [String: Any]) async {
        do {
            let location = try await locationManager.requestLocation()
            sendOK(id: id, payload: [
                "latitude": location.coordinate.latitude,
                "longitude": location.coordinate.longitude,
                "altitude": location.altitude,
                "horizontalAccuracy": location.horizontalAccuracy,
                "verticalAccuracy": location.verticalAccuracy,
                "timestamp": location.timestamp.timeIntervalSince1970
            ])
        } catch LocationError.denied {
            sendError(id: id, code: "PERMISSION_DENIED", detail: "location-permission-denied")
        } catch {
            sendError(id: id, code: "UNAVAILABLE", detail: "location-unavailable: \(error.localizedDescription)")
        }
    }

    private func handleDevicePosition(id: String, params: [String: Any]) async {
        guard spatialManager.isRunning else {
            sendError(id: id, code: "UNAVAILABLE", detail: "arkit-not-running")
            return
        }
        let pos = await spatialManager.devicePositionSnapshot()
        sendOK(id: id, payload: pos)
    }
}
