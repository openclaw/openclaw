import os

base_dir = '/home/mertb/.openclaw/workspace/watch-ceviz/apple-watch'
os.makedirs(base_dir, exist_ok=True)

models = """import Foundation

// Mirrors watch-command-request.schema.json
struct WatchCommandRequest: Codable {
    let audioData: String
    let format: String
    let clientTimestamp: String?

    enum CodingKeys: String, CodingKey {
        case audioData = "audio_data"
        case format
        case clientTimestamp = "client_timestamp"
    }
}

// Mirrors watch-command-response.schema.json
struct WatchCommandResponse: Codable {
    let status: String
    let transcript: String
    let summaryText: String
    let ttsAudioData: String?
    let ttsFormat: String?
    let requiresPhoneHandoff: Bool
    let handoffUrl: String?
    let jobId: String?

    enum CodingKeys: String, CodingKey {
        case status
        case transcript
        case summaryText = "summary_text"
        case ttsAudioData = "tts_audio_data"
        case ttsFormat = "tts_format"
        case requiresPhoneHandoff = "requires_phone_handoff"
        case handoffUrl = "handoff_url"
        case jobId = "job_id"
    }
}
"""

watch_session_manager = """import Foundation
import WatchConnectivity
import Combine

class WatchSessionManager: NSObject, ObservableObject, WCSessionDelegate {
    @Published var isReachable = false
    @Published var responseText = "Ready"
    
    // Add reference to audio player to play tts immediately upon response
    var audioPlayerManager: AudioPlayerManager?

    override init() {
        super.init()
        if WCSession.isSupported() {
            let session = WCSession.default
            session.delegate = self
            session.activate()
        }
    }

    func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {
        DispatchQueue.main.async {
            self.isReachable = session.isReachable
        }
    }

    func sessionReachabilityDidChange(_ session: WCSession) {
        DispatchQueue.main.async {
            self.isReachable = session.isReachable
        }
    }

    func sendAudioCommand(audioBase64: String) {
        let request = WatchCommandRequest(
            audioData: audioBase64,
            format: "m4a",
            clientTimestamp: ISO8601DateFormatter().string(from: Date())
        )
        
        guard let data = try? JSONEncoder().encode(request) else {
            DispatchQueue.main.async {
                self.responseText = "Encoding Error"
            }
            return
        }

        guard WCSession.default.isReachable else {
            DispatchQueue.main.async {
                self.responseText = "Phone not reachable"
            }
            return
        }

        DispatchQueue.main.async {
            self.responseText = "Sending..."
        }

        WCSession.default.sendMessageData(data, replyHandler: { replyData in
            guard let response = try? JSONDecoder().decode(WatchCommandResponse.self, from: replyData) else {
                DispatchQueue.main.async {
                    self.responseText = "Invalid Response"
                }
                return
            }
            
            DispatchQueue.main.async {
                self.responseText = response.summaryText
                
                if let ttsBase64 = response.ttsAudioData, let format = response.ttsFormat {
                    self.audioPlayerManager?.play(base64Data: ttsBase64, format: format)
                }
            }
        }, errorHandler: { error in
            DispatchQueue.main.async {
                self.responseText = "Error: \(error.localizedDescription)"
            }
        })
    }
}
"""

audio_recorder_manager = """import Foundation
import AVFoundation

class AudioRecorderManager: NSObject, ObservableObject, AVAudioRecorderDelegate {
    var audioRecorder: AVAudioRecorder?
    var recordingURL: URL?

    func startRecording() {
        let session = AVAudioSession.sharedInstance()
        do {
            try session.setCategory(.playAndRecord, mode: .default)
            try session.setActive(true)
            
            let tempDir = FileManager.default.temporaryDirectory
            recordingURL = tempDir.appendingPathComponent("command.m4a")
            
            let settings: [String: Any] = [
                AVFormatIDKey: Int(kAudioFormatMPEG4AAC),
                AVSampleRateKey: 16000,
                AVNumberOfChannelsKey: 1,
                AVEncoderAudioQualityKey: AVAudioQuality.medium.rawValue
            ]
            
            if let url = recordingURL {
                audioRecorder = try AVAudioRecorder(url: url, settings: settings)
                audioRecorder?.delegate = self
                audioRecorder?.record()
            }
        } catch {
            print("Failed to setup recording: \(error)")
        }
    }

    func stopRecording() -> String? {
        audioRecorder?.stop()
        audioRecorder = nil
        
        guard let url = recordingURL,
              let data = try? Data(contentsOf: url) else {
            return nil
        }
        
        return data.base64EncodedString()
    }
}
"""

