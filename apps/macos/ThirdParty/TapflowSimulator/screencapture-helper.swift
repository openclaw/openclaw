// screencapture-helper.swift
// Captures iOS Simulator screen via SimulatorKit IOSurface callbacks.
// Reads com.apple.framebuffer.display directly — no window geometry needed.
//
// Usage: screencapture-helper <fps> <udid|booted>
// Output: [4-byte big-endian uint32 frame length][JPEG bytes] ...
//
// Adapted from https://github.com/tddworks/baguette (Apache-2.0)

import Foundation
import IOSurface
import CoreVideo
import CoreGraphics
import ImageIO
import ObjectiveC
import VideoToolbox
import CoreMedia
import Accelerate
import Metal

// MARK: - Args

// `--panel <w>x<h>` picks a multi-panel device's panel by its framebuffer size (iPhone Duo: cover 1398x2034,
// unfolded 2007x2853). Without it the largest surface is captured, which is every single-panel device's only
// panel — and on the Duo the unfolded one, dark while folded, which is why the flag exists.
func parsePanel(_ s: String) -> (Int, Int)? {
    let parts = s.split(separator: "x").compactMap { Int($0) }
    return parts.count == 2 && parts[0] > 0 && parts[1] > 0 ? (parts[0], parts[1]) : nil
}
var positional: [String] = []
var initialPanel: (Int, Int)? = nil
do {
    var rest = Array(CommandLine.arguments.dropFirst())
    while !rest.isEmpty {
        let a = rest.removeFirst()
        if a == "--panel" {
            guard let v = rest.first, let panel = parsePanel(v) else {
                fputs("error: --panel needs <width>x<height>\n", stderr)
                exit(1)
            }
            rest.removeFirst()
            initialPanel = panel
        } else {
            positional.append(a)
        }
    }
}
guard positional.count == 2 || positional.count == 3,
      let fps = Double(positional[0]), fps > 0
else {
    fputs("usage: screencapture-helper <fps> <udid> [jpeg|h264] [--panel <w>x<h>]\n", stderr)
    exit(1)
}
let targetUDID = positional[1]
// Fail closed on an unknown codec rather than silently emitting JPEG framing.
let codec = positional.count == 3 ? positional[2] : "jpeg"
guard codec == "jpeg" || codec == "h264" else {
    fputs("error: unknown codec '\(codec)' — expected jpeg or h264\n", stderr)
    exit(1)
}
let useH264 = codec == "h264"

// JPEG quality (0–1). Tunable for the LAN bandwidth/fidelity trade-off via TAPFLOW_JPEG_QUALITY.
// Default 0.8: cuts ~40% off the previous 0.95 while keeping color/text fidelity for design QA.
let jpegQuality: Double = {
    guard let raw = ProcessInfo.processInfo.environment["TAPFLOW_JPEG_QUALITY"],
          let q = Double(raw), q > 0, q <= 1 else { return 0.8 }
    return q
}()

// H.264 target bitrate (bits/s). Caps scroll bursts so they fit a typical WiFi LAN;
// without a cap VideoToolbox lets motion spike ~20+ Mbps → sustained relay backpressure.
// Tunable via TAPFLOW_IOS_H264_BITRATE (default 8 Mbps, matching the Android scrcpy cap).
let h264Bitrate: Int = {
    guard let raw = ProcessInfo.processInfo.environment["TAPFLOW_IOS_H264_BITRATE"],
          let b = Int(raw), b > 0 else { return 8_000_000 }
    return b
}()

// Downscale cap (longest side, px). Trades design-QA fidelity for LAN bandwidth + viewer decode
// load — the tier1 lever for LAN-HTTP (WASM decode). 0 = native. TAPFLOW_IOS_MAX_SIZE overrides
// the cross-platform TAPFLOW_MAX_SIZE.
let maxSize: Int = {
    let env = ProcessInfo.processInfo.environment
    for key in ["TAPFLOW_IOS_MAX_SIZE", "TAPFLOW_MAX_SIZE"] {
        if let raw = env[key], let m = Int(raw), m > 0 { return m }
    }
    return 0
}()

// Target encode dimensions: scale so the longest side ≤ maxSize, preserving aspect, then round down to a
// multiple of 16. Only the native tier (maxSize=0) returns the source dims unchanged; every downscale tier
// 16-aligns even when no scaling is needed (longest ≤ maxSize). 16-alignment matches the H.264 macroblock
// so coded == display: the WASM (tinyh264) decoder used on plain-HTTP LAN doesn't apply frame-cropping, so
// a non-16 size would leave a green padding edge (mirrors android emulator-encoder).
func targetDims(_ w: Int, _ h: Int) -> (Int, Int) {
    guard maxSize > 0 else { return (w, h) }  // native (secure-context WebCodecs path) — no WASM, cropping is fine
    let longest = max(w, h)
    let scale = longest > maxSize ? Double(maxSize) / Double(longest) : 1.0
    let tw = max(16, Int((Double(w) * scale).rounded()) & ~15)
    let th = max(16, Int((Double(h) * scale).rounded()) & ~15)
    return (tw, th)
}

// MARK: - Framework loading

// Xcode ≤26 ships SimulatorKit inside the developer dir. Xcode 27 moved it to Contents/SharedFrameworks,
// a sibling of Contents/Developer, so appending to what xcode-select reports no longer reaches it.
// Both are probed on the selected Xcode before any other Xcode is: with 27 selected and an older Xcode
// in /Applications, a fallback that knows only the old path loads that older SimulatorKit instead.
func simulatorKitCandidates(_ developerDir: String) -> [String] {
    let contents = (developerDir as NSString).deletingLastPathComponent
    return [
        (developerDir as NSString).appendingPathComponent("Library/PrivateFrameworks/SimulatorKit.framework/SimulatorKit"),
        (contents as NSString).appendingPathComponent("SharedFrameworks/SimulatorKit.framework/SimulatorKit"),
    ]
}

