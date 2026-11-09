import Foundation
import OpenClawIPC
import OpenClawKit

private struct SimulatorCaptureParams: Decodable {
    let action: String
    let executionId: String?
    let sessionId: String?
    let after: UInt64?
}

private struct SimulatorInputParams: Decodable {
    let sessionId: String
    let action: OpenClawComputerAction
    let x: Double?
    let y: Double?
    let fromX: Double?
    let fromY: Double?
    let text: String?
    let keys: String?
}

extension MacNodeRuntime {
    func handleSimulatorCaptureInvoke(_ req: BridgeInvokeRequest) async throws -> BridgeInvokeResponse {
        let params: SimulatorCaptureParams
        do {
            params = try JSONDecoder().decode(
                SimulatorCaptureParams.self, from: Data((req.paramsJSON ?? "{}").utf8))
        } catch {
            return BridgeInvokeResponse(id: req.id, ok: false, error: OpenClawNodeError(
                code: .invalidRequest, message: "INVALID_REQUEST: invalid simulator capture params"))
        }
        let services = await self.mainActorServices()
        let frame: SimulatorCaptureService.Frame?
        switch params.action {
        case "start":
            guard let executionId = params.executionId else {
                throw OpenClawNodeError(code: .invalidRequest, message: "INVALID_REQUEST: executionId required")
            }
            frame = try await services.startSimulatorCapture(executionId: executionId)
        case "read":
            guard let sessionId = params.sessionId else {
                throw OpenClawNodeError(code: .invalidRequest, message: "INVALID_REQUEST: sessionId required")
            }
            frame = try await services.readSimulatorCapture(sessionId: sessionId, after: params.after ?? 0)
        case "stop":
            guard let sessionId = params.sessionId else {
                throw OpenClawNodeError(code: .invalidRequest, message: "INVALID_REQUEST: sessionId required")
            }
            try await services.stopSimulatorCapture(sessionId: sessionId)
            frame = nil
        default:
            throw OpenClawNodeError(code: .invalidRequest, message: "INVALID_REQUEST: unknown simulator capture action")
        }
        let payload = if let frame {
            try String(decoding: JSONEncoder().encode(frame), as: UTF8.self)
        } else {
            #"{"stopped":true}"#
        }
        return BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: payload)
    }

    func handleSimulatorInputInvoke(
        _ req: BridgeInvokeRequest,
        desktopPermit: MacDesktopAvailabilityCoordinator.Permit,
        lifecycleGeneration: UInt64) async throws -> BridgeInvokeResponse
    {
        let input: SimulatorInputParams
        do {
            input = try JSONDecoder().decode(
                SimulatorInputParams.self, from: Data((req.paramsJSON ?? "{}").utf8))
        } catch {
            throw OpenClawNodeError(code: .invalidRequest, message: "INVALID_REQUEST: invalid simulator input")
        }
        let services = await self.mainActorServices()
        try await services.simulatorInput(
            sessionId: input.sessionId, action: input.action,
            x: input.x, y: input.y, fromX: input.fromX, fromY: input.fromY,
            text: input.text, keys: input.keys, desktopPermit: desktopPermit)
        _ = lifecycleGeneration
        return BridgeInvokeResponse(
            id: req.id, ok: true, payloadJSON: #"{"ok":true}"#)
    }
}
