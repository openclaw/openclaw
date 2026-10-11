import Foundation

extension OpenClawChatSidebarPeople.Person {
    public var reportedTimeZones: [String] {
        Set(self.entries.compactMap { $0.timezone?.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }).sorted()
    }

    public var connections: [String] {
        // ui/src/components/person-activity-card.ts:116: duplicate tabs describe one reported environment.
        Set(self.entries.map { entry in
            let family = entry.devicefamily?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            var parts = (entry.platform ?? "").split(whereSeparator: \.isWhitespace).map(String.init)
            let name = parts.isEmpty ? "" : parts.removeFirst()
            let architectures = [
                "arm": "ARM",
                "arm64": "ARM",
                "aarch64": "ARM",
                "armv7l": "ARM",
                "armv8l": "ARM",
                "x64": "x64",
                "x86_64": "x64",
                "amd64": "x64",
                "x86": "x86",
                "i386": "x86",
                "i686": "x86",
            ]
            let suffix = parts.last.flatMap { architectures[$0.lowercased()] }
            if suffix != nil { parts.removeLast() }
            let mac = [
                "macarm": "ARM",
                "macarm64": "ARM",
                "arm64-apple-darwin": "ARM",
                "aarch64-apple-darwin": "ARM",
                "x86_64-apple-darwin": "Intel",
            ][name.lowercased()]
            let names = [
                "macos": "macOS",
                "darwin": "macOS",
                "win32": "Windows",
                "win64": "Windows",
                "windows": "Windows",
                "linux": "Linux",
                "freebsd": "FreeBSD",
                "openbsd": "OpenBSD",
                "netbsd": "NetBSD",
                "ios": "iOS",
                "ipados": "iPadOS",
                "watchos": "watchOS",
                "android": "Android",
                "web": "Web",
            ]
            let familyPlatform = family == "Mac" ? "macOS" : family == "iPad" ? "iPadOS" : family
            let label = name.lowercased() == "macintel" && ["Mac", "iPad"].contains(family)
                ? familyPlatform : mac != nil ? "macOS" : names[name.lowercased()] ??
                (name == name.lowercased() ? name.prefix(1).uppercased() + name.dropFirst() : name)
            let platform = ([label] + parts).joined(separator: " ")
            let client: String? = if entry.clientid == "openclaw-tui" {
                String(localized: "Terminal")
            } else if entry.mode == "webchat" ||
                ["openclaw-control-ui", "openclaw-browser-copilot", "webchat-ui", "webchat"]
                .contains(entry.clientid ?? "")
            {
                String(localized: "Web")
            } else if entry.mode == "cli" || entry.clientid == "cli" {
                String(localized: "Command line")
            } else if entry.mode == "ui" ||
                ["openclaw-macos", "openclaw-linux", "openclaw-ios", "openclaw-watchos", "openclaw-android"]
                .contains(entry.clientid ?? "")
            {
                String(localized: "App")
            } else {
                nil
            }
            var seen = Set<String>()
            return [family, platform == familyPlatform ? nil : platform, mac ?? suffix, client]
                .compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines) }
                .filter { !$0.isEmpty && seen.insert($0).inserted }.joined(separator: " · ")
        }.filter { !$0.isEmpty }).sorted()
    }
}