func findSimulatorKit() -> (developerDir: String, path: String?, searched: [String]) {
    let defaultDir = "/Applications/Xcode.app/Contents/Developer"
    var searched: [String] = []
    func probe(_ d: String) -> String? {
        let candidates = simulatorKitCandidates(d)
        searched += candidates
        return candidates.first { FileManager.default.fileExists(atPath: $0) }
    }

    let pipe = Pipe()
    let task = Process()
    task.executableURL = URL(fileURLWithPath: "/usr/bin/xcode-select")
    task.arguments = ["-p"]
    task.standardOutput = pipe
    do { try task.run() } catch {
        let path = probe(defaultDir)
        return (defaultDir, path, searched)
    }
    task.waitUntilExit()
    let dir = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)?
        .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""

    if !dir.isEmpty, let path = probe(dir) { return (dir, path, searched) }
    // xcode-select may point to CLT which lacks SimulatorKit — scan /Applications
    let apps = (try? FileManager.default.contentsOfDirectory(atPath: "/Applications")) ?? []
    for app in apps.sorted() where app.hasPrefix("Xcode") && app.hasSuffix(".app") {
        let d = "/Applications/\(app)/Contents/Developer"
        if d != dir, let path = probe(d) { return (d, path, searched) }
    }
    return (dir.isEmpty ? defaultDir : dir, nil, searched)
}

let simulatorKit = findSimulatorKit()
let developerDir = simulatorKit.developerDir

guard dlopen("/Library/Developer/PrivateFrameworks/CoreSimulator.framework/CoreSimulator",
             RTLD_NOW | RTLD_GLOBAL) != nil else {
    if let e = dlerror() { fputs("error: CoreSimulator load failed: \(String(cString: e))\n", stderr) }
    exit(1)
}
guard let simkitPath = simulatorKit.path else {
    let searched = simulatorKit.searched.map { "  \($0)\n" }.joined()
    fputs("error: SimulatorKit not found. Searched:\n\(searched)", stderr)
    exit(1)
}
// Which SimulatorKit is about to load is the one fact a machine with two Xcodes cannot show otherwise.
fputs("info: SimulatorKit \(simkitPath)\n", stderr)
guard dlopen(simkitPath, RTLD_NOW | RTLD_GLOBAL) != nil else {
    if let e = dlerror() { fputs("error: SimulatorKit load failed: \(String(cString: e))\n", stderr) }
    exit(1)
}

// MARK: - ObjC runtime helpers

func classInvoke(_ cls: AnyClass, _ sel: Selector, _ arg: AnyObject, err: inout NSError?) -> NSObject? {
    guard let meta = object_getClass(cls),
          let imp = class_getMethodImplementation(meta, sel) else { return nil }
    typealias Fn = @convention(c) (AnyClass, Selector, AnyObject,
                                   AutoreleasingUnsafeMutablePointer<NSError?>) -> AnyObject?
    return unsafeBitCast(imp, to: Fn.self)(cls, sel, arg, &err) as? NSObject
}

func instanceInvoke(_ obj: NSObject, _ sel: Selector, err: inout NSError?) -> NSObject? {
    guard let imp = class_getMethodImplementation(type(of: obj), sel) else { return nil }
    typealias Fn = @convention(c) (AnyObject, Selector,
                                   AutoreleasingUnsafeMutablePointer<NSError?>) -> AnyObject?
    return unsafeBitCast(imp, to: Fn.self)(obj, sel, &err) as? NSObject
}

// MARK: - Device resolution

func resolveDevice(udid: String) -> NSObject? {
    guard let cls = NSClassFromString("SimServiceContext") else {
        fputs("error: SimServiceContext not found — CoreSimulator not loaded?\n", stderr)
        return nil
    }
    var err: NSError?
    guard let ctx = classInvoke(cls,
        NSSelectorFromString("sharedServiceContextForDeveloperDir:error:"),
        developerDir as NSString, err: &err) else {
        fputs("error: SimServiceContext: \(err?.localizedDescription ?? "nil")\n", stderr)
        return nil
    }
    guard let set = instanceInvoke(ctx,
        NSSelectorFromString("defaultDeviceSetWithError:"), err: &err) else {
        fputs("error: defaultDeviceSet: \(err?.localizedDescription ?? "nil")\n", stderr)
        return nil
    }
    let devices = (set.value(forKey: "availableDevices") as? [NSObject]) ?? []
    if udid == "booted" {
        // CoreSimulator state 3 == booted
        return devices.first { ($0.value(forKey: "state") as? NSNumber)?.uintValue == 3 }
    }
    return devices.first { ($0.value(forKey: "UDID") as? NSUUID)?.uuidString == udid }
}

// MARK: - IOSurface → JPEG

func encodeJPEG(_ surface: IOSurface) -> Data? {
    // Read a tear-free snapshot, not the live surface (see copySurfaceStable) — otherwise a
    // mid-draw read bakes a horizontal tear into the JPEG, same as the H.264 path. makeImage()
    // copies the pixels synchronously, so reusing the snapshot buffer next frame is safe.
    guard let buf = copySurfaceStable(surface) else { return nil }

    CVPixelBufferLockBaseAddress(buf, .readOnly)
    defer { CVPixelBufferUnlockBaseAddress(buf, .readOnly) }

    let w = CVPixelBufferGetWidth(buf)
    let h = CVPixelBufferGetHeight(buf)
    guard let base = CVPixelBufferGetBaseAddress(buf),
          let ctx = CGContext(
              data: base, width: w, height: h,
              bitsPerComponent: 8, bytesPerRow: CVPixelBufferGetBytesPerRow(buf),
              space: CGColorSpaceCreateDeviceRGB(),
              bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue
                        | CGBitmapInfo.byteOrder32Little.rawValue),
          let image = ctx.makeImage()
    else { return nil }

    let out = NSMutableData()
    guard let dest = CGImageDestinationCreateWithData(out, "public.jpeg" as CFString, 1, nil)
    else { return nil }
    CGImageDestinationAddImage(dest, image,
        [kCGImageDestinationLossyCompressionQuality: jpegQuality] as CFDictionary)
    return CGImageDestinationFinalize(dest) ? (out as Data) : nil
}

