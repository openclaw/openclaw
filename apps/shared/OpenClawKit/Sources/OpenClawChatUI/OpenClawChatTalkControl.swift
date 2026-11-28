public struct OpenClawChatAudioInputDevice: Equatable, Identifiable, Sendable {
    public var id: String
    public var name: String

    public init(id: String, name: String) {
        self.id = id
        self.name = name
    }
}

public enum OpenClawCameraFacingSelection: String, Equatable, Sendable {
    case back
    case front
}

/// Where a live voice conversation is. The app's Talk owner decides it; the composer only shows it.
public enum OpenClawChatTalkPhase: Equatable, Sendable {
    /// Talk is on but not listening yet: permissions, setup, reconnecting.
    case connecting
    /// The microphone is open. Mute is a separate fact on the control.
    case listening
    /// The person's words went out; the microphone stays closed until the reply is spoken.
    case thinking
    case speaking
    case issue(OpenClawChatTalkIssue)
}

/// Why Talk is on but cannot carry the conversation right now.
public enum OpenClawChatTalkIssue: Equatable, Sendable {
    case microphoneAccess
    case speechRecognitionAccess
    case offline
    case notAllowed
    case approvalRequested
    case startFailed
    case replyFailed
    case speechFailed
}

public struct OpenClawChatTalkControl {
    public var isEnabled: Bool
    public var isListening: Bool
    public var isSpeaking: Bool
    public var isGatewayConnected: Bool
    public var statusText: String
    /// Nil where the host only reports listening and speaking (macOS); the composer derives the rest.
    public var phase: OpenClawChatTalkPhase?
    public var providerLabel: String
    public var level: Double
    public var isMicrophoneMuted: Bool
    public var toggleMicrophone: (@MainActor () -> Void)?
    public var partialTranscript: String
    public var recentTranscript: [String]
    public var inputDevices: [OpenClawChatAudioInputDevice]
    public var selectedInputDeviceID: String?
    public var selectInputDevice: (@MainActor (_ deviceID: String?) -> Void)?
    public var cameraFacing: OpenClawCameraFacingSelection?
    public var flipCamera: (@MainActor () -> Void)?
    /// Opens the app's page in Settings, offered when an access issue stops Talk.
    public var openSettings: (@MainActor () -> Void)?
    public var toggle: @MainActor (_ sessionKey: String) -> Void

    private let levelProvider: (@MainActor () -> Double)?

    /// When supplied, `levelProvider` overrides `level` only for live waveform rendering.
    public init(
        isEnabled: Bool,
        isListening: Bool,
        isSpeaking: Bool,
        isGatewayConnected: Bool,
        statusText: String,
        phase: OpenClawChatTalkPhase? = nil,
        providerLabel: String,
        level: Double = 0,
        levelProvider: (@MainActor () -> Double)? = nil,
        isMicrophoneMuted: Bool = false,
        toggleMicrophone: (@MainActor () -> Void)? = nil,
        partialTranscript: String = "",
        recentTranscript: [String] = [],
        inputDevices: [OpenClawChatAudioInputDevice] = [],
        selectedInputDeviceID: String? = nil,
        selectInputDevice: (@MainActor (_ deviceID: String?) -> Void)? = nil,
        cameraFacing: OpenClawCameraFacingSelection? = nil,
        flipCamera: (@MainActor () -> Void)? = nil,
        openSettings: (@MainActor () -> Void)? = nil,
        toggle: @escaping @MainActor (_ sessionKey: String) -> Void)
    {
        self.isEnabled = isEnabled
        self.isListening = isListening
        self.isSpeaking = isSpeaking
        self.isGatewayConnected = isGatewayConnected
        self.statusText = statusText
        self.phase = phase
        self.providerLabel = providerLabel
        self.level = level
        self.levelProvider = levelProvider
        self.isMicrophoneMuted = isMicrophoneMuted
        self.toggleMicrophone = toggleMicrophone
        self.partialTranscript = partialTranscript
        self.recentTranscript = recentTranscript
        self.inputDevices = inputDevices
        self.selectedInputDeviceID = selectedInputDeviceID
        self.selectInputDevice = selectInputDevice
        self.cameraFacing = cameraFacing
        self.flipCamera = flipCamera
        self.openSettings = openSettings
        self.toggle = toggle
    }

    /// Resolve only in the waveform leaf, never while constructing the enclosing chat view.
    @MainActor var resolvedLevel: Double {
        self.levelProvider?() ?? self.level
    }

    var resolvedPhase: OpenClawChatTalkPhase {
        if let phase { return phase }
        if self.isListening { return .listening }
        return self.isSpeaking ? .speaking : .thinking
    }
}
