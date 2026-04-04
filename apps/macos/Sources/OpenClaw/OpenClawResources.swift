import Foundation

enum OpenClawResources {
    /// Resource bundle for the macOS OpenClaw app target.
    ///
    /// Packaged `.app` bundles copy SwiftPM resources into `Contents/Resources`,
    /// while local SwiftPM builds keep them near the build products. Walking the
    /// likely container paths avoids the `Bundle.module` fatalError when the
    /// generated lookup misses the packaged layout.
    static let bundle: Bundle = locateBundle()

    private static let bundleName = "OpenClaw_OpenClaw"

    private static func locateBundle() -> Bundle {
        if let mainResourceURL = Bundle.main.resourceURL {
            let bundleURL = mainResourceURL.appendingPathComponent("\(bundleName).bundle")
            if let bundle = Bundle(url: bundleURL) {
                return bundle
            }
        }

        if let embedded = loadEmbeddedBundle() {
            return embedded
        }

        return Bundle.main
    }

    private static func loadEmbeddedBundle() -> Bundle? {
        let candidates: [URL?] = [
            Bundle.main.resourceURL,
            Bundle.main.bundleURL,
            Bundle(for: BundleLocator.self).resourceURL,
            Bundle(for: BundleLocator.self).bundleURL,
        ]

        for candidate in candidates {
            guard let baseURL = candidate else { continue }

            var roots: [URL] = [
                baseURL,
                baseURL.appendingPathComponent("Resources"),
                baseURL.appendingPathComponent("Contents/Resources"),
            ]

            var current = baseURL
            for _ in 0 ..< 5 {
                current = current.deletingLastPathComponent()
                roots.append(current)
                roots.append(current.appendingPathComponent("Resources"))
                roots.append(current.appendingPathComponent("Contents/Resources"))
            }

            for root in roots {
                let bundleURL = root.appendingPathComponent("\(bundleName).bundle")
                if let bundle = Bundle(url: bundleURL) {
                    return bundle
                }
            }
        }

        return nil
    }
}

private final class BundleLocator {}
