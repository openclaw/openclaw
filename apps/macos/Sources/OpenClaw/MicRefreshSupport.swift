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

    @MainActor
    static func voiceWakeBinding(for state: AppState) -> Binding<Bool> {
        Binding(
            get: { state.swabbleEnabled },
            set: { newValue in
                Task { await state.setVoiceWakeEnabled(newValue) }
            })
    }
}
