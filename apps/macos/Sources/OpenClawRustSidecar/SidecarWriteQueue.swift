import Foundation
import OpenClawKit

/// Bounds original waiting/admitted payloads as well as active writes. Relay messages and
/// controls retain separate capacity so application pressure cannot starve transport receipts.
/// RPC leases outlive writes until ordered cancellation drains. These queue budgets do not
/// bound payloads retained by callers or the native network transport.
final class SidecarWriteQueue: @unchecked Sendable {
    enum Lane: Sendable {
        case application, progress, delivery, transport, cancellation, admission, keepalive, receipt, pong

        var isControl: Bool {
            switch self {
            case .cancellation, .admission, .keepalive, .receipt, .pong: true
            default: false
            }
        }

        var countLimit: Int {
            switch self {
            // The peer can acknowledge physically written bytes before the serial
            // writer releases its slot. One completed write plus one successor can coexist.
            case .transport, .receipt, .pong: 2
            case .cancellation: 128 // One reserved cancellation per ordinary/progress RPC lease.
            default: 64
            }
        }
    }

    private final class Lease: @unchecked Sendable {
        let lane: Lane
        var released = false
        init(_ lane: Lane) {
            self.lane = lane
        }
    }

    typealias Prepared = (data: SidecarPayload, cancellation: Data?)

    private final class Request: @unchecked Sendable {
        let id = UUID()
        let data: SidecarPayload
        let lane: Lane
        let chargedBytes: Int
        let lifetime: WebSocketRequestLifetime?
        let prepare: @Sendable (SidecarPayload) throws -> Prepared
        let write: @Sendable (SidecarPayload) throws -> Void
        var continuation: CheckedContinuation<Void, Error>?
        var admitted = false
        var cancelled = false
        var lease: Lease?
        var releasesLease = true

        init(
            data: SidecarPayload,
            lane: Lane,
            lifetime: WebSocketRequestLifetime?,
            continuation: CheckedContinuation<Void, Error>?,
            prepare: @escaping @Sendable (SidecarPayload) throws -> Prepared,
            write: @escaping @Sendable (SidecarPayload) throws -> Void)
        {
            self.data = data
            self.lane = lane
            self.chargedBytes = data.count
            self.lifetime = lifetime
            self.continuation = continuation
            self.prepare = prepare
            self.write = write
        }
    }

    let queue = DispatchQueue(label: "ai.openclaw.sidecar.write")
    private let lock = NSLock()
    private var failure: Error?
    private var requests: [UUID: Request] = [:]
    private var waiting: [UUID] = []
    private var payloadBytes = 0
    private var controlBytes = 0
    private var leases: [Lane: Int] = [:]

    func enqueue(
        _ data: SidecarPayload,
        lane: Lane,
        lifetime: WebSocketRequestLifetime? = nil,
        continuation: CheckedContinuation<Void, Error>? = nil,
        prepare: @escaping @Sendable (SidecarPayload) throws -> Prepared = { ($0, nil) },
        write: @escaping @Sendable (SidecarPayload) throws -> Void,
        failed: @escaping @Sendable (Error) -> Void)
    {
        let request = Request(
            data: data,
            lane: lane,
            lifetime: lifetime,
            continuation: continuation,
            prepare: prepare,
            write: write)
        self.register(request, failed: failed)
    }

    private func register(_ request: Request, failed: @escaping @Sendable (Error) -> Void) {
        let register = {
            let lane = request.lane
            self.lock.lock()
            let count = self.requests.values.filter { $0.lane == lane }.count
            let byteLimit = lane.isControl ? 64 * 1024 : 64 * 1024 * 1024
            // Originals wait under a shared byte budget before admission, including cancelled
            // admitted work until it drains. The acknowledged relay keeps its two reserved slots.
            let retainedBytes = self.requests.values.reduce(0) { bytes, queued in
                bytes + (queued.lane != .transport && queued.lane.isControl == lane.isControl ? queued.chargedBytes : 0)
            }
            let retainedLimit = lane.isControl ? byteLimit : 2 * byteLimit
            guard self.failure == nil, count < lane.countLimit, request.chargedBytes <= byteLimit,
                  lane == .transport || retainedBytes + request.chargedBytes <= retainedLimit
            else {
                let error = self.failure ?? URLError(.dataLengthExceedsMaximum)
                self.lock.unlock()
                request.continuation?.resume(throwing: error)
                failed(error)
                return
            }
            self.requests[request.id] = request
            self.waiting.append(request.id)
            let ready = self.admitLocked()
            self.lock.unlock()
            self.schedule(ready, failed: failed)
        }
        if let lifetime = request.lifetime {
            let id = request.id
            if !lifetime.performIfActive(register, onFinish: { self.cancelWaiting(id) }) {
                request.continuation?.resume(throwing: CancellationError())
            }
        } else { register() }
    }

