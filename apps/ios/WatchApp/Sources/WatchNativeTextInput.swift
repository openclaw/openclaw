import Foundation
import WatchKit

enum WatchNativeTextInput {
    @MainActor
    static func present(
        suggestions: [String],
        onSubmit: @escaping (String) -> Void)
    {
        WKApplication.shared().visibleInterfaceController?.presentTextInputController(
            withSuggestions: suggestions,
            allowedInputMode: .allowEmoji)
        { results in
            guard let text = results?.compactMap(stringValue).first?
                .trimmingCharacters(in: .whitespacesAndNewlines),
                !text.isEmpty
            else {
                return
            }
            onSubmit(text)
        }
    }

    private static func stringValue(_ result: Any) -> String? {
        (result as? String) ?? (result as? NSAttributedString)?.string
    }
}
