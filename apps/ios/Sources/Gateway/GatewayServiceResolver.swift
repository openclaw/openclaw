import Foundation
import OpenClawKit

/// NetService-based resolver for Bonjour services.
/// Used to resolve the service endpoint (SRV + A/AAAA) without trusting TXT for routing.
struct ResolvedGatewayService: Equatable {
    var txt: [String: String]
    var host: String?
    var port: Int?
}

final class GatewayServiceResolver: NSObject, NetServiceDelegate {
    private let service: NetService
    private let completion: (ResolvedGatewayService?) -> Void
    private var didFinish = false

    init(
        name: String,
        type: String,
        domain: String,
        completion: @escaping (ResolvedGatewayService?) -> Void)
    {
        self.service = NetService(domain: domain, type: type, name: name)
        self.completion = completion
        super.init()
        self.service.delegate = self
    }

    func start(timeout: TimeInterval = 2.0) {
        BonjourServiceResolverSupport.start(self.service, timeout: timeout)
    }

    func netServiceDidResolveAddress(_ sender: NetService) {
        let txt = Self.decodeTXT(sender.txtRecordData())
        let host = Self.normalizeHost(sender.hostName)
        let port = sender.port > 0 ? sender.port : nil
        guard host != nil || port != nil || !txt.isEmpty else {
            self.finish(result: nil)
            return
        }
        self.finish(result: ResolvedGatewayService(txt: txt, host: host, port: port))
    }

    func netService(_ sender: NetService, didNotResolve errorDict: [String: NSNumber]) {
        self.finish(result: nil)
    }

    private func finish(result: ResolvedGatewayService?) {
        guard !self.didFinish else { return }
        self.didFinish = true
        self.service.stop()
        self.service.remove(from: .main, forMode: .common)
        self.completion(result)
    }

    private static func normalizeHost(_ raw: String?) -> String? {
        BonjourServiceResolverSupport.normalizeHost(raw)
    }

    private static func decodeTXT(_ data: Data?) -> [String: String] {
        guard let data else { return [:] }
        let dict = NetService.dictionary(fromTXTRecord: data)
        var out: [String: String] = [:]
        out.reserveCapacity(dict.count)
        for (key, value) in dict {
            if let str = String(data: value, encoding: .utf8) {
                out[key] = str
            }
        }
        return out
    }
}
