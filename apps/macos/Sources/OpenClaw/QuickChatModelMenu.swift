import AppKit
import OpenClawChatUI

@MainActor
private final class QuickChatModelMenuTarget: NSObject {
    let onSelectModel: (String) -> Void
    let onSelectThinking: (String?) -> Void
    let onSelectSpeed: (OpenClawChatFastMode?) -> Void

    init(
        onSelectModel: @escaping (String) -> Void,
        onSelectThinking: @escaping (String?) -> Void,
        onSelectSpeed: @escaping (OpenClawChatFastMode?) -> Void)
    {
        self.onSelectModel = onSelectModel
        self.onSelectThinking = onSelectThinking
        self.onSelectSpeed = onSelectSpeed
    }

    @objc func selectModel(_ sender: NSMenuItem) {
        guard let selectionID = sender.representedObject as? String else { return }
        self.onSelectModel(selectionID)
    }

    @objc func selectThinking(_ sender: NSMenuItem) {
        guard let level = sender.representedObject as? String else { return }
        self.onSelectThinking(level)
    }

    @objc func selectAutomaticThinking(_: NSMenuItem) {
        self.onSelectThinking(nil)
    }

    @objc func selectSpeed(_ sender: NSMenuItem) {
        self.onSelectSpeed((sender.representedObject as? Bool).map { $0 ? .on : .off })
    }
}

@MainActor
enum QuickChatModelMenuPresenter {
    static func present(model: QuickChatModel, panel: NSPanel, contentView: NSView) {
        let target = QuickChatModelMenuTarget(
            onSelectModel: { [weak model] selectionID in
                model?.selectModel(selectionID)
            },
            onSelectThinking: { [weak model] level in
                model?.selectThinkingLevel(level)
            },
            onSelectSpeed: { [weak model] mode in
                model?.selectSpeed(mode)
            })
        let menu = NSMenu()
        menu.autoenablesItems = false
        let modelHeader = NSMenuItem(
            title: String(localized: "Model"),
            action: nil,
            keyEquivalent: "")
        modelHeader.isEnabled = false
        menu.addItem(modelHeader)

        let defaultItem = NSMenuItem(
            title: String(localized: "Session default"),
            action: #selector(QuickChatModelMenuTarget.selectModel(_:)),
            keyEquivalent: "")
        defaultItem.target = target
        defaultItem.representedObject = OpenClawChatViewModel.defaultModelSelectionID
        defaultItem.state = model.selectedModelSelectionID == OpenClawChatViewModel.defaultModelSelectionID
            ? .on
            : .off
        menu.addItem(defaultItem)

        for section in model.modelPickerSections.providers {
            let providerItem = NSMenuItem(title: section.displayName, action: nil, keyEquivalent: "")
            let submenu = NSMenu()
            submenu.autoenablesItems = false
            for choice in section.models {
                let item = NSMenuItem(
                    title: [
                        choice.name,
                        choice.capabilityDescription,
                        choice.available == false
                            ? choice.availabilityReason?.pickerDescription ?? String(localized: "Unavailable") : "",
                    ]
                        .filter { !$0.isEmpty }.joined(separator: " — "),
                    action: #selector(QuickChatModelMenuTarget.selectModel(_:)),
                    keyEquivalent: "")
                item.target = target
                item.isEnabled = choice.available != false
                item.representedObject = choice.selectionID
                item.state = model.displayedModelSelectionID == choice.selectionID ? .on : .off
                submenu.addItem(item)
            }
            providerItem.submenu = submenu
            menu.addItem(providerItem)
        }

        menu.addItem(.separator())
        let reasoningHeader = NSMenuItem(
            title: String(localized: "Reasoning"),
            action: nil,
            keyEquivalent: "")
        reasoningHeader.isEnabled = false
        menu.addItem(reasoningHeader)
        let automaticItem = NSMenuItem(
            title: String(localized: "Auto"),
            action: #selector(QuickChatModelMenuTarget.selectAutomaticThinking(_:)),
            keyEquivalent: "")
        automaticItem.target = target
        automaticItem.state = model.selectedThinkingLevel == nil ? .on : .off
        menu.addItem(automaticItem)
        for option in model.thinkingOptions {
            let item = NSMenuItem(
                title: option.label,
                action: #selector(QuickChatModelMenuTarget.selectThinking(_:)),
                keyEquivalent: "")
            item.target = target
            item.representedObject = option.id
            item.state = model.selectedThinkingLevel == option.id ? .on : .off
            menu.addItem(item)
        }

        if model.speed.showsControls {
            let speedItem = NSMenuItem(title: String(localized: "Speed"), action: nil, keyEquivalent: "")
            let speedMenu = NSMenu()
            speedMenu.autoenablesItems = false
            for (title, value) in [
                (String(localized: "Session default"), nil as Bool?),
                (String(localized: "Fast"), true),
                (String(localized: "Normal"), false),
            ] {
                let item = NSMenuItem(
                    title: title,
                    action: #selector(QuickChatModelMenuTarget.selectSpeed(_:)),
                    keyEquivalent: "")
                item.target = target
                item.representedObject = value
                item.isEnabled = value == nil || model.speed.supportsFastMode
                item.state = (model.speed.override == nil ? value == nil : value == model.speed.isEnabled) ? .on : .off
                speedMenu.addItem(item)
            }
            speedItem.submenu = speedMenu
            menu.addItem(speedItem)
        }

        let windowPoint = panel.convertPoint(fromScreen: NSEvent.mouseLocation)
        let contentPoint = contentView.convert(windowPoint, from: nil)
        withExtendedLifetime(target) {
            _ = menu.popUp(positioning: nil, at: contentPoint, in: contentView)
        }
    }
}
