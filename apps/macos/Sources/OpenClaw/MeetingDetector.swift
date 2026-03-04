import AVFoundation
import CoreAudio
import EventKit
import Foundation
import Observation
import OSLog
import Speech

@MainActor
@Observable
final class MeetingDetector {
    static let shared = MeetingDetector()

    private let logger = Logger(subsystem: "ai.openclaw", category: "meeting.detector")
    private let eventStore = EKEventStore()
    private let transcriber = MeetingTranscriber()
    let whisperTranscriber = WhisperTranscriber()
    private var activeEngine: TranscriptionEngine?

    private(set) var currentSession: MeetingSession?
    private(set) var upcomingMeetings: [EKEvent] = []
    private(set) var calendarAccessGranted = false

    var meetingDetectionEnabled: Bool = false {
        didSet { UserDefaults.standard.set(self.meetingDetectionEnabled, forKey: "meetingDetectionEnabled") }
    }

    var adHocDetectionEnabled: Bool = true {
        didSet { UserDefaults.standard.set(self.adHocDetectionEnabled, forKey: "meetingAdHocDetectionEnabled") }
    }

    var transcriptionEngine: TranscriptionEngine {
        get {
            TranscriptionEngine(rawValue: UserDefaults.standard.string(forKey: "meetingTranscriptionEngine") ?? "whisper") ?? .whisper
        }
        set { UserDefaults.standard.set(newValue.rawValue, forKey: "meetingTranscriptionEngine") }
    }

    var whisperModelState: WhisperModelState {
        self.whisperTranscriber.modelState
    }

    private var calendarCheckTask: Task<Void, Never>?
    private var silenceCheckTask: Task<Void, Never>?
    private var talkModeWasPaused = false

    private init() {
        self.meetingDetectionEnabled = UserDefaults.standard.bool(forKey: "meetingDetectionEnabled")
        self.adHocDetectionEnabled = UserDefaults.standard.object(forKey: "meetingAdHocDetectionEnabled") as? Bool ?? true
    }

    // MARK: - Lifecycle

    func start() {
        guard self.meetingDetectionEnabled else {
            self.logger.info("meeting detector disabled, skipping start")
            return
        }
        Self.logAudioDeviceDiagnostics(logger: self.logger)
        self.logger.info("meeting detector starting (adHoc=\(self.adHocDetectionEnabled) suppress=\(self.suppressNextAutoStart) micRunning=\(Self.isMicRunning()))")
        self.startCalendarMonitor()
        self.startMicMonitor()
    }

    private nonisolated static func logAudioDeviceDiagnostics(logger: Logger) {
        let defaultID = defaultInputDeviceID()
        let devices = allAudioDeviceIDs()
        logger.info("audio diagnostics: defaultInput=\(defaultID) totalDevices=\(devices.count)")
        for device in devices {
            // Get device name
            var nameAddr = AudioObjectPropertyAddress(
                mSelector: kAudioObjectPropertyName,
                mScope: kAudioObjectPropertyScopeGlobal,
                mElement: kAudioObjectPropertyElementMain)
            var nameRef: CFString = "" as CFString
            var nameSize = UInt32(MemoryLayout<CFString>.size)
            AudioObjectGetPropertyData(device, &nameAddr, 0, nil, &nameSize, &nameRef)

            // Check input streams
            var streamAddr = AudioObjectPropertyAddress(
                mSelector: kAudioDevicePropertyStreams,
                mScope: kAudioObjectPropertyScopeInput,
                mElement: kAudioObjectPropertyElementMain)
            var streamSize: UInt32 = 0
            let streamStatus = AudioObjectGetPropertyDataSize(device, &streamAddr, 0, nil, &streamSize)
            let hasInput = streamStatus == noErr && streamSize > 0

            // Check running
            var runAddr = AudioObjectPropertyAddress(
                mSelector: kAudioDevicePropertyDeviceIsRunningSomewhere,
                mScope: kAudioObjectPropertyScopeGlobal,
                mElement: kAudioObjectPropertyElementMain)
            var running: UInt32 = 0
            var runSize = UInt32(MemoryLayout<UInt32>.size)
            let runStatus = AudioObjectGetPropertyData(device, &runAddr, 0, nil, &runSize, &running)

            if hasInput {
                logger.info("  device \(device): \"\(nameRef as String, privacy: .public)\" input=\(hasInput) running=\(running) runStatus=\(runStatus)")
            }
        }
    }

    func stop() {
        self.logger.info("meeting detector stopping")
        self.calendarCheckTask?.cancel()
        self.calendarCheckTask = nil
        self.silenceCheckTask?.cancel()
        self.silenceCheckTask = nil
        self.micPollTask?.cancel()
        self.micPollTask = nil
        if self.currentSession != nil {
            Task { await self.stopMeeting() }
        }
    }

