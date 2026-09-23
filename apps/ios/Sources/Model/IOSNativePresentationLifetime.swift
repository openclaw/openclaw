import SwiftUI
import UIKit

/// A stable UIKit anchor owns only the registrations issued to this surface.
/// Cover disappearance keeps custody; actual removal retires these exact IDs.
@MainActor
final class IOSNativePresentationLifetime {
    private var id: UUID?
    private var cleanup: (@MainActor () -> Void)?
    #if DEBUG
    var testLifetimeObservation: (@MainActor (String) -> Void)?
    #endif

    func own(_ id: UUID, cleanup: @escaping @MainActor () -> Void) {
        guard self.id != id else { return }
        #if DEBUG
        if self.id != nil { self.testLifetimeObservation?("own-replacement") }
        #endif
        self.release()
        self.id = id
        self.cleanup = cleanup
    }

    func release() {
        let cleanup = self.cleanup
        self.id = nil
        self.cleanup = nil
        cleanup?()
    }
}

struct IOSNativePresentationAnchor: UIViewRepresentable {
    let lifetime: IOSNativePresentationLifetime

    func makeCoordinator() -> IOSNativePresentationLifetime {
        self.lifetime
    }

    func makeUIView(context _: Context) -> UIView {
        UIView(frame: .zero)
    }

    func updateUIView(_: UIView, context _: Context) {}

    static func dismantleUIView(_: UIView, coordinator: IOSNativePresentationLifetime) {
        #if DEBUG
        coordinator.testLifetimeObservation?("anchor-dismantle")
        #endif
        coordinator.release()
    }
}
