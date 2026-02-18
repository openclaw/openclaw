import Foundation

// NetService-based resolver for Bonjour services.
// Used to resolve the service endpoint (SRV + A/AAAA) without trusting TXT for routing.
final class GatewayServiceResolver: NSObject, NetServiceDelegate {
    private let service: NetService
    private let completion: ((host: String, port: Int)?) -> Void
    private var didFinish = false

    init(
        name: String,
        type: String,
        domain: String,
        completion: @escaping ((host: String, port: Int)?) -> Void)
    {
        self.service = NetService(domain: domain, type: type, name: name)
        self.completion = completion
        super.init()
        self.service.delegate = self
    }

    func start(timeout: TimeInterval = 2.0) {
        self.service.schedule(in: .main, forMode: .common)
        self.service.resolve(withTimeout: timeout)
    }

    func netServiceDidResolveAddress(_ sender: NetService) {
        let host = Self.normalizeHost(sender.hostName)
        let port = sender.port
        guard let host, !host.isEmpty, port > 0 else {
            self.finish(result: nil)
            return
        }
        self.finish(result: (host: host, port: port))
    }

    func netService(_ sender: NetService, didNotResolve errorDict: [String: NSNumber]) {
        self.finish(result: nil)
    }

    private func finish(result: ((host: String, port: Int))?) {
        guard !self.didFinish else { return }
        self.didFinish = true
        self.service.stop()
        self.service.remove(from: .main, forMode: .common)
        self.completion(result)
    }

    private static func normalizeHost(_ raw: String?) -> String? {
        let trimmed = raw?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if trimmed.isEmpty { return nil }
        return trimmed.hasSuffix(".") ? String(trimmed.dropLast()) : trimmed
    }
}