    // MARK: - Calendar monitoring

    func requestCalendarAccess() async {
        do {
            let granted = try await self.eventStore.requestFullAccessToEvents()
            self.calendarAccessGranted = granted
            if granted {
                self.logger.info("calendar access granted")
                self.refreshUpcomingMeetings()
            } else {
                self.logger.warning("calendar access denied")
            }
        } catch {
            self.logger.error("calendar access request failed: \(error.localizedDescription, privacy: .public)")
            self.calendarAccessGranted = false
        }
    }

    private func startCalendarMonitor() {
        self.calendarCheckTask?.cancel()
        self.calendarCheckTask = Task { [weak self] in
            while let self, !Task.isCancelled {
                await self.checkCalendar()
                try? await Task.sleep(nanoseconds: 30_000_000_000) // 30 seconds
            }
        }
    }

    private func checkCalendar() async {
        let status = EKEventStore.authorizationStatus(for: .event)
        self.calendarAccessGranted = status == .fullAccess
        guard self.calendarAccessGranted else { return }

        self.refreshUpcomingMeetings()

        guard self.currentSession == nil else { return }

        // Auto-start if a calendar meeting with multiple attendees is currently in progress
        let now = Date()
        for event in self.upcomingMeetings {
            let hasMultipleAttendees = (event.attendees?.count ?? 0) >= 2
            guard hasMultipleAttendees else { continue }
            // Meeting is in progress: started up to 5 min ago and hasn't ended
            guard event.startDate <= now.addingTimeInterval(60),
                  event.startDate > now.addingTimeInterval(-300),
                  (event.endDate ?? .distantFuture) > now else { continue }

            self.logger.info("auto-starting meeting notes for: \(event.title ?? "Untitled", privacy: .public)")
            await self.startMeeting(calendarEvent: event)
            return
        }
    }

    private func refreshUpcomingMeetings() {
        let now = Date()
        let endDate = now.addingTimeInterval(3600) // next hour
        let calendars = self.eventStore.calendars(for: .event)
        let predicate = self.eventStore.predicateForEvents(withStart: now, end: endDate, calendars: calendars)
        let events = self.eventStore.events(matching: predicate)
        self.upcomingMeetings = events
            .filter { ($0.attendees?.count ?? 0) >= 2 }
            .sorted { ($0.startDate ?? .distantPast) < ($1.startDate ?? .distantPast) }
    }

    // MARK: - Mic monitoring for ad-hoc calls

    private var micPollTask: Task<Void, Never>?
    private var micWasRunning = false

    private var micPollCount = 0

    private func startMicMonitor() {
        self.micPollTask?.cancel()
        self.micPollTask = Task { [weak self] in
            while let self, !Task.isCancelled {
                if self.currentSession != nil {
                    // During recording: probe every 10s to detect if meeting ended
                    try? await Task.sleep(nanoseconds: 10_000_000_000)
                    await self.probeForMeetingEnd()
                } else {
                    // Not recording: check mic state every 2s for auto-start
                    try? await Task.sleep(nanoseconds: 2_000_000_000)
                    let running = Self.isMicRunning()
                    let wasRunning = self.micWasRunning
                    self.micWasRunning = running

                    // Log every 15th poll (~30s) or on transitions
                    self.micPollCount += 1
                    if running != wasRunning || self.micPollCount % 15 == 0 {
                        self.logger.info("mic poll: running=\(running) was=\(wasRunning) adHoc=\(self.adHocDetectionEnabled)")
                    }

                    if running, !wasRunning {
                        self.handleMicStarted()
                    }

                    // Clear suppressNextAutoStart once mic has been idle for a
                    // full poll cycle — the transient from our own shutdown is over.
                    if !running, self.suppressNextAutoStart {
                        self.suppressNextAutoStart = false
                        self.logger.info("clearing suppressNextAutoStart (mic idle)")
                    }
                }
            }
        }
    }

    /// Set to true briefly while our own transcriber is shutting down, so
    /// the mic going idle→active from that doesn't trigger a new auto-start.
    private var suppressNextAutoStart = false

    private func handleMicStarted() {
        self.logger.info("handleMicStarted: adHoc=\(self.adHocDetectionEnabled) session=\(self.currentSession != nil) suppress=\(self.suppressNextAutoStart)")
        guard self.adHocDetectionEnabled, self.currentSession == nil else { return }
        if self.suppressNextAutoStart {
            self.suppressNextAutoStart = false
            self.logger.info("mic started but suppressed (own transcriber shutdown)")
            return
        }
        self.logger.info("mic became active — auto-starting meeting notes")
        Task { await self.startMeeting() }
    }

