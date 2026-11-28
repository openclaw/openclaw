#if canImport(UIKit)
import UIKit
#endif

extension OpenClawChatView {
    func dismissKeyboardIfNeeded() {
        #if canImport(UIKit)
        UIApplication.shared.sendAction(
            #selector(UIResponder.resignFirstResponder),
            to: nil,
            from: nil,
            for: nil)
        #endif
    }
}