    private func admitLocked() -> [Request] {
        var ready: [Request] = []
        // A full application lane must not starve the one acknowledged native relay
        // message, or its receipts. Their bounded owners have separate count allowances.
        for lane in [
            Lane.cancellation,
            .admission,
            .keepalive,
            .receipt,
            .pong,
            .transport,
            .delivery,
            .progress,
            .application,
        ] {
            if !lane.isControl, lane != .transport,
               self.waiting.contains(where: { self.requests[$0]?.lane == .transport }) { break }
            var blocked = false
            self.waiting.removeAll { id in
                guard let request = self.requests[id] else { return true }
                guard request.lane == lane, !blocked else { return false }
                let control = lane.isControl
                let used = control ? self.controlBytes : self.payloadBytes
                let limit = control ? 64 * 1024 : 64 * 1024 * 1024
                guard used + request.chargedBytes <= limit,
                      request.lifetime == nil || self.leases[lane, default: 0] < 64
                else {
                    blocked = true
                    return false
                }
                request.admitted = true
                if request.lifetime != nil {
                    request.lease = Lease(lane)
                    self.leases[lane, default: 0] += 1
                }
                if control {
                    self.controlBytes += request.chargedBytes
                } else {
                    self.payloadBytes += request.chargedBytes
                }
                ready.append(request)
                return true
            }
        }
        return ready
    }

    private func schedule(_ ready: [Request], failed: @escaping @Sendable (Error) -> Void) {
        for request in ready {
            self.queue.async {
                do {
                    try self.lock.withLock { if let failure = self.failure { throw failure } }
                    if self.lock.withLock({ request.cancelled }) {
                        self.complete(request.id, error: CancellationError(), failed: failed)
                        return
                    }
                    // Only admitted messages allocate parsed JSON and the IPC envelope.
                    let prepared = try request.prepare(request.data)
                    guard prepared.data.count <= request.chargedBytes else {
                        throw URLError(.dataLengthExceedsMaximum)
                    }
                    let send = {
                        self.queue.async {
                            do {
                                try self.lock.withLock { if let failure = self.failure { throw failure } }
                                try request.write(prepared.data)
                                self.complete(request.id, error: nil, failed: failed)
                            } catch {
                                self.complete(request.id, error: error, failed: failed)
                                failed(error)
                            }
                        }
                    }
                    if let lifetime = request.lifetime {
                        // The completion hook must retain only the tiny cancellation frame,
                        // not the original payload, prepared envelope, or request lifetime.
                        guard let cancellation = prepared.cancellation, let lease = request.lease else {
                            throw URLError(.cannotParseResponse)
                        }
                        let write = request.write
                        let active = lifetime.performIfActive(send, onFinish: {
                            let control = Request(
                                data: SidecarPayload(cancellation),
                                lane: .cancellation,
                                lifetime: nil,
                                continuation: nil,
                                prepare: { ($0, nil) },
                                write: write)
                            control.lease = lease
                            self.register(control, failed: failed)
                        })
                        if active { request.releasesLease = false } else {
                            self.complete(request.id, error: CancellationError(), failed: failed)
                        }
                    } else { send() }
                } catch {
                    self.complete(request.id, error: error, failed: failed)
                    failed(error)
                }
            }
        }
    }

    private func cancelWaiting(_ id: UUID) {
        self.lock.lock()
        guard let request = self.requests[id] else { self.lock.unlock()
            return
        }
        let continuation = request.continuation
        request.continuation = nil
        request.cancelled = true
        // Admitted closures retain their credit until drained, bounding cancelled work too.
        if !request.admitted {
            self.requests.removeValue(forKey: id)
            self.waiting.removeAll { $0 == id }
        }
        self.lock.unlock()
        continuation?.resume(throwing: CancellationError())
    }

    private func complete(_ id: UUID, error: Error?, failed: @escaping @Sendable (Error) -> Void) {
        self.lock.lock()
        guard let request = self.requests.removeValue(forKey: id) else { self.lock.unlock()
            return
        }
        if request.lane.isControl {
            self.controlBytes -= request.chargedBytes
        } else {
            self.payloadBytes -= request.chargedBytes
        }
        if let lease = request.lease, request.releasesLease || error != nil, !lease.released {
            lease.released = true
            self.leases[lease.lane, default: 0] -= 1
        }
        let continuation = request.continuation
        request.continuation = nil
        let ready = self.admitLocked()
        self.lock.unlock()
        if let error { continuation?.resume(throwing: error) } else { continuation?.resume() }
        self.schedule(ready, failed: failed)
    }

    func close(_ error: Error) {
        self.lock.lock()
        guard self.failure == nil else { self.lock.unlock()
            return
        }
        self.failure = error
        let continuations = self.requests.values.compactMap(\.continuation)
        self.requests.removeAll()
        self.waiting.removeAll()
        self.payloadBytes = 0
        self.controlBytes = 0
        self.leases.removeAll()
        self.lock.unlock()
        for continuation in continuations {
            continuation.resume(throwing: error)
        }
    }
}
