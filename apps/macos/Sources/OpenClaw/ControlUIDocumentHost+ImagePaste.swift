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
        let generation = self.generation
        Task { @MainActor [weak self] in
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
            guard !encodedPNGs.isEmpty, let self, self.generation == generation, self.isAvailable(),
                  Self.isTrustedLinkSource(self.webView.url, dashboardURL: self.currentURL)
            else { return }
            _ = try? await self.webView.callAsyncJavaScript(
                Self.scopedDashboardScript(Self.pastedImagesScript, url: self.currentURL),
                arguments: ["images": encodedPNGs],
                in: nil,
                contentWorld: .defaultClient)
        }
    }

    /// Dispatches the paste a native paste would have: to the focused element,
    /// including one inside shadow roots, or to the body when nothing has focus.
    private static let pastedImagesScript = """
    let target = document.activeElement;
    while (target?.shadowRoot?.activeElement) target = target.shadowRoot.activeElement;
    const clipboardData = new DataTransfer();
    for (const image of images) {
      clipboardData.items.add(new File([Uint8Array.fromBase64(image)], 'image.png', {type: 'image/png'}));
    }
    (target ?? document.body).dispatchEvent(new ClipboardEvent('paste', {
      clipboardData, bubbles: true, cancelable: true, composed: true,
    }));
    """
}
