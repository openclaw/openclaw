import Foundation

#if !os(watchOS)
public enum BonjourServiceResolverSupport {
    public static func normalizeHost(_ raw: String?) -> String? {
        guard let trimmed = raw?.trimmedNonEmpty else { return nil }
        return trimmed.hasSuffix(".") ? String(trimmed.dropLast()) : trimmed
    }
}

public final class BonjourServiceResolver<Result>: NSObject, NetServiceDelegate {
    private let service: NetService
    private let resolve: (NetService) -> Result?
    private let completion: (Result?) -> Void
    private var didFinish = false

    public init(
        name: String,
        type: String,
        domain: String,
        resolve: @escaping (NetService) -> Result?,
        completion: @escaping (Result?) -> Void)
    {
        self.service = NetService(domain: domain, type: type, name: name)
        self.resolve = resolve
        self.completion = completion
        super.init()
        self.service.delegate = self
    }

    public func start(timeout: TimeInterval = 2.0) {
        self.service.schedule(in: .main, forMode: .common)
        self.service.resolve(withTimeout: timeout)
    }

    public func cancel() {
        self.finish(result: nil)
    }

    public func netServiceDidResolveAddress(_ sender: NetService) {
        self.finish(result: self.resolve(sender))
    }

    public func netService(_: NetService, didNotResolve _: [String: NSNumber]) {
        self.finish(result: nil)
    }

    private func finish(result: Result?) {
        guard !self.didFinish else { return }
        self.didFinish = true
        self.service.stop()
        self.service.remove(from: .main, forMode: .common)
        self.completion(result)
    }
}
#endif