// MARK: - Frame output

let stdoutFH = FileHandle.standardOutput
let writeQueue = DispatchQueue(label: "com.tapflow.write", qos: .userInitiated)

func writeFrame(_ jpeg: Data) {
    writeQueue.async {
        var len = UInt32(jpeg.count).bigEndian
        withUnsafeBytes(of: &len) { stdoutFH.write(Data($0)) }
        stdoutFH.write(jpeg)
    }
}

// H.264 framing: [4-byte len][flags:u8][payload]. flags bit0 = keyframe (IDR).
// len counts the flags byte + payload. The JPEG path above stays byte-identical.
func writeFrameWithFlags(_ payload: Data, flags: UInt8) {
    writeQueue.async {
        var len = UInt32(payload.count + 1).bigEndian
        withUnsafeBytes(of: &len) { stdoutFH.write(Data($0)) }
        stdoutFH.write(Data([flags]))
        stdoutFH.write(payload)
    }
}

// Set true once any frame reaches stdout — read by the 8s startup watchdog.
var firstFrameSent = false

// MARK: - IOSurface → H.264 (VideoToolbox)
//
// VTCompressionSession encodes the IOSurface-backed BGRA pixel buffer to H.264.
// Output is async (compressionOutputCallback), converted from AVCC length-prefixed
// NALs to Annex B (00 00 00 01 start codes) and tagged with the keyframe flag.

var h264Session: VTCompressionSession?
var h264Width = 0           // encode (target) dimensions — may be downscaled from the source
var h264Height = 0
var h264SrcWidth = 0        // source IOSurface dimensions — drives session recreation on rotation
var h264SrcHeight = 0
var scaledBuffer: CVPixelBuffer?  // reused downscale target; nil when encoding at native size
var srcCopyBuffer: CVPixelBuffer? // reused tear-free snapshot of the live framebuffer surface (GPU blit, or memcpy)
var srcCopyW = 0, srcCopyH = 0
var tearRetries = 0               // copies that raced a sim write (seed changed) and were retried
var tearExhausted = 0             // copies still racing after the retry budget (best-effort frame)
let logTearStats = ProcessInfo.processInfo.environment["TAPFLOW_STREAM_METRICS"] == "1"
var h264FrameIndex: Int64 = 0
var didForceInitialIDR = false
// Set from the stdin command reader (relay IDR-on-drop), consumed in encodeH264.
// Only ever touched on captureQueue, so no lock is needed.
var pendingForceKeyFrame = false
let h264Timescale = Int32(max(1, Int(fps)))

let h264OutputCallback: VTCompressionOutputCallback = { _, _, status, _, sampleBuffer in
    guard status == noErr, let sample = sampleBuffer, CMSampleBufferDataIsReady(sample) else { return }

    // A sync sample (IDR) has no kCMSampleAttachmentKey_NotSync = true attachment.
    var keyframe = true
    if let attachments = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false)
        as? [[CFString: Any]], let first = attachments.first,
       let notSync = first[kCMSampleAttachmentKey_NotSync] as? Bool {
        keyframe = !notSync
    }

    let startCode: [UInt8] = [0x00, 0x00, 0x00, 0x01]
    var out = Data()

    // On a keyframe, prepend SPS/PPS (parameter sets) from the format description.
    if keyframe, let fmt = CMSampleBufferGetFormatDescription(sample) {
        var idx = 0
        var setCount = 0
        repeat {
            var ptr: UnsafePointer<UInt8>?
            var size = 0
            let s = CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
                fmt, parameterSetIndex: idx,
                parameterSetPointerOut: &ptr, parameterSetSizeOut: &size,
                parameterSetCountOut: &setCount, nalUnitHeaderLengthOut: nil)
            if s != noErr || ptr == nil { break }
            out.append(contentsOf: startCode)
            out.append(ptr!, count: size)
            idx += 1
        } while idx < setCount
    }

    // Convert AVCC (4-byte length-prefixed) NALs to Annex B.
    guard let block = CMSampleBufferGetDataBuffer(sample) else { return }
    var totalLength = 0
    var dataPtr: UnsafeMutablePointer<Int8>?
    guard CMBlockBufferGetDataPointer(block, atOffset: 0, lengthAtOffsetOut: nil,
            totalLengthOut: &totalLength, dataPointerOut: &dataPtr) == noErr,
          let base = dataPtr else { return }
    let bytes = UnsafeRawPointer(base).assumingMemoryBound(to: UInt8.self)
    var offset = 0
    while offset + 4 <= totalLength {
        var nalLen: UInt32 = 0
        memcpy(&nalLen, bytes + offset, 4)
        nalLen = CFSwapInt32BigToHost(nalLen)
        offset += 4
        if nalLen == 0 || offset + Int(nalLen) > totalLength { break }
        out.append(contentsOf: startCode)
        out.append(UnsafeBufferPointer(start: bytes + offset, count: Int(nalLen)))
        offset += Int(nalLen)
    }

    firstFrameSent = true
    writeFrameWithFlags(out, flags: keyframe ? 0x01 : 0x00)
}

