@preconcurrency import AVFoundation
import AudioToolbox
import Darwin
import Foundation

private let defaultProcessNames = ["avconferenced", "FaceTime", "Phone"]
private let outputSampleRate = 24_000.0

private enum CaptureError: LocalizedError {
  case audioProcessNotFound([String])
  case coreAudio(String, OSStatus)
  case invalidAudioFormat
  case usageDescriptionMissing
  case conversionFailed(String)

  var errorDescription: String? {
    switch self {
    case .audioProcessNotFound(let names):
      return
        "No FaceTime audio process was found (looked for: \(names.joined(separator: ", "))). Open FaceTime before starting the bridge."
    case .coreAudio(let operation, let status):
      return "\(operation) failed with Core Audio status \(status)."
    case .invalidAudioFormat:
      return "Core Audio returned an unsupported audio format."
    case .usageDescriptionMissing:
      return
        "The capture helper is missing its embedded NSAudioCaptureUsageDescription. Run pnpm build:capture."
    case .conversionFailed(let message):
      return "Audio conversion failed: \(message)"
    }
  }
}

private struct Arguments {
  var checkOnly = false
  var listDefaultDevices = false
  var listProcesses = false
  var processNames = defaultProcessNames

  static func parse(_ raw: [String]) throws -> Arguments {
    var result = Arguments()
    var customProcessNames: [String] = []
    var index = 0
    while index < raw.count {
      switch raw[index] {
      case "--check":
        result.checkOnly = true
      case "--default-devices":
        result.listDefaultDevices = true
      case "--list-processes":
        result.listProcesses = true
      case "--process":
        index += 1
        guard index < raw.count, !raw[index].isEmpty else {
          throw CaptureError.audioProcessNotFound(["<missing --process value>"])
        }
        customProcessNames.append(raw[index])
      default:
        fputs("Unknown argument: \(raw[index])\n", stderr)
        exit(2)
      }
      index += 1
    }
    if !customProcessNames.isEmpty {
      result.processNames = customProcessNames
    }
    return result
  }
}

private struct AudioProcess {
  let name: String
  let objectID: AudioObjectID
  let pid: pid_t
  let runningOutput: Bool
}

private struct AudioDeviceDescription: Codable {
  let isAggregate: Bool
  let name: String
  let uid: String
}

private struct DefaultAudioDevices: Codable {
  let input: AudioDeviceDescription
  let output: AudioDeviceDescription
}

extension AudioObjectID {
  fileprivate static var system: AudioObjectID { AudioObjectID(kAudioObjectSystemObject) }

  fileprivate func read<T>(
    _ selector: AudioObjectPropertySelector,
    defaultValue: T,
    qualifierSize: UInt32 = 0,
    qualifier: UnsafeRawPointer? = nil
  ) throws -> T {
    var address = AudioObjectPropertyAddress(
      mSelector: selector,
      mScope: kAudioObjectPropertyScopeGlobal,
      mElement: kAudioObjectPropertyElementMain)
    var dataSize: UInt32 = 0
    var status = AudioObjectGetPropertyDataSize(
      self,
      &address,
      qualifierSize,
      qualifier,
      &dataSize)
    guard status == noErr else {
      throw CaptureError.coreAudio("Read property size \(selector)", status)
    }
    var value = defaultValue
    status = withUnsafeMutablePointer(to: &value) { pointer in
      AudioObjectGetPropertyData(
        self,
        &address,
        qualifierSize,
        qualifier,
        &dataSize,
        pointer)
    }
    guard status == noErr else {
      throw CaptureError.coreAudio("Read property \(selector)", status)
    }
    return value
  }

