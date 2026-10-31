import Foundation

enum CanvasScheme {
    static let scheme = "openclaw-canvas"

    static func makeURL(session: String, path: String? = nil) -> URL? {
        var comps = URLComponents()
        comps.scheme = Self.scheme
        comps.host = session
        let p = (path ?? "/").trimmingCharacters(in: .whitespacesAndNewlines)
        comps.path = p.hasPrefix("/") ? p : "/" + p
        return comps.url
    }

    static func mimeType(forExtension ext: String) -> String {
        switch ext.lowercased() {
        // Note: WKURLSchemeHandler uses URLResponse(mimeType:), which expects a bare MIME type
        // (no `; charset=...`). Encoding is provided via URLResponse(textEncodingName:).
        case "html", "htm": "text/html"
        case "js", "mjs": "application/javascript"
        case "css": "text/css"
        case "json", "map": "application/json"
        case "svg": "image/svg+xml"
        case "png": "image/png"
        case "jpg", "jpeg": "image/jpeg"
        case "gif": "image/gif"
        case "ico": "image/x-icon"
        case "woff2": "font/woff2"
        case "woff": "font/woff"
        case "ttf": "font/ttf"
        case "wasm": "application/wasm"
        // WebKit will not display application/octet-stream in a frame, so documents need real types.
        case "txt", "text", "md", "markdown", "csv", "log": "text/plain"
        case "pdf": "application/pdf"
        default: "application/octet-stream"
        }
    }
}
