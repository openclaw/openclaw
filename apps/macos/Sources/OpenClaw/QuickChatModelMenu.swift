import AppKit
import Observation
import OpenClawChatUI

@MainActor
private final class QuickChatModelMenuTarget: NSObject {
    let onSelectModel: (String) -> Void
    weak var menu: NSMenu?

    init(onSelectModel: @escaping (String) -> Void) {
        self.onSelectModel = onSelectModel
    }

    @objc func selectModel(_ sender: NSMenuItem) {
        guard let selectionID = sender.representedObject as? String else { return }
        self.onSelectModel(selectionID)
    }
}

@MainActor
enum QuickChatModelMenuPresenter {
    static func present(model: QuickChatModel, panel: NSPanel, contentView: NSView) {
        let target = QuickChatModelMenuTarget { [weak model] selectionID in
            model?.selectModel(selectionID)
        }
        let menu = NSMenu()
        target.menu = menu
        menu.autoenablesItems = false
        let selectedModelSelectionID = model.displayedModelSelectionID
        let modelHeader = NSMenuItem(
            title: String(localized: "Model"),
            action: nil,
            keyEquivalent: "")
        modelHeader.isEnabled = false
        menu.addItem(modelHeader)

        if model.canSelectDefaultModel {
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
        }

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
                item.state = selectedModelSelectionID == choice.selectionID ? .on : .off
                submenu.addItem(item)
            }
            providerItem.submenu = submenu
            menu.addItem(providerItem)
        }

        let windowPoint = panel.convertPoint(fromScreen: NSEvent.mouseLocation)
        let contentPoint = contentView.convert(windowPoint, from: nil)
        // NSMenu owns a snapshot; retire this popup when its choices lose authority.
        withObservationTracking {
            _ = model.modelCatalogInvalidated
        } onChange: { [weak target] in
            Task { @MainActor [weak target] in target?.menu?.cancelTracking() }
        }
        withExtendedLifetime(target) {
            _ = menu.popUp(positioning: nil, at: contentPoint, in: contentView)
        }
    }
}
