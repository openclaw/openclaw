import Foundation
import OpenClawIPC
import OpenClawKit

private struct SimulatorCaptureParams: Decodable {
    let action: String
    let sessionId: String?
    let after: UInt64?
}

private struct SimulatorInputParams: Decodable {
    let sessionId: String
    let action: OpenClawComputerAction
    let x: Double?
    let y: Double?
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
        if let missing = await services.missingPermissions([.screenRecording], disabled: []) {
            throw missing
        }
        let frame: SimulatorCaptureService.Frame?
        switch params.action {
        case "start":
            frame = try await services.startSimulatorCapture()
        case "read":
            guard let sessionId = params.sessionId else {
                throw OpenClawNodeError(code: .invalidRequest, message: "INVALID_REQUEST: sessionId required")
            }
            frame = try await services.readSimulatorCapture(sessionId: sessionId, after: params.after ?? 0)
        case "stop":
            await services.stopSimulatorCapture(sessionId: params.sessionId)
            frame = nil
        default:
            throw OpenClawNodeError(code: .invalidRequest, message: "INVALID_REQUEST: unknown simulator capture action")
        }
        let payload = if let frame {
            String(decoding: try JSONEncoder().encode(frame), as: UTF8.self)
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
        let params = try await services.simulatorInput(
            sessionId: input.sessionId, action: input.action,
            x: input.x, y: input.y, text: input.text, keys: input.keys)
        try await services.activateSimulator(sessionId: input.sessionId, desktopPermit: desktopPermit)
        let result = try await services.performComputerAct(
            params, lifecycleGeneration: lifecycleGeneration, desktopPermit: desktopPermit)
        return BridgeInvokeResponse(
            id: req.id, ok: true,
            payloadJSON: String(decoding: try JSONEncoder().encode(result), as: UTF8.self))
    }
}
