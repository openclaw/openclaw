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
            background: radial-gradient(1200px 900px at 15% 20%, rgba(42, 113, 255, 0.18), rgba(0,0,0,0) 55%),
                        radial-gradient(900px 700px at 85% 30%, rgba(255, 0, 138, 0.14), rgba(0,0,0,0) 60%),
                        radial-gradient(1000px 900px at 60% 90%, rgba(0, 209, 255, 0.10), rgba(0,0,0,0) 60%),
                        #000;
            overflow: hidden;
          }
          body::before {
            content:"";
            position: fixed;
            inset: -20%;
            background:
              repeating-linear-gradient(0deg, rgba(255,255,255,0.02) 0, rgba(255,255,255,0.02) 1px, transparent 1px, transparent 48px),
              repeating-linear-gradient(90deg, rgba(255,255,255,0.02) 0, rgba(255,255,255,0.02) 1px, transparent 1px, transparent 48px);
            transform: rotate(-7deg);
            opacity: 0.55;
            pointer-events: none;
          }
          canvas {
            display:block;
            width:100vw;
            height:100vh;
            touch-action: none;
          }
          #clawdis-status {
            position: fixed;
            inset: 0;
            display: grid;
            place-items: center;
            pointer-events: none;
          }
          #clawdis-status .card {
            text-align: center;
            padding: 16px 18px;
            border-radius: 14px;
            background: rgba(18, 18, 22, 0.42);
            border: 1px solid rgba(255,255,255,0.08);
            box-shadow: 0 18px 60px rgba(0,0,0,0.55);
            backdrop-filter: blur(14px);
          }
          #clawdis-status .title {
            font: 600 20px -apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text", system-ui, sans-serif;
            letter-spacing: 0.2px;
            color: rgba(255,255,255,0.92);
            text-shadow: 0 0 22px rgba(42, 113, 255, 0.35);
          }
          #clawdis-status .subtitle {
            margin-top: 6px;
            font: 500 12px -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif;
            color: rgba(255,255,255,0.58);
          }
        </style>
      </head>
      <body>
        <canvas id="clawdis-canvas"></canvas>
        <div id="clawdis-status">
          <div class="card">
            <div class="title" id="clawdis-status-title">Ready</div>
            <div class="subtitle" id="clawdis-status-subtitle">Waiting for agent</div>
          </div>
        </div>
        <script>
          (() => {
            const canvas = document.getElementById('clawdis-canvas');
            const ctx = canvas.getContext('2d');
            const statusEl = document.getElementById('clawdis-status');
            const titleEl = document.getElementById('clawdis-status-title');
            const subtitleEl = document.getElementById('clawdis-status-subtitle');

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

            window.__clawdis = {
              canvas,
              ctx,
              setStatus: (title, subtitle) => {
                if (!statusEl) return;
                if (!title && !subtitle) {
                  statusEl.style.display = 'none';
                  return;
                }
                statusEl.style.display = 'grid';
                if (titleEl && typeof title === 'string') titleEl.textContent = title;
                if (subtitleEl && typeof subtitle === 'string') subtitleEl.textContent = subtitle;
              }
            };
          })();
        </script>
      </body>
    </html>
    """
}