func setupH264Session(width: Int, height: Int) -> Bool {
    var session: VTCompressionSession?
    let status = VTCompressionSessionCreate(
        allocator: kCFAllocatorDefault,
        width: Int32(width), height: Int32(height),
        codecType: kCMVideoCodecType_H264,
        encoderSpecification: nil, imageBufferAttributes: nil,
        compressedDataAllocator: nil,
        outputCallback: h264OutputCallback, refcon: nil,
        compressionSessionOut: &session)
    guard status == noErr, let s = session else {
        fputs("error: VTCompressionSessionCreate failed (\(status))\n", stderr)
        return false
    }
    VTSessionSetProperty(s, key: kVTCompressionPropertyKey_RealTime, value: kCFBooleanTrue)
    VTSessionSetProperty(s, key: kVTCompressionPropertyKey_AllowFrameReordering, value: kCFBooleanFalse)
    // Emit each encoded frame immediately — no output-pipeline delay (lowest latency).
    VTSessionSetProperty(s, key: kVTCompressionPropertyKey_MaxFrameDelayCount, value: NSNumber(value: 0))
    VTSessionSetProperty(s, key: kVTCompressionPropertyKey_ProfileLevel,
                         value: kVTProfileLevel_H264_Baseline_AutoLevel)
    VTSessionSetProperty(s, key: kVTCompressionPropertyKey_MaxKeyFrameInterval,
                         value: NSNumber(value: Int(fps) * 2))
    VTSessionSetProperty(s, key: kVTCompressionPropertyKey_MaxKeyFrameIntervalDuration,
                         value: NSNumber(value: 2.0))
    // Cap the average bitrate so scroll bursts fit the LAN link (avoids sustained relay
    // backpressure). AverageBitRate is a soft target — we intentionally do NOT set the
    // hard DataRateLimits cap, which corrupts frames (visible tearing) under high motion.
    VTSessionSetProperty(s, key: kVTCompressionPropertyKey_AverageBitRate,
                         value: NSNumber(value: h264Bitrate))
    // BT.709 color — keep the design-faithful colour signalling (see android color-fidelity note).
    VTSessionSetProperty(s, key: kVTCompressionPropertyKey_ColorPrimaries,
                         value: kCVImageBufferColorPrimaries_ITU_R_709_2)
    VTSessionSetProperty(s, key: kVTCompressionPropertyKey_TransferFunction,
                         value: kCVImageBufferTransferFunction_ITU_R_709_2)
    VTSessionSetProperty(s, key: kVTCompressionPropertyKey_YCbCrMatrix,
                         value: kCVImageBufferYCbCrMatrix_ITU_R_709_2)
    VTCompressionSessionPrepareToEncodeFrames(s)
    h264Session = s
    h264Width = width
    h264Height = height
    return true
}

// Downscale a source BGRA pixel buffer into `scaledBuffer` via Accelerate (high-quality resampling),
// preserving design fidelity better than a nearest-neighbour shrink. Returns the buffer to encode.
func scaleToTarget(_ src: CVPixelBuffer) -> CVPixelBuffer? {
    guard let dst = scaledBuffer else { return src }  // no downscale → encode the source directly
    CVPixelBufferLockBaseAddress(src, .readOnly)
    CVPixelBufferLockBaseAddress(dst, [])
    defer {
        CVPixelBufferUnlockBaseAddress(src, .readOnly)
        CVPixelBufferUnlockBaseAddress(dst, [])
    }
    guard let srcBase = CVPixelBufferGetBaseAddress(src),
          let dstBase = CVPixelBufferGetBaseAddress(dst) else { return src }
    var srcBuf = vImage_Buffer(data: srcBase,
        height: vImagePixelCount(CVPixelBufferGetHeight(src)),
        width: vImagePixelCount(CVPixelBufferGetWidth(src)),
        rowBytes: CVPixelBufferGetBytesPerRow(src))
    var dstBuf = vImage_Buffer(data: dstBase,
        height: vImagePixelCount(CVPixelBufferGetHeight(dst)),
        width: vImagePixelCount(CVPixelBufferGetWidth(dst)),
        rowBytes: CVPixelBufferGetBytesPerRow(dst))
    guard vImageScale_ARGB8888(&srcBuf, &dstBuf, nil, vImage_Flags(kvImageHighQualityResampling)) == kvImageNoError
    else { return src }
    return dst
}

// Tear-free snapshot of the live framebuffer surface. The simulator draws into a single
// IOSurface in place (the static-skip seed relies on that), asynchronously to our 30fps timer.
// Reading the surface mid-draw (native: VTEncode reads it directly; downscale: vImage reads it)
// bakes a horizontal tear (top = old frame, bottom = new) into the H.264 frame — visible on every
// tier and decoder, recovering on the next frame. IOSurfaceLock(.readOnly) is cooperative and does
// not block the sim's GPU writes, so it alone does not prevent the tear.
//
// Fix: copy the surface into a private buffer and bracket the copy with IOSurfaceGetSeed; if the
// seed moved, the sim drew during the copy → it may be sheared → retry. A copy (memcpy ≈ 1ms, GPU blit
// ≈ 0.3ms) against a ≈ 16ms write interval lands a coherent snapshot in 1–2 tries even during scroll.
//
// The copy runs on the GPU when it can (`GPUSurfaceCopier`): the same snapshot, the same seed bracket, without the CPU
// reading 12–15 MB a frame. Measured while a video played: the helper at ~4% of a core against ~7% for the memcpy,
// with the simulator's own processes and WindowServer unchanged and the same tear retries. Waiting for the blit before
// reading the seed again is what keeps the bracket meaningful. A surface the GPU path refuses (not 32-bit BGRA, a row
// stride Metal cannot wrap, or Metal unavailable or failing) takes the memcpy, frame by frame.