audio_player_manager = """import Foundation
import AVFoundation

class AudioPlayerManager: NSObject, ObservableObject, AVAudioPlayerDelegate {
    var audioPlayer: AVAudioPlayer?
    @Published var isPlaying = false

    func play(base64Data: String, format: String) {
        guard let data = Data(base64Encoded: base64Data) else { return }
        
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playback, mode: .default)
            try session.setActive(true)
            
            audioPlayer = try AVAudioPlayer(data: data)
            audioPlayer?.delegate = self
            audioPlayer?.play()
            
            DispatchQueue.main.async {
                self.isPlaying = true
            }
        } catch {
            print("Playback error: \(error.localizedDescription)")
        }
    }

    func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        DispatchQueue.main.async {
            self.isPlaying = false
        }
    }
}
"""

content_view = """import SwiftUI

struct ContentView: View {
    @StateObject private var sessionManager = WatchSessionManager()
    @StateObject private var recorder = AudioRecorderManager()
    @StateObject private var player = AudioPlayerManager()
    
    @State private var isRecording = false
    
    var body: some View {
        VStack(spacing: 16) {
            Text(sessionManager.responseText)
                .font(.footnote)
                .multilineTextAlignment(.center)
                .lineLimit(3)
                .frame(maxHeight: 60)
            
            Spacer()
            
            Button(action: {
                if isRecording {
                    stop()
                } else {
                    start()
                }
            }) {
                Image(systemName: isRecording ? "mic.fill" : "mic")
                    .font(.system(size: 40))
                    .foregroundColor(isRecording ? .red : .white)
                    .padding()
            }
            .buttonStyle(PlainButtonStyle())
            .background(Circle().fill(isRecording ? Color.red.opacity(0.3) : Color.blue.opacity(0.3)))
            
            Spacer()
            
            if !sessionManager.isReachable {
                Text("iPhone disconnected")
                    .font(.caption2)
                    .foregroundColor(.red)
            }
        }
        .padding()
        .onAppear {
            sessionManager.audioPlayerManager = player
        }
    }
    
    private func start() {
        isRecording = true
        recorder.startRecording()
    }
    
    private func stop() {
        isRecording = false
        if let base64Audio = recorder.stopRecording() {
            sessionManager.sendAudioCommand(audioBase64: base64Audio)
        } else {
            sessionManager.responseText = "Failed to capture audio"
        }
    }
}

struct ContentView_Previews: PreviewProvider {
    static var previews: some View {
        ContentView()
    }
}
"""

watch_app = """import SwiftUI

@main
struct WatchCeviz_Watch_AppApp: App {
    var body: some Scene {
        WindowGroup {
            ContentView()
        }
    }
}
"""

readme = """# Package B4: Apple Watch App (Client)

This package contains the implementation-ready Swift files for the watchOS Client App. It acts as the remote for OpenClaw.

## Features Implemented
- **Push-to-Talk UI:** A simple SwiftUI interface with a single large microphone button to record audio commands.
- **Audio Capture:** Uses `AVAudioRecorder` to capture m4a voice buffers, minimizing bandwidth.
- **Bridge Connectivity:** Implements `WCSessionDelegate` to forward base64-encoded audio directly to the iPhone Companion App.
- **Response Handling:** Receives `WatchCommandResponse` from the phone, updates the text on screen, and plays the TTS using `AVAudioPlayer`.

## Architecture

- `WatchApp.swift`: App Entry point.
- `ContentView.swift`: Main UI layer. Shows connection status and response text.
- `AudioRecorderManager.swift`: Handles M4A recording and Base64 extraction.
- `WatchSessionManager.swift`: Handles WCSession communication, converting the returned JSON payload and initiating playback.
- `AudioPlayerManager.swift`: Plays the returned TTS binary.
- `Models.swift`: Shared data structures.

## Verification
In this headless environment, you can review the code logic against the Phase 3 requirements. The iOS bridge Simulator in `../ios-bridge` already validates the message shapes expected by this watch client. To build and test:
1. Open the project in Xcode (on a Mac).
2. Run the watchOS target in the Simulator or on a physical Apple Watch paired with the iPhone.
"""

files = {
    'Models.swift': models,
    'WatchSessionManager.swift': watch_session_manager,
    'AudioRecorderManager.swift': audio_recorder_manager,
    'AudioPlayerManager.swift': audio_player_manager,
    'ContentView.swift': content_view,
    'WatchApp.swift': watch_app,
    'README.md': readme
}

for name, content in files.items():
    with open(os.path.join(base_dir, name), 'w') as f:
        f.write(content)

print("Files created successfully.")
