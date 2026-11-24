import AVFoundation
import Speech

/// Camera, microphone and speech authorization as advertised in the node registration.
/// These frameworks post no change notifications, so the app model re-samples on activation.
struct MediaAuthorizationSnapshot: Equatable, Sendable {
    var camera: AVAuthorizationStatus
    var microphone: AVAuthorizationStatus
    var speechRecognition: SFSpeechRecognizerAuthorizationStatus

    static func current() -> Self {
        Self(
            camera: AVCaptureDevice.authorizationStatus(for: .video),
            microphone: AVCaptureDevice.authorizationStatus(for: .audio),
            speechRecognition: SFSpeechRecognizer.authorizationStatus())
    }

    var permissions: [String: Bool] {
        [
            "camera": self.camera == .authorized,
            "microphone": self.microphone == .authorized,
            "speechRecognition": self.speechRecognition == .authorized,
        ]
    }
}
