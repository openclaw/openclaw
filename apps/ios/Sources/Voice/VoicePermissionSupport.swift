import AVFAudio
import Foundation
import Speech

enum VoicePermissionSupport {
    static func requestMicrophonePermission() async -> Bool {
        let status = AVAudioApplication.shared.recordPermission
        guard status == .undetermined else { return status == .granted }
        // The OS prompt owns its lifetime; the bridge handles cancellation.
        return await PermissionRequestBridge.awaitRequest { completion in
            AVAudioApplication.requestRecordPermission(completionHandler: completion)
        }
    }

    static func requestSpeechPermission() async -> Bool {
        let status = SFSpeechRecognizer.authorizationStatus()
        guard status == .notDetermined else { return status == .authorized }
        return await PermissionRequestBridge.awaitRequest { completion in
            SFSpeechRecognizer.requestAuthorization { authStatus in
                completion(authStatus == .authorized)
            }
        }
    }

    static func speechPermissionMessage(
        kind: String,
        status: SFSpeechRecognizerAuthorizationStatus) -> String
    {
        let format = switch status {
        case .restricted:
            String(localized: "%@ permission restricted")
        case .notDetermined:
            String(localized: "%@ permission not granted")
        default:
            String(localized: "%@ permission denied")
        }
        return String(format: format, kind)
    }
}