  fileprivate func readProcessList() throws -> [AudioObjectID] {
    var address = AudioObjectPropertyAddress(
      mSelector: kAudioHardwarePropertyProcessObjectList,
      mScope: kAudioObjectPropertyScopeGlobal,
      mElement: kAudioObjectPropertyElementMain)
    var dataSize: UInt32 = 0
    var status = AudioObjectGetPropertyDataSize(self, &address, 0, nil, &dataSize)
    guard status == noErr else {
      throw CaptureError.coreAudio("Read audio process list size", status)
    }
    var values = [AudioObjectID](
      repeating: kAudioObjectUnknown,
      count: Int(dataSize) / MemoryLayout<AudioObjectID>.size)
    status = AudioObjectGetPropertyData(self, &address, 0, nil, &dataSize, &values)
    guard status == noErr else {
      throw CaptureError.coreAudio("Read audio process list", status)
    }
    return values
  }

  fileprivate func readString(_ selector: AudioObjectPropertySelector) throws -> String {
    try read(selector, defaultValue: "" as CFString) as String
  }
}

private func processName(pid: pid_t) -> String {
  var buffer = [CChar](repeating: 0, count: Int(MAXPATHLEN))
  let count = proc_name(pid, &buffer, UInt32(buffer.count))
  guard count > 0 else { return "pid-\(pid)" }
  return String(cString: buffer)
}

private func readAudioProcesses() throws -> [AudioProcess] {
  try AudioObjectID.system.readProcessList().compactMap { objectID in
    do {
      let pid: pid_t = try objectID.read(kAudioProcessPropertyPID, defaultValue: -1)
      let running: UInt32 = try objectID.read(
        kAudioProcessPropertyIsRunningOutput,
        defaultValue: 0)
      let bundleID = (try? objectID.readString(kAudioProcessPropertyBundleID)) ?? ""
      let executableName = processName(pid: pid)
      let name = bundleID == "com.apple.FaceTime" ? "FaceTime" : executableName
      return AudioProcess(
        name: name,
        objectID: objectID,
        pid: pid,
        runningOutput: running != 0)
    } catch {
      return nil
    }
  }
}

private func readDefaultAudioDevice(
  _ selector: AudioObjectPropertySelector
) throws -> AudioDeviceDescription {
  let device: AudioDeviceID = try AudioObjectID.system.read(
    selector,
    defaultValue: AudioDeviceID(kAudioObjectUnknown))
  let objectClass: AudioClassID = try device.read(
    kAudioObjectPropertyClass,
    defaultValue: AudioClassID(0))
  return AudioDeviceDescription(
    isAggregate: objectClass == kAudioAggregateDeviceClassID,
    name: try device.readString(kAudioObjectPropertyName),
    uid: try device.readString(kAudioDevicePropertyDeviceUID))
}

private func readDefaultAudioDevices() throws -> DefaultAudioDevices {
  try DefaultAudioDevices(
    input: readDefaultAudioDevice(kAudioHardwarePropertyDefaultInputDevice),
    output: readDefaultAudioDevice(kAudioHardwarePropertyDefaultOutputDevice))
}

private final class ConverterInput: @unchecked Sendable {
  var buffer: AVAudioPCMBuffer?

  init(_ buffer: AVAudioPCMBuffer) {
    self.buffer = buffer
  }
}

private final class PCMWriter: @unchecked Sendable {
  private let targetFormat = AVAudioFormat(
    commonFormat: .pcmFormatInt16,
    sampleRate: outputSampleRate,
    channels: 1,
    interleaved: true)!
  private let sourceFormat: AVAudioFormat
  private let converter: AVAudioConverter

  init(streamDescription: AudioStreamBasicDescription) throws {
    var description = streamDescription
    guard let sourceFormat = AVAudioFormat(streamDescription: &description),
      let converter = AVAudioConverter(from: sourceFormat, to: self.targetFormat)
    else {
      throw CaptureError.invalidAudioFormat
    }
    self.sourceFormat = sourceFormat
    self.converter = converter
  }

