import Foundation
import OpenClawKit

enum CanvasHostedURLResolver {
    private static let canvasPath = "/__openclaw__/canvas"

    static func resolve(surfaceURL rawSurfaceURL: String?, target rawTarget: String) -> URL? {
        guard let target = relativeHostedTarget(rawTarget) else { return nil }
        return GatewayPluginSurfaceURL.appendingTarget(target, toCapabilitySurface: rawSurfaceURL)
    }

    static func isHostedTarget(_ rawTarget: String) -> Bool {
        self.relativeHostedTarget(rawTarget) != nil
    }

    static func isAppLocalTarget(_ rawTarget: String) -> Bool {
        let target = rawTarget.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let components = URLComponents(string: target),
              components.scheme?.lowercased() == CanvasScheme.scheme,
              components.host?.isEmpty == false,
              components.user == nil,
              components.password == nil,
              components.port == nil,
              components.percentEncodedPath.isEmpty ||
              isCanonicalHostedPath(components.percentEncodedPath)
        else {
            return false
        }
        return true
    }

    private static func relativeHostedTarget(_ rawTarget: String) -> URLComponents? {
        let target = rawTarget.trimmingCharacters(in: .whitespacesAndNewlines)
        guard target.hasPrefix("/"),
              let components = URLComponents(string: target),
              components.scheme == nil,
              components.host == nil,
              components.user == nil,
              components.password == nil,
              isCanonicalHostedPath(components.percentEncodedPath),
              isCanvasPath(components.percentEncodedPath)
        else {
            return nil
        }
        return components
    }

    private static func isCanonicalHostedPath(_ path: String) -> Bool {
        let segments = path.split(separator: "/", omittingEmptySubsequences: false)
        guard segments.first?.isEmpty == true else { return false }

        for (index, encodedSegment) in segments.enumerated() {
            if index == 0 || (index == segments.count - 1 && encodedSegment.isEmpty) {
                continue
            }
            guard !encodedSegment.isEmpty else { return false }
            var segment = String(encodedSegment)
            while true {
                guard let decoded = segment.removingPercentEncoding else { return false }
                if decoded == segment {
                    break
                }
                segment = decoded
            }
            if segment == "." || segment == ".." || segment.contains("/") || segment.contains("\\") {
                return false
            }
        }
        return true
    }

    private static func isCanvasPath(_ path: String) -> Bool {
        path == self.canvasPath || path.hasPrefix("\(self.canvasPath)/")
    }
}
