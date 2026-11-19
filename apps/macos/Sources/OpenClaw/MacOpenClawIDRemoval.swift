import Foundation

/// Last verified loss of this Mac's owner or member enrollment; display context, never authority.
struct MacOpenClawIDRemoval: Equatable {
    enum Origin: String { case here, elsewhere }

    let hostname: String
    let shortName: String
    let date: Date
    let origin: Origin
    /// This Mac was a member device: another of the member's devices or a new invite brings it back.
    let member: Bool

    init(hostname: String, date: Date = Date(), origin: Origin, member: Bool = false) {
        self.hostname = hostname
        self.shortName = String(hostname.split(separator: ".").first ?? Substring(hostname))
        self.date = date
        self.origin = origin
        self.member = member
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
        if self.member {
            return "It was removed from \(self.shortName), from one of your devices or by an owner. " +
                "To use it again, sign in and approve it from another of your devices. " +
                "If you’ve lost them all, ask an owner for a new invite."
        }
        return "It was removed from another device. To use it with \(self.shortName) again, " +
            "sign in and approve it from one of your devices, or with your recovery kit."
    }

    func settingsMessage(now: Date = Date()) -> String {
        if self.member {
            return "Removed from one of your devices or by an owner. Sign in to add it back."
        }
        return self.origin == .here
            ? "You removed this Mac \(age(from: self.date, now: now)). Sign in to approve it again."
            : "This Mac was removed from another device. Sign in to approve it again."
    }

    func subtitle(now: Date = Date()) -> String {
        "Removed from \(self.shortName) · \(age(from: self.date, now: now))"
    }
}
