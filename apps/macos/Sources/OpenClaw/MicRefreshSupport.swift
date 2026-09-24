import Foundation
import SwiftUI

enum MicRefreshSupport {
    static func startObserver(_ observer: AudioInputDeviceObserver, triggerRefresh: @escaping @MainActor () -> Void) {
        observer.start {
            Task { @MainActor in
                triggerRefresh()
            }
        }
    }

    static func selectedMicName<T>(
        selectedID: String,
        in devices: [T],
        uid: KeyPath<T, String>,
        name: KeyPath<T, String>) -> String
    {
        guard !selectedID.isEmpty else { return "" }
        return devices.first(where: { $0[keyPath: uid] == selectedID })?[keyPath: name] ?? ""
    }

    @MainActor
    static func voiceWakeBinding(for state: AppState) -> Binding<Bool> {
        Binding(
            get: { state.swabbleEnabled },
            set: { newValue in
                Task { await state.setVoiceWakeEnabled(newValue) }
            })
    }
}