  func write(_ audioBufferList: UnsafePointer<AudioBufferList>) throws {
    guard
      let sourceBuffer = AVAudioPCMBuffer(
        pcmFormat: self.sourceFormat,
        bufferListNoCopy: audioBufferList,
        deallocator: nil)
    else {
      throw CaptureError.invalidAudioFormat
    }
    let ratio = self.targetFormat.sampleRate / self.sourceFormat.sampleRate
    let capacity = AVAudioFrameCount(ceil(Double(sourceBuffer.frameLength) * ratio)) + 1
    guard
      let outputBuffer = AVAudioPCMBuffer(
        pcmFormat: self.targetFormat,
        frameCapacity: capacity)
    else {
      throw CaptureError.invalidAudioFormat
    }

    let input = ConverterInput(sourceBuffer)
    var conversionError: NSError?
    let status = self.converter.convert(to: outputBuffer, error: &conversionError) { _, status in
      guard let buffer = input.buffer else {
        status.pointee = .noDataNow
        return nil
      }
      input.buffer = nil
      status.pointee = .haveData
      return buffer
    }
    if status == .error {
      throw CaptureError.conversionFailed(
        conversionError?.localizedDescription ?? "unknown converter error")
    }
    guard outputBuffer.frameLength > 0,
      let samples = outputBuffer.int16ChannelData?[0]
    else {
      return
    }
    let byteCount = Int(outputBuffer.frameLength) * MemoryLayout<Int16>.size
    FileHandle.standardOutput.write(Data(bytes: samples, count: byteCount))
  }
}

private final class ProcessTap: @unchecked Sendable {
  private var aggregateDeviceID = AudioObjectID(kAudioObjectUnknown)
  private var ioProcID: AudioDeviceIOProcID?
  private var tapID = AudioObjectID(kAudioObjectUnknown)
  private let tapDescription: CATapDescription
  private let writer: PCMWriter

  init(processObjectIDs: [AudioObjectID]) throws {
    self.tapDescription = CATapDescription(stereoMixdownOfProcesses: processObjectIDs)
    self.tapDescription.uuid = UUID()
    self.tapDescription.muteBehavior = .unmuted

    var createdTapID = AudioObjectID(kAudioObjectUnknown)
    var status = AudioHardwareCreateProcessTap(self.tapDescription, &createdTapID)
    guard status == noErr else {
      throw CaptureError.coreAudio("Create FaceTime process tap", status)
    }
    self.tapID = createdTapID
    fputs("facetime-audio-capture: created FaceTime process tap\n", stderr)

    let streamDescription: AudioStreamBasicDescription = try createdTapID.read(
      kAudioTapPropertyFormat,
      defaultValue: AudioStreamBasicDescription())
    self.writer = try PCMWriter(streamDescription: streamDescription)

    // Keep hardware subdevices out of this aggregate. A duplex headset would
    // add unrelated input buffers to the callback, which is tap-format-only.
    let aggregateDescription: [String: Any] = [
      kAudioAggregateDeviceNameKey: "OpenClaw FaceTime Capture",
      kAudioAggregateDeviceUIDKey: "ai.openclaw.facetime-capture.\(UUID().uuidString)",
      kAudioAggregateDeviceIsPrivateKey: true,
      kAudioAggregateDeviceIsStackedKey: false,
      kAudioAggregateDeviceTapAutoStartKey: true,
      kAudioAggregateDeviceTapListKey: [
        [
          kAudioSubTapDriftCompensationKey: true,
          kAudioSubTapUIDKey: self.tapDescription.uuid.uuidString,
        ]
      ],
    ]
    status = AudioHardwareCreateAggregateDevice(
      aggregateDescription as CFDictionary,
      &self.aggregateDeviceID)
    guard status == noErr else {
      self.stop()
      throw CaptureError.coreAudio("Create private aggregate tap device", status)
    }
    fputs("facetime-audio-capture: created private aggregate tap device\n", stderr)
  }

