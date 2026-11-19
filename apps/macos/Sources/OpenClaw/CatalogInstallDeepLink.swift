import Foundation

/// External links select a ClawHub item; the dashboard still owns install consent and authority.
struct CatalogInstallDeepLink: Sendable, Equatable {
    enum Family: String, Sendable {
        case plugins
        case skills
        case templates
    }

    let family: Family
    let packageName: String

    init?(url: URL) {
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              components.scheme?.lowercased() == "openclaw",
              let host = components.host?.lowercased(), let family = Family(rawValue: host),
              components.percentEncodedPath == "/install",
              components.user == nil, components.password == nil, components.port == nil,
              components.fragment == nil,
              let items = components.queryItems, items.count == 1, items[0].name == "name",
              let packageName = items[0].value, packageName.utf8.count <= 214,
              packageName.range(
                  of: #"^(?:@[a-z0-9][a-z0-9._-]*/)?[a-z0-9][a-z0-9._-]*$"#,
                  options: .regularExpression) == packageName.startIndex..<packageName.endIndex
        else { return nil }
        self.family = family
        self.packageName = packageName
    }

    var dashboardPath: String {
        switch self.family {
        case .plugins:
            let identity = Data(self.packageName.utf8).base64EncodedString()
                .replacingOccurrences(of: "+", with: "-")
                .replacingOccurrences(of: "/", with: "_")
                .replacingOccurrences(of: "=", with: "")
            return "/plugins/ch_\(identity)"
        case .skills:
            return "/skills"
        case .templates:
            return "/templates/packages/\(self.encodedName)"
        }
    }

    var dashboardSearch: String? {
        self.family == .skills ? "?clawhub=\(self.encodedName)" : nil
    }

    private var encodedName: String {
        // The validated ASCII identity is representable; encode @ and / as part of one value.
        self.packageName.addingPercentEncoding(
            withAllowedCharacters: CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyz0123456789-._~"))!
    }
}