// BEGIN gpu-copy — compiled on its own by src/__tests__/gpuCopy.test.ts, so keep it self-contained.
final class GPUSurfaceCopier {
    private let device: MTLDevice
    private let queue: MTLCommandQueue
    private var source: (id: IOSurfaceID, width: Int, height: Int, texture: MTLTexture)?
    private var target: (buffer: CVPixelBuffer, texture: MTLTexture)?
    /// Why the last `copy` returned false, for the log.
    private(set) var lastFailure = ""

    init?() {
        guard let device = MTLCreateSystemDefaultDevice(), let queue = device.makeCommandQueue() else { return nil }
        self.device = device
        self.queue = queue
    }

    /// Copies `surface` into `buffer` on the GPU and waits for it. False when either is not 32-bit BGRA of the same
    /// size, a row stride is not what Metal can wrap, or Metal will not do it; the caller then copies on the CPU.
    func copy(_ surface: IOSurface, into buffer: CVPixelBuffer) -> Bool {
        let width = IOSurfaceGetWidth(surface), height = IOSurfaceGetHeight(surface)
        // Metal does not refuse a misaligned stride, it aborts the process (measured: a 468-byte row). A 1398-pixel
        // panel is 5592 bytes a row unpadded, so this is asked of every surface rather than assumed.
        let align = device.minimumLinearTextureAlignment(for: .bgra8Unorm)
        guard IOSurfaceGetPixelFormat(surface) == kCVPixelFormatType_32BGRA,
              CVPixelBufferGetPixelFormatType(buffer) == kCVPixelFormatType_32BGRA
        else { lastFailure = "pixel format \(IOSurfaceGetPixelFormat(surface))"; return false }
        guard CVPixelBufferGetWidth(buffer) == width, CVPixelBufferGetHeight(buffer) == height
        else { lastFailure = "size \(width)x\(height)"; return false }
        guard IOSurfaceGetBytesPerRow(surface) % align == 0, CVPixelBufferGetBytesPerRow(buffer) % align == 0
        else { lastFailure = "row stride \(IOSurfaceGetBytesPerRow(surface))/\(CVPixelBufferGetBytesPerRow(buffer)) bytes"; return false }
        guard let src = sourceTexture(surface, width, height), let dst = targetTexture(buffer, width, height),
              let commands = queue.makeCommandBuffer(), let blit = commands.makeBlitCommandEncoder()
        else { lastFailure = "texture or command buffer not created"; return false }
        blit.copy(from: src, to: dst)
        blit.endEncoding()
        commands.commit()
        // No timeout of our own: Metal ends a hung command buffer itself with a GPU-timeout error, and a semaphore
        // here could not unblock captureQueue anyway.
        commands.waitUntilCompleted()
        guard commands.status == .completed
        else { lastFailure = "GPU error \(commands.error.map { String(describing: $0) } ?? "status \(commands.status.rawValue)")"; return false }
        return true
    }

    // Keyed by the surface's id and size: the simulator keeps drawing into one surface, and a fold or a new runtime
    // that hands over another one, even of the same size, must not be read through the old texture.
    private func sourceTexture(_ surface: IOSurface, _ width: Int, _ height: Int) -> MTLTexture? {
        let id = IOSurfaceGetID(surface)
        if let s = source, s.id == id, s.width == width, s.height == height { return s.texture }
        let d = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: .bgra8Unorm, width: width, height: height, mipmapped: false)
        d.usage = .shaderRead
        d.storageMode = .shared
        guard let texture = device.makeTexture(descriptor: d, iosurface: surface, plane: 0) else { return nil }
        source = (id, width, height, texture)
        return texture
    }

    private func targetTexture(_ buffer: CVPixelBuffer, _ width: Int, _ height: Int) -> MTLTexture? {
        if let t = target, t.buffer === buffer { return t.texture }
        guard let surface = CVPixelBufferGetIOSurface(buffer)?.takeUnretainedValue() else { return nil }
        let d = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: .bgra8Unorm, width: width, height: height, mipmapped: false)
        d.usage = .shaderWrite
        d.storageMode = .shared
        guard let texture = device.makeTexture(descriptor: d, iosurface: surface, plane: 0) else { return nil }
        target = (buffer, texture)
        return texture
    }
}
// END gpu-copy

let gpuCopier = GPUSurfaceCopier()
var gpuFailuresLogged = Set<String>()  // each reason once, so a later, different one is still heard
if gpuCopier == nil { fputs("info: no Metal device — copying frames on the CPU\n", stderr) }

