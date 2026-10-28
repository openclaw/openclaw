import Foundation
import WebKit

extension ControlUIDocumentHost {
    /// Delivers clipboard images that WebKit drops, such as HDR screenshots, to the page's
    /// own paste handling as PNG files, the way Chrome pastes them.
    func installImagePasteDelivery() {
        self.webView.onUnreadableImagePaste = { [weak self] images in
            self?.deliverPastedImages(images)
        }
    }

    private func deliverPastedImages(_ images: [Data]) {
        guard self.isAvailable(), Self.isTrustedLinkSource(self.webView.url, dashboardURL: self.currentURL)
        else { return }
        let generation = self.generation
        let pasteID = UUID().uuidString
        // Switching conversations keeps the document, so the page records the paste's target
        // and route now. Later input reaches the page after this script.
        self.webView.callAsyncJavaScript(
            Self.scopedDashboardScript(Self.pasteTargetScript, url: self.currentURL),
            arguments: ["id": pasteID],
            in: nil,
            in: .defaultClient)
        let previousDelivery = self.imagePasteDelivery
        self.imagePasteDelivery = Task { @MainActor [weak self] in
            // Images reach the page in paste order, whichever converts first.
            await previousDelivery?.value
            let encodedPNGs = await Task.detached(priority: .userInitiated) {
                images.compactMap { DashboardPastedImages.pngData(from: $0)?.base64EncodedString() }
            }.value
            if encodedPNGs.count < images.count {
                dashboardWindowLogger.error(
                    """
                    dashboard paste converted \(encodedPNGs.count, privacy: .public) of \
                    \(images.count, privacy: .public) clipboard images to PNG
                    """)
            }
            guard let self, self.generation == generation, self.isAvailable(),
                  Self.isTrustedLinkSource(self.webView.url, dashboardURL: self.currentURL)
            else { return }
            let delivered = try? await self.webView.callAsyncJavaScript(
                "return " + Self.scopedDashboardScript(Self.pastedImagesScript, url: self.currentURL),
                arguments: ["id": pasteID, "images": encodedPNGs],
                in: nil,
                contentWorld: .defaultClient)
            if !encodedPNGs.isEmpty, delivered as? Bool != true {
                dashboardWindowLogger.info("dashboard paste dropped: its target left the page or the route changed")
            }
        }
    }

    /// Records where a native paste goes: the focused element, including one inside shadow
    /// roots, or the body when nothing has focus, together with the page's route.
    private static let pasteTargetScript = """
    let target = document.activeElement;
    while (target?.shadowRoot?.activeElement) target = target.shadowRoot.activeElement;
    (globalThis.openclawImagePastes ??= new Map()).set(id, {
      target: target ?? document.body,
      route: location.pathname + location.search,
    });
    """

    /// Dispatches the converted images to the recorded target. A composer can stay in place
    /// while the route moves to another conversation, so a changed route drops the paste.
    private static let pastedImagesScript = """
    const paste = globalThis.openclawImagePastes?.get(id);
    globalThis.openclawImagePastes?.delete(id);
    if (!paste || images.length === 0 || !paste.target.isConnected) return false;
    if (paste.route !== location.pathname + location.search) return false;
    const clipboardData = new DataTransfer();
    for (const image of images) {
      clipboardData.items.add(new File([Uint8Array.fromBase64(image)], 'image.png', {type: 'image/png'}));
    }
    paste.target.dispatchEvent(new ClipboardEvent('paste', {
      clipboardData, bubbles: true, cancelable: true, composed: true,
    }));
    return true;
    """
}
