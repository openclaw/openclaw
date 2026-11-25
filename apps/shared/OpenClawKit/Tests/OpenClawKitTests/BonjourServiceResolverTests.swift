import Foundation
import OpenClawKit
import Testing

#if !os(watchOS)
@MainActor
struct BonjourServiceResolverTests {
    enum Completion: CaseIterable {
        case resolved, failed, cancelled
    }

    @Test(arguments: Completion.allCases)
    func `resolution failure and cancellation settle a resolver only once`(_ first: Completion) {
        let service = NetService(domain: "local.", type: "_openclaw._tcp.", name: "Synthetic gateway")
        var results: [String?] = []
        let resolver = BonjourServiceResolver(
            name: service.name,
            type: service.type,
            domain: service.domain,
            resolve: { $0.name },
            completion: { results.append($0) })

        switch first {
        case .resolved: resolver.netServiceDidResolveAddress(service)
        case .failed: resolver.netService(service, didNotResolve: [:])
        case .cancelled: resolver.cancel()
        }
        resolver.netServiceDidResolveAddress(service)
        resolver.netService(service, didNotResolve: [:])
        resolver.cancel()

        #expect(results.count == 1)
        #expect(results.first.flatMap(\.self) == (first == .resolved ? service.name : nil))
    }
}
#endif