func copySurfaceStable(_ surface: IOSurface) -> CVPixelBuffer? {
    let w = IOSurfaceGetWidth(surface)
    let h = IOSurfaceGetHeight(surface)
    if srcCopyBuffer == nil || w != srcCopyW || h != srcCopyH {
        var pb: CVPixelBuffer?
        CVPixelBufferCreate(kCFAllocatorDefault, w, h, kCVPixelFormatType_32BGRA,
            [kCVPixelBufferIOSurfacePropertiesKey: [:]] as CFDictionary, &pb)
        srcCopyBuffer = pb; srcCopyW = w; srcCopyH = h
    }
    guard let dst = srcCopyBuffer else { return nil }
    if let gpu = gpuCopier {
        var copied = true
        for attempt in 0...3 {
            let seed0 = IOSurfaceGetSeed(surface)
            guard gpu.copy(surface, into: dst) else { copied = false; break }
            if IOSurfaceGetSeed(surface) == seed0 { return dst }  // no write during the copy → coherent
            if attempt < 3 { tearRetries += 1 } else { tearExhausted += 1 }
        }
        if copied { return dst }  // best-effort, as below
        if gpuFailuresLogged.insert(gpu.lastFailure).inserted {
            fputs("info: GPU copy not used (\(gpu.lastFailure)) — copying on the CPU\n", stderr)
        }
    }
    CVPixelBufferLockBaseAddress(dst, [])
    defer { CVPixelBufferUnlockBaseAddress(dst, []) }
    guard let dstBase = CVPixelBufferGetBaseAddress(dst) else { return nil }
    let dstStride = CVPixelBufferGetBytesPerRow(dst)

    for attempt in 0...3 {
        let seed0 = IOSurfaceGetSeed(surface)
        IOSurfaceLock(surface, .readOnly, nil)
        let srcStride = IOSurfaceGetBytesPerRow(surface)
        let srcBase = IOSurfaceGetBaseAddress(surface)
        let rowBytes = min(srcStride, dstStride)
        for row in 0..<h {
            memcpy(dstBase + row * dstStride, srcBase + row * srcStride, rowBytes)
        }
        IOSurfaceUnlock(surface, .readOnly, nil)
        if IOSurfaceGetSeed(surface) == seed0 { return dst }  // no write during the copy → coherent
        if attempt < 3 { tearRetries += 1 } else { tearExhausted += 1 }  // racing; retry or give up
    }
    return dst  // best-effort: a (possibly torn) frame beats a frozen stream
}

func encodeH264(_ surface: IOSurface) {
    let w = IOSurfaceGetWidth(surface)
    let h = IOSurfaceGetHeight(surface)
    let (tw, th) = targetDims(w, h)
    // Recreate the session on first frame or source-resolution change (rotation). The session
    // encodes at the (possibly downscaled) target size; `scaledBuffer` is the reused scale target.
    if h264Session == nil || w != h264SrcWidth || h != h264SrcHeight {
        if let old = h264Session { VTCompressionSessionInvalidate(old); h264Session = nil }
        didForceInitialIDR = false
        guard setupH264Session(width: tw, height: th) else { return }
        h264SrcWidth = w; h264SrcHeight = h
        if tw != w || th != h {
            var pb: CVPixelBuffer?
            CVPixelBufferCreate(kCFAllocatorDefault, tw, th, kCVPixelFormatType_32BGRA,
                [kCVPixelBufferIOSurfacePropertiesKey: [:]] as CFDictionary, &pb)
            scaledBuffer = pb
        } else {
            scaledBuffer = nil
        }
    }
    guard let session = h264Session else { return }

    // Encode a tear-free CPU snapshot, not the live surface (see copySurfaceStable). scaleToTarget
    // then downscales the snapshot, or returns it as-is at native size.
    guard let srcCopy = copySurfaceStable(surface) else { return }
    guard let frameBuffer = scaleToTarget(srcCopy) else { return }

    let pts = CMTime(value: h264FrameIndex, timescale: h264Timescale)
    h264FrameIndex += 1
    // Force an IDR on the first frame, or on demand (relay IDR-on-drop recovery).
    var frameProps: CFDictionary?
    if !didForceInitialIDR || pendingForceKeyFrame {
        frameProps = [kVTEncodeFrameOptionKey_ForceKeyFrame: true] as CFDictionary
        didForceInitialIDR = true
        pendingForceKeyFrame = false
    }
    VTCompressionSessionEncodeFrame(
        session, imageBuffer: frameBuffer, presentationTimeStamp: pts,
        duration: CMTime(value: 1, timescale: h264Timescale),
        frameProperties: frameProps, sourceFrameRefcon: nil, infoFlagsOut: nil)
}

// MARK: - Framebuffer setup

guard let device = resolveDevice(udid: targetUDID) else {
    fputs("error: device not found (udid=\(targetUDID)) — is the simulator booted?\n", stderr)
    exit(1)
}

// Retry acquiring device.io — it may not be available immediately when multiple
// simulators are booting simultaneously (e.g. iOS 17.x + iOS 18+ co-boot)
var io: NSObject?
for attempt in 1...10 {
    io = device.perform(NSSelectorFromString("io"))?.takeUnretainedValue() as? NSObject
    if io != nil { break }
    fputs("info: device.io not ready (attempt \(attempt)/10), retrying in 300ms...\n", stderr)
    Thread.sleep(forTimeInterval: 0.3)
}
guard let io else {
    fputs("error: device.io unavailable — is the simulator fully booted?\n", stderr)
    exit(1)
}

// Retry updateIOPorts — older runtimes (iOS 17.x) may need multiple calls
// before deviceIOPorts is populated when another simulator is already active
var ports: [NSObject] = []
for attempt in 1...15 {
    io.perform(NSSelectorFromString("updateIOPorts"))
    ports = (io.value(forKey: "deviceIOPorts") as? [NSObject]) ?? []
    if !ports.isEmpty { break }
    fputs("info: deviceIOPorts empty (attempt \(attempt)/15), retrying in 500ms...\n", stderr)
    Thread.sleep(forTimeInterval: 0.5)
}
guard !ports.isEmpty else {
    fputs("error: deviceIOPorts not available after retries\n", stderr)
    exit(1)
}

let pidSel  = NSSelectorFromString("portIdentifier")
let descSel = NSSelectorFromString("descriptor")
let surfSel = NSSelectorFromString("framebufferSurface")

var descriptors: [NSObject] = []
for port in ports where port.responds(to: pidSel) {
    guard let pid = port.perform(pidSel)?.takeUnretainedValue(),
          "\(pid)" == "com.apple.framebuffer.display",
          port.responds(to: descSel),
          let desc = port.perform(descSel)?.takeUnretainedValue() as? NSObject,
          desc.responds(to: surfSel)
    else { continue }
    descriptors.append(desc)
}

guard !descriptors.isEmpty else {
    fputs("error: no com.apple.framebuffer.display port — is the simulator booted?\n", stderr)
    exit(1)
}

