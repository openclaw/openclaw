import AppKit
import Observation
import OpenClawChatUI

@MainActor
enum QuickChatModelMenuPresenter {
    static func present(model: QuickChatModel, panel: NSPanel, contentView: NSView) {
        let menu = NSMenu()
        menu.autoenablesItems = false
        let selectedModelSelectionID = model.displayedModelSelectionID
        let modelHeader = NSMenuItem(
            title: String(localized: "Model"),
            action: nil,
            keyEquivalent: "")
        modelHeader.isEnabled = false
        menu.addItem(modelHeader)

        if model.canSelectDefaultModel {
            let defaultItem = quickChatMenuItem(
                title: String(localized: "Session default"),
                selected: model.selectedModelSelectionID == OpenClawChatViewModel.defaultModelSelectionID)
            { [weak model] in
                model?.selectModel(OpenClawChatViewModel.defaultModelSelectionID)
            }
            menu.addItem(defaultItem)
        }

        for section in model.modelPickerSections.providers {
            let providerItem = NSMenuItem(title: section.displayName, action: nil, keyEquivalent: "")
            let submenu = NSMenu()
            submenu.autoenablesItems = false
            for choice in section.models {
                let item = quickChatMenuItem(
                    title: [
                        choice.name,
                        choice.capabilityDescription,
                        choice.available == false
                            ? choice.availabilityReason?.pickerDescription ?? String(localized: "Unavailable") : "",
                    ]
                        .filter { !$0.isEmpty }.joined(separator: " — "),
                    selected: selectedModelSelectionID == choice.selectionID)
                { [weak model] in
                    model?.selectModel(choice.selectionID)
                }
                item.isEnabled = choice.available != false
                submenu.addItem(item)
            }
            providerItem.submenu = submenu
            menu.addItem(providerItem)
        }

        let windowPoint = panel.convertPoint(fromScreen: NSEvent.mouseLocation)
        let contentPoint = contentView.convert(windowPoint, from: nil)
        // Observation can notify off actor; bind the AppKit action on MainActor first.
        let cancelTracking: @MainActor @Sendable () -> Void = { [weak menu] in
            menu?.cancelTracking()
        }
        // NSMenu owns a snapshot; retire this popup when its choices lose authority.
        withObservationTracking {
            _ = model.modelCatalogInvalidated
        } onChange: {
            Task { @MainActor in cancelTracking() }
        }
        _ = menu.popUp(positioning: nil, at: contentPoint, in: contentView)
    }
}