    /// Number of consecutive probes that found the mic idle.
    private var consecutiveIdleProbes = 0

    /// Temporarily pause our audio capture, check if another app is still
    /// using the mic, then resume.  Requires 2 consecutive idle probes
    /// before auto-stopping to avoid false positives.
    private func probeForMeetingEnd() async {
        guard self.currentSession != nil else { return }

        // Pause our mic so we can see if anyone else is using the hardware
        switch self.activeEngine {
        case .whisper:
            await self.whisperTranscriber.pauseMic()
        case .apple:
            await self.transcriber.pauseMic()
        case nil:
            return
        }

        // Wait for the audio subsystem to settle
        try? await Task.sleep(nanoseconds: 500_000_000) // 500ms

        let otherAppUsing = Self.isMicRunning()

        // Resume our capture immediately
        switch self.activeEngine {
        case .whisper:
            await self.whisperTranscriber.resumeMic()
        case .apple:
            await self.transcriber.resumeMic()
        case nil:
            break
        }

        if otherAppUsing {
            if self.consecutiveIdleProbes > 0 {
                self.logger.info("probe: mic active again, resetting idle count")
            }
            self.consecutiveIdleProbes = 0
        } else {
            self.consecutiveIdleProbes += 1
            self.logger.info("probe: mic idle (count=\(self.consecutiveIdleProbes))")
            if self.consecutiveIdleProbes >= 2 {
                self.logger.info("probe: confirmed idle for 2 probes — auto-stopping meeting")
                self.consecutiveIdleProbes = 0
                await self.stopMeeting()
            }
        }
    }