  func start() throws {
    let queue = DispatchQueue(label: "ai.openclaw.facetime-core-audio-tap")
    var createdIOProcID: AudioDeviceIOProcID?
    var status = AudioDeviceCreateIOProcIDWithBlock(
      &createdIOProcID,
      self.aggregateDeviceID,
      queue
    ) { [writer = self.writer] _, inputData, _, _, _ in
      do {
        try writer.write(inputData)
      } catch {
        fputs("facetime-audio-capture: \(error.localizedDescription)\n", stderr)
      }
    }
    guard status == noErr, let createdIOProcID else {
      throw CaptureError.coreAudio("Create tap I/O callback", status)
    }
    self.ioProcID = createdIOProcID
    status = AudioDeviceStart(self.aggregateDeviceID, createdIOProcID)
    guard status == noErr else {
      throw CaptureError.coreAudio("Start FaceTime process tap", status)
    }
    fputs("facetime-audio-capture: started FaceTime process tap\n", stderr)
  }

  func stop() {
    if self.aggregateDeviceID != kAudioObjectUnknown {
      if let ioProcID = self.ioProcID {
        _ = AudioDeviceStop(self.aggregateDeviceID, ioProcID)
        _ = AudioDeviceDestroyIOProcID(self.aggregateDeviceID, ioProcID)
        self.ioProcID = nil
      }
      _ = AudioHardwareDestroyAggregateDevice(self.aggregateDeviceID)
      self.aggregateDeviceID = kAudioObjectUnknown
    }
    if self.tapID != kAudioObjectUnknown {
      _ = AudioHardwareDestroyProcessTap(self.tapID)
      self.tapID = kAudioObjectUnknown
    }
  }

  deinit {
    self.stop()
  }
}

private func waitForTerminationSignal() async {
  await withCheckedContinuation { continuation in
    signal(SIGINT, SIG_IGN)
    signal(SIGTERM, SIG_IGN)
    let interrupt = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)
    let terminate = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
    var resumed = false
    let finish = {
      guard !resumed else { return }
      resumed = true
      interrupt.cancel()
      terminate.cancel()
      continuation.resume()
    }
    interrupt.setEventHandler(handler: finish)
    terminate.setEventHandler(handler: finish)
    interrupt.resume()
    terminate.resume()
  }
}

@main
private struct FaceTimeAudioCapture {
  static func main() async {
    do {
      let arguments = try Arguments.parse(Array(CommandLine.arguments.dropFirst()))
      guard
        let usageDescription = Bundle.main.object(
          forInfoDictionaryKey: "NSAudioCaptureUsageDescription") as? String,
        !usageDescription.isEmpty
      else {
        throw CaptureError.usageDescriptionMissing
      }
      if arguments.listDefaultDevices {
        let data = try JSONEncoder().encode(readDefaultAudioDevices())
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data("\n".utf8))
        return
      }
      let processes = try readAudioProcesses()
      if arguments.listProcesses {
        for process in processes.sorted(by: { $0.name < $1.name }) {
          fputs(
            "\(process.name)\tpid=\(process.pid)\toutput=\(process.runningOutput ? "active" : "idle")\n",
            stderr)
        }
        return
      }
      let requestedNames = Set(arguments.processNames.map { $0.lowercased() })
      let selected = processes.filter { requestedNames.contains($0.name.lowercased()) }
      guard !selected.isEmpty else {
        throw CaptureError.audioProcessNotFound(arguments.processNames)
      }
      let selectedDescription = selected.map { "\($0.name) (pid \($0.pid))" }.joined(
        separator: ", ")
      let tap = try ProcessTap(processObjectIDs: selected.map(\.objectID))
      defer { tap.stop() }
      try tap.start()
      if arguments.checkOnly {
        try await Task.sleep(for: .milliseconds(250))
        fputs(
          "facetime-audio-capture: ready; tapped audio owner(s): \(selectedDescription)\n",
          stderr)
        return
      }
      fputs(
        "facetime-audio-capture: tapping \(selectedDescription) as 24 kHz mono PCM16\n",
        stderr)
      await waitForTerminationSignal()
    } catch {
      fputs("facetime-audio-capture: \(error.localizedDescription)\n", stderr)
      exit(1)
    }
  }
}