// MARK: - Capture loop
//
// Strategy: `latestSurface` is the framebuffer surface, looked up when the simulator reports its surfaces changed (and
// as a fallback once a second — see the registration below). A DispatchSourceTimer emits frames at the configured
// FPS, reading `latestSurface` each tick. This guarantees smooth FPS even when the simulator screen is static.

let captureQueue = DispatchQueue(label: "com.tapflow.capture", qos: .userInteractive)
var latestSurface: IOSurface?
var callbackBlocks: [AnyObject] = []  // retain ObjC blocks

// capture-wait (#195): time a changed surface sat before the timer encoded it. Both
// updateLatestSurface and the timer run on the serial captureQueue, so these are lock-free.
var lastObservedSeed: UInt32 = 0
var latestSeedArrivalNs: UInt64 = 0
var captureWaitSumMs = 0.0
var captureWaitMax = 0.0
var captureWaitN = 0

// Read and written on captureQueue only.
var selectedPanel: (Int, Int)? = initialPanel
var lastSurfaceWalkNs: UInt64 = 0

func updateLatestSurface() {
    lastSurfaceWalkNs = DispatchTime.now().uptimeNanoseconds
    var best: IOSurface?
    var bestArea = 0
    var selected: IOSurface?
    for desc in descriptors {
        guard let obj = desc.perform(surfSel)?.takeUnretainedValue() else { continue }
        let surf = unsafeBitCast(obj, to: IOSurface.self)
        let w = IOSurfaceGetWidth(surf), h = IOSurfaceGetHeight(surf)
        if let p = selectedPanel, p.0 == w, p.1 == h { selected = surf }
        if w * h > bestArea { best = surf; bestArea = w * h }
    }
    // A selected panel that is not there (yet) falls back to the old rule rather than to nothing: a stream
    // that shows the wrong panel recovers on the next walk (surfaces changed, or the timer's once a second),
    // one that shows nothing trips the 8 s watchdog and restarts the helper.
    if let selected { best = selected }
    if let best {
        latestSurface = best
        let s = IOSurfaceGetSeed(best)
        if s != lastObservedSeed { lastObservedSeed = s; latestSeedArrivalNs = DispatchTime.now().uptimeNanoseconds }
    }
}

// Accumulate capture-wait for a freshly-changed frame; emit avg/max each 150-sample window.
// Excludes keep-alive / forced-keyframe re-sends (changed == false) — those aren't new captures.
func recordCaptureWait(_ changed: Bool, _ nowNs: UInt64) {
    guard logTearStats, changed, latestSeedArrivalNs != 0, nowNs >= latestSeedArrivalNs else { return }
    captureWaitSumMs += Double(nowNs - latestSeedArrivalNs) / 1_000_000
    captureWaitMax = max(captureWaitMax, Double(nowNs - latestSeedArrivalNs) / 1_000_000)
    captureWaitN += 1
    if captureWaitN >= 150 {
        fputs(String(format: "info: capture-wait avg=%.1fms max=%.1fms n=%d\n",
                     captureWaitSumMs / Double(captureWaitN), captureWaitMax, captureWaitN), stderr)
        captureWaitSumMs = 0; captureWaitMax = 0; captureWaitN = 0
    }
}

let regSel = NSSelectorFromString(
    "registerScreenCallbacksWithUUID:callbackQueue:frameCallback:" +
    "surfacesChangedCallback:propertiesChangedCallback:"
)

// The frame callback fires for every frame the simulator draws (60 a second or more while anything moves), and it
// used to walk every descriptor for its surface each time — ~3 points of a core while a video played, for an answer
// that does not change: the simulator draws each panel into one surface in place, and four rotations and an appearance
// change left the same surface (same id and size) with one surfaces-changed callback, at registration (measured,
// iOS 26). So the surface is looked up when the simulator says the surfaces changed, when a panel is selected, and
// once a second from the timer in case a runtime changes one without saying so. The frame callback only feeds
// capture-wait, and only when that is being measured.
func noteFrameArrival() {
    guard logTearStats, let surf = latestSurface else { return }
    let s = IOSurfaceGetSeed(surf)
    if s != lastObservedSeed { lastObservedSeed = s; latestSeedArrivalNs = DispatchTime.now().uptimeNanoseconds }
}

for desc in descriptors where desc.responds(to: regSel) {
    guard let imp = class_getMethodImplementation(type(of: desc), regSel) else { continue }
    let uuid = NSUUID()
    let onFrame:    @convention(block) () -> Void = { if logTearStats { captureQueue.async { noteFrameArrival() } } }
    let onSurfaces: @convention(block) () -> Void = { captureQueue.async { updateLatestSurface() } }
    let onProps:    @convention(block) () -> Void = {}
    callbackBlocks += [onFrame as AnyObject, onSurfaces as AnyObject, onProps as AnyObject]
    typealias RegFn = @convention(c) (
        AnyObject, Selector, AnyObject, AnyObject, AnyObject, AnyObject, AnyObject) -> Void
    unsafeBitCast(imp, to: RegFn.self)(
        desc, regSel,
        uuid, captureQueue as AnyObject,
        onFrame as AnyObject, onSurfaces as AnyObject, onProps as AnyObject)
}

// Seed latestSurface — retry for older runtimes where the surface may not be
// readable immediately after port enumeration (iOS 17.x co-boot scenario)
captureQueue.sync {
    for attempt in 1...10 {
        updateLatestSurface()
        if latestSurface != nil { break }
        fputs("info: framebufferSurface nil (attempt \(attempt)/10), retrying in 300ms...\n", stderr)
        Thread.sleep(forTimeInterval: 0.3)
    }
}
if latestSurface == nil {
    fputs("warning: initial framebufferSurface seed failed — relying on callbacks\n", stderr)
}

