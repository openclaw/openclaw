import OpenClawKit
import SwiftUI
import VisionKit

struct QRScannerView: UIViewControllerRepresentable {
    let onGatewayLink: (GatewayConnectDeepLink) -> Void
    let onError: (String) -> Void
    let onDismiss: () -> Void

    func makeUIViewController(context: Context) -> DataScannerViewController {
        let scanner = DataScannerViewController(
            recognizedDataTypes: [.barcode(symbologies: [.qr])],
            isHighlightingEnabled: true)
        scanner.delegate = context.coordinator
        try? scanner.startScanning()
        return scanner
    }

    func updateUIViewController(_: DataScannerViewController, context _: Context) {}

    func makeCoordinator() -> Coordinator {
        Coordinator(parent: self)
    }

    final class Coordinator: NSObject, DataScannerViewControllerDelegate {
        let parent: QRScannerView
        private var handled = false

        init(parent: QRScannerView) {
            self.parent = parent
        }

        func dataScanner(_: DataScannerViewController, didAdd items: [RecognizedItem], allItems _: [RecognizedItem]) {
            guard !self.handled else { return }
            for item in items {
                guard case let .barcode(barcode) = item,
                      let payload = barcode.payloadStringValue
                else { continue }

                // Try setup code format first (base64url JSON from /pair qr).
                if let link = GatewayConnectDeepLink.fromSetupCode(payload) {
                    self.handled = true
                    self.parent.onGatewayLink(link)
                    return
                }

                // Fall back to deep link URL format (openclaw://gateway?...).
                if let url = URL(string: payload),
                   let route = DeepLinkParser.parse(url),
                   case let .gateway(link) = route
                {
                    self.handled = true
                    self.parent.onGatewayLink(link)
                    return
                }
            }
        }

        func dataScanner(_: DataScannerViewController, didRemove _: [RecognizedItem], allItems _: [RecognizedItem]) {}

        func dataScanner(_: DataScannerViewController, becameUnavailableWithError error: DataScannerViewController.ScanningUnavailable) {
            self.parent.onError("Camera is not available on this device.")
        }
    }
}
