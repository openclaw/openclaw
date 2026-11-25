import Foundation

@MainActor
final class IOSDeviceSettingsReply {
    typealias Handler = @MainActor (Any?, String?) -> Void

    private var handler: Handler?

    init(_ handler: @escaping Handler) {
        self.handler = handler
    }

    func finish(_ value: Any? = nil, error: String? = nil) {
        let handler = self.handler
        self.handler = nil
        handler?(value, error)
    }

    func retire() {
        self.finish(error: "The device settings document is no longer available.")
    }
}
