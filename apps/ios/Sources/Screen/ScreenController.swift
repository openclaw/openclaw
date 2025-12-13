import ClawdisKit
import SwiftUI
import WebKit

@MainActor
final class ScreenController: ObservableObject {
    let webView: WKWebView

    @Published var mode: ClawdisScreenMode = .canvas
    @Published var urlString: String = ""
    @Published var errorText: String?

    init() {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        self.webView = WKWebView(frame: .zero, configuration: config)
        self.reload()
    }

    func setMode(_ mode: ClawdisScreenMode) {
        self.mode = mode
        self.reload()
    }

    func navigate(to urlString: String) {
        self.urlString = urlString
        self.reload()
    }

    func reload() {
        switch self.mode {
        case .web:
            guard let url = URL(string: self.urlString.trimmingCharacters(in: .whitespacesAndNewlines)) else { return }
            self.webView.load(URLRequest(url: url))
        case .canvas:
            self.webView.loadHTMLString(Self.canvasScaffoldHTML, baseURL: nil)
        }
    }

    func eval(javaScript: String) async throws -> String {
        try await withCheckedThrowingContinuation { cont in
            self.webView.evaluateJavaScript(javaScript) { result, error in
                if let error {
                    cont.resume(throwing: error)
                    return
                }
                if let result {
                    cont.resume(returning: String(describing: result))
                } else {
                    cont.resume(returning: "")
                }
            }
        }
    }

    func snapshotPNGBase64(maxWidth: CGFloat? = nil) async throws -> String {
        let config = WKSnapshotConfiguration()
        if let maxWidth {
            config.snapshotWidth = NSNumber(value: Double(maxWidth))
        }
        let image: UIImage = try await withCheckedThrowingContinuation { cont in
            self.webView.takeSnapshot(with: config) { image, error in
                if let error {
                    cont.resume(throwing: error)
                    return
                }
                guard let image else {
                    cont.resume(throwing: NSError(domain: "Screen", code: 2, userInfo: [
                        NSLocalizedDescriptionKey: "snapshot failed",
                    ]))
                    return
                }
                cont.resume(returning: image)
            }
        }
        guard let data = image.pngData() else {
            throw NSError(domain: "Screen", code: 1, userInfo: [
                NSLocalizedDescriptionKey: "snapshot encode failed",
            ])
        }
        return data.base64EncodedString()
    }

    private static let canvasScaffoldHTML = """
    <!doctype html>
    <html>
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Canvas</title>
        <style>
          :root { color-scheme: dark; }
          html,body { height:100%; margin:0; }
          body {
            background:#000;
          }
          canvas {
            display:block;
            width:100vw;
            height:100vh;
          }
        </style>
      </head>
      <body>
        <canvas id="clawdis-canvas"></canvas>
        <script>
          (() => {
            const canvas = document.getElementById('clawdis-canvas');
            const ctx = canvas.getContext('2d');

            function resize() {
              const dpr = window.devicePixelRatio || 1;
              const w = Math.max(1, Math.floor(window.innerWidth * dpr));
              const h = Math.max(1, Math.floor(window.innerHeight * dpr));
              canvas.width = w;
              canvas.height = h;
              ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            }

            window.addEventListener('resize', resize);
            resize();

            window.__clawdis = { canvas, ctx };
          })();
        </script>
      </body>
    </html>
    """
}