// Watchdog: exit(1) if no frames produced within 8 seconds of startup.
// This lets ScreenCaptureStreamer surface the error so the agent can clean up.
DispatchQueue.global().asyncAfter(deadline: .now() + 8) {
    guard !firstFrameSent else { return }
    fputs("error: no frames produced within 8s — framebuffer may be unavailable\n", stderr)
    exit(1)
}

// Timer-driven emission: fires at the target FPS and encodes the latest surface.
// Static-skip: when the IOSurface seed is unchanged (screen static), the frame is not
// re-encoded — the decoder holds the last (pixel-identical) frame — until a keep-alive
// interval elapses. JPEG keep-alive is 100ms (large frames). H.264 keep-alive is 1s: a
// forced keyframe on viewer (re)join (relay → stream:request-idr) covers new viewers, so the
// idle heartbeat can be sparse to spare the client's decode CPU. Safe now that MSE is gone.
let h264KeepAliveMs = 1000.0
var lastSeed: UInt32 = 0
var lastSentNs: UInt64 = 0

let timer = DispatchSource.makeTimerSource(queue: captureQueue)
timer.schedule(deadline: .now(), repeating: 1.0 / fps)
timer.setEventHandler {
    if latestSurface == nil || DispatchTime.now().uptimeNanoseconds - lastSurfaceWalkNs >= 1_000_000_000 {
        updateLatestSurface()
    }
    // Taken after the walk: a walk that meets an unseen seed stamps its arrival now, and an earlier `nowNs` would make
    // capture-wait's unsigned subtraction negative, which traps (review finding).
    let nowNs = DispatchTime.now().uptimeNanoseconds
    guard let surf = latestSurface else { return }
    if useH264 {
        // Static-skip an unchanged screen so idle viewers stop decoding (the decoder holds the
        // last, identical frame). With no frames generated during the gap, the next P-frame
        // still references the last *sent* frame, so the chain stays intact. A pending forced
        // keyframe (set on viewer (re)join / drop recovery via the relay) bypasses the skip so
        // (re)joiners get a decodable keyframe even on a static screen.
        let seed = IOSurfaceGetSeed(surf)
        let elapsedMs = Double(nowNs - lastSentNs) / 1_000_000
        if seed == lastSeed && elapsedMs < h264KeepAliveMs && !pendingForceKeyFrame { return }
        let changed = seed != lastSeed
        lastSeed = seed
        lastSentNs = nowNs
        encodeH264(surf)  // firstFrameSent is set in the compression output callback
        recordCaptureWait(changed, nowNs)
        // tear-guard stats (TAPFLOW_STREAM_METRICS=1): retries climb during scroll, flat when static.
        if logTearStats && h264FrameIndex % 150 == 0 {
            fputs("info: tear-guard retries=\(tearRetries) exhausted=\(tearExhausted) frames=\(h264FrameIndex)\n", stderr)
        }
    } else {
        // JPEG frames are large, so skip re-encoding an unchanged screen (keep-alive
        // every 100ms). seed = IOSurface generation counter.
        let seed = IOSurfaceGetSeed(surf)
        let elapsedMs = Double(nowNs - lastSentNs) / 1_000_000
        if seed == lastSeed && elapsedMs < 100 { return }
        let changed = seed != lastSeed
        guard let jpeg = encodeJPEG(surf) else { return }
        lastSeed = seed
        lastSentNs = nowNs
        firstFrameSent = true
        writeFrame(jpeg)
        recordCaptureWait(changed, nowNs)
    }
}
timer.resume()

// stdin command channel, read for both codecs:
//  - a 0x01 byte forces an IDR on the next H.264 frame. The relay sends this for drop-to-keyframe
//    recovery so the stream resyncs fast instead of waiting for the periodic IDR. JPEG ignores it.
//  - a text line `panel <w>x<h>\n` switches a multi-panel device's capture to that panel. It used to be
//    H.264-only; a JPEG session (TAPFLOW_IOS_CODEC=jpeg, or a browser without H.264) then had no way to
//    follow a fold. Text never contains 0x01, so the two cannot be confused; lines are buffered because
//    `availableData` chunks are arbitrary.
// Everything is applied on captureQueue, the only queue that touches the capture state.
var stdinText = ""
FileHandle.standardInput.readabilityHandler = { handle in
    let data = handle.availableData
    if data.isEmpty { handle.readabilityHandler = nil; return } // stdin closed
    if data.contains(0x01) { captureQueue.async { pendingForceKeyFrame = true } }
    stdinText += String(decoding: data.filter { $0 != 0x01 }, as: UTF8.self)
    while let nl = stdinText.firstIndex(of: "\n") {
        let line = String(stdinText[..<nl]).trimmingCharacters(in: .whitespaces)
        stdinText = String(stdinText[stdinText.index(after: nl)...])
        let parts = line.split(separator: " ")
        guard parts.count == 2, parts[0] == "panel", let panel = parsePanel(String(parts[1])) else {
            if !line.isEmpty { fputs("warning: unknown stdin command '\(line)'\n", stderr) }
            continue
        }
        captureQueue.async {
            selectedPanel = panel
            updateLatestSurface()
            // The new panel's seed is unrelated to the old one's, so a match must not read as "static", and
            // the first frame of a new size has to be a keyframe (encodeH264 also forces one on a size change).
            lastSeed = 0
            lastSentNs = 0
            pendingForceKeyFrame = true
            fputs("info: capturing panel \(panel.0)x\(panel.1)\n", stderr)
        }
    }
}

fputs("info: streaming started (\(Int(fps))fps, udid=\(targetUDID))\n", stderr)
RunLoop.main.run()