    private nonisolated static func defaultInputDeviceID() -> AudioObjectID {
        let systemObject = AudioObjectID(kAudioObjectSystemObject)
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyDefaultInputDevice,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain)
        var deviceID = AudioObjectID(0)
        var size = UInt32(MemoryLayout<AudioObjectID>.size)
        let status = AudioObjectGetPropertyData(systemObject, &address, 0, nil, &size, &deviceID)
        return status == noErr ? deviceID : kAudioObjectUnknown
    }

    private nonisolated static func isMicRunning() -> Bool {
        // Check ALL input devices, not just the default — meeting apps may
        // select a non-default device.
        let devices = Self.allAudioDeviceIDs()
        for device in devices {
            // Only consider devices that have input streams
            var streamAddr = AudioObjectPropertyAddress(
                mSelector: kAudioDevicePropertyStreams,
                mScope: kAudioObjectPropertyScopeInput,
                mElement: kAudioObjectPropertyElementMain)
            var streamSize: UInt32 = 0
            guard AudioObjectGetPropertyDataSize(device, &streamAddr, 0, nil, &streamSize) == noErr,
                  streamSize > 0 else { continue }

            var runAddr = AudioObjectPropertyAddress(
                mSelector: kAudioDevicePropertyDeviceIsRunningSomewhere,
                mScope: kAudioObjectPropertyScopeGlobal,
                mElement: kAudioObjectPropertyElementMain)
            var running: UInt32 = 0
            var runSize = UInt32(MemoryLayout<UInt32>.size)
            if AudioObjectGetPropertyData(device, &runAddr, 0, nil, &runSize, &running) == noErr,
               running != 0 {
                return true
            }
        }
        return false
    }

    private nonisolated static func allAudioDeviceIDs() -> [AudioObjectID] {
        var propAddr = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyDevices,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain)
        var dataSize: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(
            AudioObjectID(kAudioObjectSystemObject), &propAddr, 0, nil, &dataSize) == noErr else {
            return []
        }
        let count = Int(dataSize) / MemoryLayout<AudioObjectID>.size
        var devices = [AudioObjectID](repeating: 0, count: count)
        guard AudioObjectGetPropertyData(
            AudioObjectID(kAudioObjectSystemObject), &propAddr, 0, nil, &dataSize, &devices) == noErr else {
            return []
        }
        return devices
    }

    // MARK: - Meeting control

    func startMeeting(title: String? = nil, calendarEvent: EKEvent? = nil) async {
        guard self.currentSession == nil else {
            self.logger.warning("meeting already in progress")
            return
        }

        // Request permissions before starting
        let permsOk = await self.ensureTranscriptionPermissions()
        if !permsOk {
            self.logger.warning("meeting transcription permissions not granted")
        }

        let meetingTitle = title ?? calendarEvent?.title ?? "Meeting \(Self.shortTimestamp())"
        let attendees = calendarEvent?.attendees?.compactMap(\.url.absoluteString) ?? []

        let engine = self.transcriptionEngine
        self.activeEngine = engine

        // Only pause TalkMode for Apple Speech (it conflicts with SFSpeechRecognizer)
        if engine == .apple {
            self.talkModeWasPaused = TalkModeController.shared.isPaused
            if !self.talkModeWasPaused {
                self.logger.info("meeting: pausing talk mode to free speech recognizer")
                TalkModeController.shared.setPaused(true)
                await TalkModeRuntime.shared.setPaused(true)
            }
        }

        let session = MeetingSession(
            title: meetingTitle,
            calendarEventId: calendarEvent?.eventIdentifier,
            attendees: attendees)
        session.start()
        self.currentSession = session
        self.consecutiveIdleProbes = 0
        self.logger.info("meeting started: \(meetingTitle, privacy: .public) engine=\(engine.rawValue, privacy: .public)")

        // Start transcription with the selected engine
        let segmentHandler: @MainActor (Speaker, String, Bool) -> Void = { [weak session] speaker, text, isFinal in
            guard let session, session.status == .recording else { return }
            session.updateLastSegment(for: speaker, text: text, isFinal: isFinal)
        }

        switch engine {
        case .whisper:
            await self.whisperTranscriber.start(onSegment: segmentHandler)
        case .apple:
            await self.transcriber.start(onSegment: segmentHandler)
        }

        self.startSilenceDetection()
    }

    // MARK: - Permission requests

    private func ensureTranscriptionPermissions() async -> Bool {
        let micStatus = await Self.requestMicPermission()
        if !micStatus {
            self.logger.warning("microphone permission denied")
        }

        // Whisper doesn't need SFSpeechRecognizer permission
        if self.transcriptionEngine == .apple {
            let speechStatus = await Self.requestSpeechPermission()
            if !speechStatus {
                self.logger.warning("speech recognition permission denied")
            }
            return micStatus && speechStatus
        }

        return micStatus
    }

    /// Must be `nonisolated` so the completion handler doesn't inherit @MainActor isolation.
    private nonisolated static func requestMicPermission() async -> Bool {
        if #available(macOS 14, *) {
            return await AVAudioApplication.requestRecordPermission()
        } else {
            return await withCheckedContinuation { cont in
                AVCaptureDevice.requestAccess(for: .audio) { granted in
                    cont.resume(returning: granted)
                }
            }
        }
    }

    /// Must be `nonisolated` so the completion handler doesn't inherit @MainActor isolation.
    private nonisolated static func requestSpeechPermission() async -> Bool {
        await withCheckedContinuation { cont in
            SFSpeechRecognizer.requestAuthorization { status in
                cont.resume(returning: status == .authorized)
            }
        }
    }

    func stopMeeting() async {
        guard let session = self.currentSession else { return }
        session.stop()

        // Stop the active transcription engine
        switch self.activeEngine {
        case .whisper:
            await self.whisperTranscriber.stop()
        case .apple:
            await self.transcriber.stop()
        case nil:
            await self.transcriber.stop()
        }

        self.silenceCheckTask?.cancel()
        self.silenceCheckTask = nil

        MeetingStore.shared.save(session: session)
        self.logger.info(
            "meeting ended: \(session.title, privacy: .public) " +
                "segments=\(session.segments.filter(\.isFinal).count)")
        self.currentSession = nil
        self.suppressNextAutoStart = true

        // Resume TalkMode if it was paused for Apple Speech
        if self.activeEngine == .apple, !self.talkModeWasPaused {
            self.logger.info("meeting: resuming talk mode")
            TalkModeController.shared.setPaused(false)
            await TalkModeRuntime.shared.setPaused(false)
        }
        self.activeEngine = nil
    }

    // MARK: - Silence detection

    private func startSilenceDetection() {
        self.silenceCheckTask?.cancel()
        self.silenceCheckTask = Task { [weak self] in
            while let self, !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 60_000_000_000) // check every 60s
                await self.checkForSilence()
            }
        }
    }

    private func checkForSilence() async {
        guard let session = self.currentSession, session.status == .recording else { return }
        // Auto-stop after 15 minutes of no new final segments
        let lastSegmentTime = session.segments.last(where: { $0.isFinal })?.timestamp ?? session.startedAt
        let silenceDuration = Date().timeIntervalSince(lastSegmentTime)
        if silenceDuration > 900 { // 15 minutes
            self.logger.info("meeting auto-ending due to 15 min silence")
            await self.stopMeeting()
        }
    }

    private static func shortTimestamp() -> String {
        let formatter = DateFormatter()
        formatter.dateFormat = "HH:mm"
        return formatter.string(from: Date())
    }
}
