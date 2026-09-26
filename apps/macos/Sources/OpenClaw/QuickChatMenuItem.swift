import AppKit

@MainActor
private final class QuickChatMenuAction: NSObject {
    let action: () -> Void

    init(action: @escaping () -> Void) {
        self.action = action
    }

    @objc func invoke(_: NSMenuItem) {
        self.action()
    }
}

@MainActor
func quickChatMenuItem(title: String, selected: Bool = false, action: @escaping () -> Void) -> NSMenuItem {
    let target = QuickChatMenuAction(action: action)
    let item = NSMenuItem(title: title, action: #selector(QuickChatMenuAction.invoke(_:)), keyEquivalent: "")
    item.target = target
    // NSMenuItem's target is weak; the item owns its action for the popup's lifetime.
    item.representedObject = target
    item.state = selected ? .on : .off
    return item
}
