import AVFoundation
import Darwin
import Foundation
import OpenClawCameraPTZNative

struct CameraUSBIdentity: Equatable, Sendable {
    let locationId: UInt32
    let vendorId: UInt16
    let productId: UInt16

    static func parse(deviceId: String) throws -> CameraUSBIdentity {
        let trimmed = deviceId.trimmingCharacters(in: .whitespacesAndNewlines)
        let hexadecimal = trimmed.hasPrefix("0x") ? String(trimmed.dropFirst(2)) : trimmed
        guard !hexadecimal.isEmpty,
              hexadecimal.count <= 16,
              let value = UInt64(hexadecimal, radix: 16)
        else {
            throw CameraPTZError.unsupported("deviceId is not a USB camera identifier")
        }
        let locationId = UInt32(truncatingIfNeeded: value >> 32)
        guard locationId != 0 else {
            throw CameraPTZError.unsupported("deviceId does not contain a USB location")
        }
        return CameraUSBIdentity(
            locationId: locationId,
            vendorId: UInt16(truncatingIfNeeded: value >> 16),
            productId: UInt16(truncatingIfNeeded: value))
    }
}

enum CameraUVCControlInfo {
    private static let setCapability: UInt8 = 0x02

    static func canSet(_ info: UInt8?) -> Bool {
        info.map { $0 & self.setCapability != 0 } ?? false
    }
}

struct NativeCameraPTZBackend: CameraPTZBackend {
    func open(deviceId: String) throws -> any CameraPTZControlling {
        try NativeCameraPTZController(deviceId: deviceId)
    }

    func withCaptureSession<T>(deviceId: String, body: () throws -> T) throws -> T {
        let authorization = AVCaptureDevice.authorizationStatus(for: .video)
        guard authorization == .authorized else {
            throw PermissionManager.missingPermission([
                (.camera, authorization == .notDetermined ? .notDetermined : .denied),
            ])!
        }
        guard let device = CameraDeviceResolver.camera(deviceId: deviceId) else {
            throw CameraPTZError.deviceNotFound(deviceId)
        }
        let session = AVCaptureSession()
        let input = try AVCaptureDeviceInput(device: device)
        guard session.canAddInput(input) else {
            throw CameraPTZError.unsupported("camera cannot start a video stream")
        }
        session.addInput(input)
        let output = AVCaptureVideoDataOutput()
        guard session.canAddOutput(output) else {
            throw CameraPTZError.unsupported("camera cannot provide a video stream")
        }
        session.addOutput(output)

        // UVC controls require a live video stream, which briefly lights the camera privacy indicator.
        // Without a sample-buffer delegate, video frames are neither delivered nor retained.
        session.startRunning()
        defer { session.stopRunning() }
        guard session.isRunning else {
            throw CameraPTZError.unsupported("camera video stream did not start")
        }
        return try body()
    }
}

private final class NativeCameraPTZController: CameraPTZControlling {
    private enum Control: UInt8 {
        case zoomAbsolute = 0x0B
        case panTiltAbsolute = 0x0D

        var byteCount: Int {
            self == .panTiltAbsolute ? 8 : 2
        }

        func bytes(_ values: [Int32]) -> [UInt8] {
            let width = self == .panTiltAbsolute ? 4 : 2
            return values.flatMap { value in
                let bits = UInt32(bitPattern: value)
                return (0..<width).map { UInt8(truncatingIfNeeded: bits >> UInt32($0 * 8)) }
            }
        }

        func values(_ bytes: [UInt8]) -> [Int32] {
            switch self {
            case .panTiltAbsolute:
                [0, 4].map { NativeCameraPTZController.decodeInt32(bytes, offset: $0) }
            case .zoomAbsolute:
                [Int32(UInt16(bytes[0]) | UInt16(bytes[1]) << 8)]
            }
        }
    }

    private enum Request {
        static let setCurrent: UInt8 = 0x01
        static let getCurrent: UInt8 = 0x81
        static let getMin: UInt8 = 0x82
        static let getMax: UInt8 = 0x83
        static let getResolution: UInt8 = 0x84
        static let getInfo: UInt8 = 0x86
        static let getDefault: UInt8 = 0x87
    }

    private enum Capability {
        static let zoomAbsolute = UInt32(1 << 9)
        static let panTiltAbsolute = UInt32(1 << 11)
    }

    private var handle: OpaquePointer?
    private let controls: UInt32
    private var panTiltCanSet = false
    private var zoomCanSet = false

