import AVFAudio
import Foundation
import OpenClawKit
import Speech

enum VoicePermissionSupport {
    static func requestMicrophonePermission(timeoutErrorDomain: String) async -> Bool {
        let status = AVAudioApplication.shared.recordPermission
        guard status == .undetermined else { return status == .granted }
        return await self.requestPermissionWithTimeout(errorDomain: timeoutErrorDomain) { completion in
            AVAudioApplication.requestRecordPermission(completionHandler: completion)
        }
    }

    static func requestSpeechPermission(timeoutErrorDomain: String) async -> Bool {
        let status = SFSpeechRecognizer.authorizationStatus()
        guard status == .notDetermined else { return status == .authorized }
        return await self.requestPermissionWithTimeout(errorDomain: timeoutErrorDomain) { completion in
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

    private static func requestPermissionWithTimeout(
        errorDomain: String,
        operation: @escaping @Sendable (@escaping @Sendable (Bool) -> Void) -> Void) async -> Bool
    {
        do {
            return try await AsyncTimeout.withTimeout(
                seconds: 8,
                onTimeout: { NSError(domain: errorDomain, code: 6, userInfo: [
                    NSLocalizedDescriptionKey: "permission request timed out",
                ]) },
                operation: { await PermissionRequestBridge.awaitRequest(operation) })
        } catch {
            return false
        }
    }
}
