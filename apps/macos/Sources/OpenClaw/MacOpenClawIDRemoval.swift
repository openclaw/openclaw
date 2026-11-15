import Foundation

/// Last verified loss of this Mac's owner enrollment; display context, never authority.
struct MacOpenClawIDRemoval: Equatable {
    enum Origin: String { case here, elsewhere }

    let hostname: String
    let shortName: String
    let date: Date
    let origin: Origin

    init(hostname: String, date: Date = Date(), origin: Origin) {
        self.hostname = hostname
        self.shortName = String(hostname.split(separator: ".").first ?? Substring(hostname))
        self.date = date
        self.origin = origin
    }

    var title: String {
        self.origin == .here
            ? "This Mac was removed from \(self.shortName)"
            : "This Mac no longer has access to \(self.shortName)"
    }

    func dashboardMessage(now: Date = Date()) -> String {
        if self.origin == .here {
            return "You removed it in Settings \(age(from: self.date, now: now)). " +
                "Chat, the dashboard and tools on this Mac no longer reach \(self.hostname)."
        }
        return "It was removed from another device. To use it with \(self.shortName) again, " +
            "sign in and approve it from one of your devices, or with your recovery kit."
    }

    func settingsMessage(now: Date = Date()) -> String {
        self.origin == .here
            ? "You removed this Mac \(age(from: self.date, now: now)). Sign in to approve it again."
            : "This Mac was removed from another device. Sign in to approve it again."
    }

    func subtitle(now: Date = Date()) -> String {
        "Removed from \(self.shortName) · \(age(from: self.date, now: now))"
    }
}