    init(deviceId: String) throws {
        let identity = try CameraUSBIdentity.parse(deviceId: deviceId)
        var handle: OpaquePointer?
        var controls: UInt32 = 0
        var error: UnsafeMutablePointer<CChar>?
        guard openclaw_uvc_open(
            identity.locationId,
            identity.vendorId,
            identity.productId,
            &handle,
            &controls,
            &error) == 1,
            let handle
        else {
            throw Self.nativeError(error, fallback: "open USB camera")
        }
        self.handle = handle
        self.controls = controls
        guard self.advertisesPanTilt || self.advertisesZoom else {
            self.close()
            throw CameraPTZError.unsupported("camera advertises no absolute PTZ axes")
        }
        self.panTiltCanSet = self.advertisesPanTilt &&
            CameraUVCControlInfo.canSet(try? self.readInfo(selector: Control.panTiltAbsolute))
        self.zoomCanSet = self.advertisesZoom &&
            CameraUVCControlInfo.canSet(try? self.readInfo(selector: Control.zoomAbsolute))
    }

    deinit {
        self.close()
    }

    func status() throws -> CameraPTZRawStatus {
        let panTilt = try self.advertisesPanTilt
            ? self.readAxes(.panTiltAbsolute, canSet: self.panTiltCanSet) : []
        let zoom = try self.advertisesZoom
            ? self.readAxes(.zoomAbsolute, canSet: self.zoomCanSet) : []
        return CameraPTZRawStatus(pan: panTilt.first, tilt: panTilt.last, zoom: zoom.first)
    }

    func setPanTilt(pan: Int32, tilt: Int32) throws {
        guard self.panTiltCanSet else { throw CameraPTZError.axisUnsupported("pan/tilt") }
        var bytes = Control.panTiltAbsolute.bytes([pan, tilt])
        try self.control(selector: Control.panTiltAbsolute, request: Request.setCurrent, bytes: &bytes)
    }

    func setZoom(_ zoom: Int32) throws {
        guard self.zoomCanSet else { throw CameraPTZError.axisUnsupported("zoom") }
        var bytes = Control.zoomAbsolute.bytes([zoom])
        try self.control(selector: Control.zoomAbsolute, request: Request.setCurrent, bytes: &bytes)
    }

    func close() {
        guard let handle = self.handle else { return }
        openclaw_uvc_close(handle)
        self.handle = nil
    }

    private var advertisesPanTilt: Bool {
        self.controls & Capability.panTiltAbsolute != 0
    }

    private var advertisesZoom: Bool {
        self.controls & Capability.zoomAbsolute != 0
    }

    private func readAxes(_ selector: Control, canSet: Bool) throws -> [CameraPTZRawAxisStatus] {
        func read(_ request: UInt8) throws -> [Int32] {
            var bytes = [UInt8](repeating: 0, count: selector.byteCount)
            try self.control(selector: selector, request: request, bytes: &bytes)
            return selector.values(bytes)
        }
        let minimum = try read(Request.getMin)
        let maximum = try read(Request.getMax)
        let resolution = try read(Request.getResolution)
        let defaults = try? read(Request.getDefault)
        let current = try read(Request.getCurrent)
        return current.indices.map { index in
            CameraPTZRawAxisStatus(
                current: current[index],
                range: CameraPTZRawRange(
                    min: minimum[index],
                    max: maximum[index],
                    step: resolution[index],
                    default: nil).withDefault(defaults?[index]),
                canSet: canSet)
        }
    }

    private func readInfo(selector: Control) throws -> UInt8 {
        var bytes = [UInt8](repeating: 0, count: 1)
        try self.control(selector: selector, request: Request.getInfo, bytes: &bytes)
        return bytes[0]
    }

    private func control(selector: Control, request: UInt8, bytes: inout [UInt8]) throws {
        guard let handle = self.handle else {
            throw CameraPTZError.unsupported("controller is closed")
        }
        var error: UnsafeMutablePointer<CChar>?
        let ok = bytes.withUnsafeMutableBytes { buffer in
            openclaw_uvc_control(
                handle,
                selector.rawValue,
                request,
                buffer.baseAddress,
                UInt16(buffer.count),
                &error)
        }
        guard ok == 1 else {
            throw Self.nativeError(error, fallback: "perform camera control request")
        }
    }

    private static func decodeInt32(_ bytes: [UInt8], offset: Int) -> Int32 {
        var value: UInt32 = 0
        for index in 0..<4 {
            value |= UInt32(bytes[offset + index]) << UInt32(index * 8)
        }
        return Int32(bitPattern: value)
    }

    private static func nativeError(
        _ error: UnsafeMutablePointer<CChar>?,
        fallback: String) -> CameraPTZError
    {
        guard let error else { return .unsupported(fallback) }
        defer { free(error) }
        return .unsupported(String(cString: error))
    }
}
