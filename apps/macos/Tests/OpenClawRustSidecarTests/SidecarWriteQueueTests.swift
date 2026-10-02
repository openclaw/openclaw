import Foundation
import OpenClawKit
import Synchronization
import Testing
@testable import OpenClawRustSidecar

struct SidecarWriteQueueTests {
    @Test func `full application count and bytes preserve relay and control delivery`() async {
        let queue = SidecarWriteQueue()
        let gate = DispatchSemaphore(value: 0)
        let (events, received) = AsyncStream<Int>.makeStream()
        defer { gate.signal()
            queue.close(URLError(.cancelled))
            received.finish()
        }
        let first = Data(repeating: 1, count: 40 * 1024 * 1024)
        queue.enqueue(SidecarPayload(first), lane: .application, write: { _ in
            received.yield(1)
            gate.wait()
        }, failed: { _ in received.yield(-1) })
        var iterator = events.makeAsyncIterator()
        #expect(await iterator.next() == 1)
        let waiting = Data(repeating: 2, count: 40 * 1024 * 1024)
        for index in 0..<63 {
            let data = index == 0 ? waiting : Data([2])
            queue.enqueue(SidecarPayload(data), lane: .application, write: { _ in received.yield(2) }, failed: { _ in
                received.yield(-1)
            })
        }
        // All 64 application slots are occupied. Neither native relay nor receipts can wait for a count slot.
        queue.enqueue(SidecarPayload(Data(repeating: 3, count: 34 * 1024 * 1024)), lane: .transport, write: { _ in
            received.yield(3)
        }, failed: { _ in received.yield(-1) })
        queue.enqueue(SidecarPayload(Data([4])), lane: .receipt, write: { _ in received.yield(4) }, failed: { _ in
            received.yield(-1)
        })
        gate.signal()
        #expect(await iterator.next() == 4)
        #expect(await iterator.next() == 3)
        for _ in 0..<63 {
            #expect(await iterator.next() == 2)
        }
        queue.enqueue(SidecarPayload(Data([5])), lane: .application, write: { _ in received.yield(5) }, failed: { _ in
            received.yield(-1)
        })
        #expect(await iterator.next() == 5)
    }

    @Test(arguments: [false, true])
    func `waiting payload bytes share a bound across application progress and delivery`(utf8: Bool) async {
        let owner = SidecarWriteQueue()
        let gate = DispatchSemaphore(value: 0)
        let failures = Mutex<[URLError.Code]>([])
        let (events, output) = AsyncStream<Int>.makeStream()
        defer { owner.close(URLError(.cancelled))
            gate.signal()
            owner.queue.sync {}
            output.finish()
        }
        owner.enqueue(SidecarPayload(Data(repeating: 1, count: 48 * 1024 * 1024)), lane: .application, write: { _ in
            output.yield(1)
            gate.wait()
        }, failed: { error in failures.withLock { $0.append((error as? URLError)?.code ?? .unknown) } })
        var received = events.makeAsyncIterator()
        #expect(await received.next() == 1)
        for (id, lane) in [(2, SidecarWriteQueue.Lane.progress), (3, .delivery)] {
            let payload = utf8
                ? SidecarPayload(body: .utf8(String(repeating: id == 2 ? "😀" : "🦞", count: 10 * 1024 * 1024)))
                : SidecarPayload(Data(repeating: UInt8(id), count: 40 * 1024 * 1024))
            owner.enqueue(payload, lane: lane, write: { _ in output.yield(id) }, failed: { error in
                failures.withLock { $0.append((error as? URLError)?.code ?? .unknown) }
            })
        }
        for (id, lane) in [(5, SidecarWriteQueue.Lane.transport), (6, .pong)] {
            owner.enqueue(
                SidecarPayload(Data([UInt8(id)])),
                lane: lane,
                write: { _ in output.yield(id) },
                failed: { error in
                    failures.withLock { $0.append((error as? URLError)?.code ?? .unknown) }
                })
        }
        #expect(failures.withLock { $0 }.isEmpty)
        owner.enqueue(SidecarPayload(Data([4])), lane: .application, write: { _ in output.yield(4) }, failed: { error in
            failures.withLock { $0.append((error as? URLError)?.code ?? .unknown) }
        })
        // Rejection is observable before the held writer can return any byte credit.
        #expect(failures.withLock { $0 } == [.dataLengthExceedsMaximum])
        gate.signal()
        var delivered = Set<Int>()
        for _ in 0..<4 {
            if let id = await received.next() { delivered.insert(id) }
        }
        #expect(delivered == [2, 3, 5, 6])
    }

    @Test(arguments: [false, true])
    func `cancelled payload credit remains charged only while an admitted closure retains it`(admitted: Bool) async {
        let owner = SidecarWriteQueue()
        let gate = DispatchSemaphore(value: 0)
        let failures = Mutex<[URLError.Code]>([])
        let (events, output) = AsyncStream<Void>.makeStream()
        defer { owner.close(URLError(.cancelled))
            gate.signal()
            owner.queue.sync {}
            output.finish()
        }
        owner.enqueue(SidecarPayload(Data(repeating: 1, count: 32 * 1024 * 1024)), lane: .application, write: { _ in
            output.yield(())
            gate.wait()
        }, failed: { _ in })
        var received = events.makeAsyncIterator()
        _ = await received.next()
        let lifetime = WebSocketRequestLifetime()
        owner.enqueue(
            SidecarPayload(Data(repeating: 2, count: (admitted ? 32 : 64) * 1024 * 1024)),
            lane: .progress, lifetime: lifetime, prepare: { ($0, Data([2])) }, write: { _ in }, failed: { error in
                failures.withLock { $0.append((error as? URLError)?.code ?? .unknown) }
            })
        owner.enqueue(
            SidecarPayload(Data(repeating: 3, count: (admitted ? 64 : 32) * 1024 * 1024)),
            lane: .delivery, write: { _ in }, failed: { error in
                failures.withLock { $0.append((error as? URLError)?.code ?? .unknown) }
            })
        lifetime.finish()
        owner.enqueue(
            SidecarPayload(Data(repeating: 4, count: admitted ? 1 : 64 * 1024 * 1024)),
            lane: .application, write: { _ in }, failed: { error in
                failures.withLock { $0.append((error as? URLError)?.code ?? .unknown) }
            })
        #expect(failures.withLock { $0 } == (admitted ? [.dataLengthExceedsMaximum] : []))
    }

    @Test func `control retention is byte bounded while empty acknowledgements retain their count bounds`() async {
        let owner = SidecarWriteQueue()
        let gate = DispatchSemaphore(value: 0)
        let failures = Mutex<[URLError.Code]>([])
        let (events, output) = AsyncStream<Void>.makeStream()
        defer { owner.close(URLError(.cancelled))
            gate.signal()
            owner.queue.sync {}
            output.finish()
        }
        owner.enqueue(SidecarPayload(Data(repeating: 1, count: 32 * 1024)), lane: .keepalive, write: { _ in
            output.yield(())
            gate.wait()
        }, failed: { _ in })
        var received = events.makeAsyncIterator()
        _ = await received.next()
        owner.enqueue(
            SidecarPayload(Data(repeating: 2, count: 32 * 1024)),
            lane: .admission,
            write: { _ in },
            failed: { error in
                failures.withLock { $0.append((error as? URLError)?.code ?? .unknown) }
            })
        for lane in [SidecarWriteQueue.Lane.receipt, .pong] {
            for _ in 0..<2 {
                owner.enqueue(SidecarPayload(Data()), lane: lane, write: { _ in }, failed: { error in
                    failures.withLock { $0.append((error as? URLError)?.code ?? .unknown) }
                })
            }
        }
        #expect(failures.withLock { $0 }.isEmpty)
        owner.enqueue(SidecarPayload(Data([3])), lane: .cancellation, write: { _ in }, failed: { error in
            failures.withLock { $0.append((error as? URLError)?.code ?? .unknown) }
        })
        #expect(failures.withLock { $0 } == [.dataLengthExceedsMaximum])
        owner.enqueue(SidecarPayload(Data()), lane: .receipt, write: { _ in }, failed: { error in
            failures.withLock { $0.append((error as? URLError)?.code ?? .unknown) }
        })
        #expect(failures.withLock { $0 } == [.dataLengthExceedsMaximum, .dataLengthExceedsMaximum])
    }

    @Test(arguments: [SidecarWriteQueue.Lane.transport, .application])
    func `waiting large writer reserves the next released payload credit`(lane: SidecarWriteQueue.Lane) async {
        let queue = SidecarWriteQueue()
        let gate = DispatchSemaphore(value: 0)
        let (events, received) = AsyncStream<Int>.makeStream()
        defer { gate.signal()
            queue.close(URLError(.cancelled))
            received.finish()
        }
        queue.enqueue(SidecarPayload(Data(repeating: 1, count: 30 * 1024 * 1024)), lane: .application, write: { _ in
            received.yield(1)
            gate.wait()
        }, failed: { _ in received.yield(-1) })
        var iterator = events.makeAsyncIterator()
        #expect(await iterator.next() == 1)
        for (value, bytes, lane) in [
            (2, 30 * 1024 * 1024, SidecarWriteQueue.Lane.application),
            (3, 10 * 1024 * 1024, lane),
            (4, 1, .application),
        ] {
            queue.enqueue(SidecarPayload(Data(repeating: UInt8(value), count: bytes)), lane: lane, write: { _ in
                received.yield(value)
            }, failed: { _ in received.yield(-1) })
        }
        gate.signal()
        #expect(await iterator.next() == 2)
        #expect(await iterator.next() == 3)
        #expect(await iterator.next() == 4)
    }

    @Test func `successful request orders lifetime cancellation after its frame`() async throws {
        let queue = SidecarWriteQueue()
        let lifetime = WebSocketRequestLifetime()
        let (events, received) = AsyncStream<Int>.makeStream()
        defer { queue.close(URLError(.cancelled))
            received.finish()
        }
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            queue.enqueue(
                SidecarPayload(Data([1])),
                lane: .application,
                lifetime: lifetime,
                continuation: continuation,
                prepare: { ($0, Data([2])) },
                write: { data in received.yield(Int(data.bytes[0])) },
                failed: { _ in received.yield(-1) })
        }
        lifetime.finish()
        var iterator = events.makeAsyncIterator()
        #expect(await iterator.next() == 1)
        #expect(await iterator.next() == 2)
        lifetime.finish()
        queue.enqueue(
            SidecarPayload(Data([3])),
            lane: .receipt,
            write: { _ in received.yield(3) },
            failed: { _ in received.yield(-1) })
        #expect(await iterator.next() == 3)
    }

    @Test(arguments: [false, true])
    func `cancelled waiting and admitted requests never reach the pipe`(utf8: Bool) async {
        let queue = SidecarWriteQueue()
        let gate = DispatchSemaphore(value: 0)
        let (events, received) = AsyncStream<Int>.makeStream()
        defer { gate.signal()
            queue.close(URLError(.cancelled))
            received.finish()
        }
        queue.enqueue(SidecarPayload(Data(repeating: 1, count: 40 * 1024 * 1024)), lane: .application, write: { _ in
            received.yield(1)
            gate.wait()
        }, failed: { _ in received.yield(-1) })
        var iterator = events.makeAsyncIterator()
        #expect(await iterator.next() == 1)
        let waitingLifetime = WebSocketRequestLifetime()
        let admittedLifetime = WebSocketRequestLifetime()
        for (byte, size, lifetime) in [(2, 40, waitingLifetime), (3, 10, admittedLifetime)] {
            let payload = utf8 ? SidecarPayload(body: .utf8(String(
                repeating: byte == 2 ? "😀" : "🦞", count: size * 1024 * 1024 / 4))) :
                SidecarPayload(Data(repeating: UInt8(byte), count: size * 1024 * 1024))
            queue.enqueue(
                payload, lane: .application,
                lifetime: lifetime,
                prepare: { data in (data, Data([99])) },
                write: { _ in received.yield(byte) }, failed: { _ in received.yield(-1) })
        }
        waitingLifetime.finish()
        admittedLifetime.finish()
        queue.enqueue(SidecarPayload(Data([4])), lane: .application, write: { _ in received.yield(4) }, failed: { _ in
            received.yield(-1)
        })
        gate.signal()
        #expect(await iterator.next() == 4)
    }

    @Test func `retirement wakes a byte blocked writer before the pipe drains`() async {
        let queue = SidecarWriteQueue()
        let gate = DispatchSemaphore(value: 0)
        let (events, received) = AsyncStream<Int>.makeStream()
        defer { gate.signal()
            received.finish()
        }
        queue.enqueue(SidecarPayload(Data(repeating: 1, count: 40 * 1024 * 1024)), lane: .application, write: { _ in
            received.yield(1)
            gate.wait()
        }, failed: { _ in })
        var iterator = events.makeAsyncIterator()
        #expect(await iterator.next() == 1)
        let waiting = Task {
            do {
                try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                    queue.enqueue(
                        SidecarPayload(Data(repeating: 2, count: 40 * 1024 * 1024)), lane: .application,
                        continuation: continuation, write: { _ in received.yield(-1) }, failed: { _ in })
                    received.yield(2)
                }
                return false
            } catch { return (error as? URLError)?.code == .cancelled }
        }
        #expect(await iterator.next() == 2)
        queue.close(URLError(.cancelled))
        #expect(await waiting.value)
        // The first injected pipe write is still blocked: retirement cannot rely on its completion.
        gate.signal()
    }
}

struct SidecarWriteQueueCapacityTests {
    @Test func `RPC leases survive writes and reserve cancellation without blocking native delivery`() async throws {
        let owner = SidecarWriteQueue()
        let gate = DispatchSemaphore(value: 0)
        let (events, output) = AsyncStream<String>.makeStream()
        defer { gate.signal()
            owner.close(URLError(.cancelled))
            output.finish()
        }
        var active: [WebSocketRequestLifetime] = []
        // Fully written requests still own helper slots. Both classes must retain their
        // reservations until cancellation reaches the pipe, not merely until write returns.
        for lane in [SidecarWriteQueue.Lane.application, .progress] {
            for _ in 0..<64 {
                let lifetime = WebSocketRequestLifetime()
                active.append(lifetime)
                try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                    owner.enqueue(
                        SidecarPayload(Data([1])), lane: lane, lifetime: lifetime, continuation: continuation,
                        prepare: { ($0, Data([2])) },
                        write: { data in if data.bytes[0] == 2 { output.yield("cancel") } },
                        failed: { _ in output.yield("failure") })
                }
            }
        }
        var waiting: [WebSocketRequestLifetime] = []
        for lane in [SidecarWriteQueue.Lane.application, .progress] {
            for _ in 0..<64 {
                let lifetime = WebSocketRequestLifetime()
                waiting.append(lifetime)
                owner.enqueue(
                    SidecarPayload(Data([3])), lane: lane, lifetime: lifetime,
                    prepare: { ($0, Data([4])) }, write: { _ in output.yield("unexpected waiting RPC") },
                    failed: { _ in output.yield("failure") })
            }
        }
        // All ordinary/progress waiting counts are full. A native result must still start.
        owner.enqueue(SidecarPayload(Data(repeating: 5, count: 25 * 1024 * 1024)), lane: .delivery, write: { _ in
            output.yield("result started")
            gate.wait()
        }, failed: { _ in output.yield("failure") })
        var received = events.makeAsyncIterator()
        #expect(await received.next() == "result started")
        for lifetime in active + waiting {
            lifetime.finish()
        }
        for lane in [SidecarWriteQueue.Lane.admission, .keepalive] {
            for _ in 0..<64 {
                owner.enqueue(
                    SidecarPayload(Data([6])),
                    lane: lane,
                    write: { _ in output.yield("control") },
                    failed: { _ in
                        output.yield("failure")
                    })
            }
        }
        owner.enqueue(SidecarPayload(Data([7])), lane: .receipt, write: { _ in output.yield("receipt") }, failed: { _ in
            output.yield("failure")
        })
        gate.signal()
        var counts: [String: Int] = [:]
        for _ in 0..<257 {
            let event = try #require(await received.next())
            counts[event, default: 0] += 1
        }
        #expect(counts == ["cancel": 128, "control": 128, "receipt": 1])
        // The drained cancellation permits the next ordinary RPC on the same owner.
        let reused = WebSocketRequestLifetime()
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            owner.enqueue(
                SidecarPayload(Data([8])), lane: .application, lifetime: reused, continuation: continuation,
                prepare: { ($0, Data([9])) }, write: { _ in output.yield("reused") },
                failed: { _ in output.yield("failure") })
        }
        #expect(await received.next() == "reused")
        reused.finish()
        #expect(await received.next() == "reused")
    }

    @Test(arguments: [false, true])
    func `cancellation and retirement resume a request waiting for an RPC lease`(retire: Bool) async throws {
        let owner = SidecarWriteQueue()
        defer { owner.close(URLError(.cancelled)) }
        for _ in 0..<64 {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                owner.enqueue(
                    SidecarPayload(Data([1])), lane: .application, lifetime: WebSocketRequestLifetime(),
                    continuation: continuation,
                    prepare: { ($0, Data([2])) }, write: { _ in }, failed: { _ in })
            }
        }
        let (events, output) = AsyncStream<Void>.makeStream()
        defer { output.finish() }
        let waitingLifetime = WebSocketRequestLifetime()
        let waiting = Task {
            do {
                try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                    owner.enqueue(
                        SidecarPayload(Data([3])), lane: .application, lifetime: waitingLifetime,
                        continuation: continuation,
                        prepare: { ($0, Data([4])) }, write: { _ in Issue.record("Retired RPC reached the pipe") },
                        failed: { _ in })
                    output.yield(())
                }
                return false
            } catch {
                return retire ? (error as? URLError)?.code == .cancelled : error is CancellationError
            }
        }
        var received = events.makeAsyncIterator()
        _ = await received.next()
        if retire { owner.close(URLError(.cancelled)) } else { waitingLifetime.finish() }
        #expect(await waiting.value)
    }
}

struct SidecarWriteQueueAcknowledgementTests {
    @Test func `Pong receipt capacity is independent of data write receipts`() async {
        let owner = SidecarWriteQueue()
        let gate = DispatchSemaphore(value: 0)
        let (events, output) = AsyncStream<Int>.makeStream()
        defer { owner.close(URLError(.cancelled))
            output.finish()
        }
        owner.enqueue(
            SidecarPayload(Data([1])),
            lane: .receipt,
            write: { _ in output.yield(1)
                gate.wait()
            },
            failed: { _ in output.yield(-1) })
        var iterator = events.makeAsyncIterator()
        #expect(await iterator.next() == 1)
        for (id, lane) in [(2, SidecarWriteQueue.Lane.receipt), (3, .pong), (4, .pong)] {
            owner.enqueue(
                SidecarPayload(Data([UInt8(id)])),
                lane: lane,
                write: { _ in output.yield(id) },
                failed: { _ in output.yield(-1) })
        }
        gate.signal()
        #expect(await iterator.next() == 2)
        #expect(await iterator.next() == 3)
        #expect(await iterator.next() == 4)
    }

    @Test(arguments: [SidecarWriteQueue.Lane.transport, .receipt, .pong])
    func `peer acknowledgement can arrive before physical write completion`(lane: SidecarWriteQueue.Lane) async {
        let owner = SidecarWriteQueue()
        let (events, output) = AsyncStream<Int>.makeStream()
        defer { owner.close(URLError(.cancelled))
            output.finish()
        }
        owner.enqueue(SidecarPayload(Data([1])), lane: lane, write: { _ in
            // The peer consumes the bytes and acknowledges them before this thread
            // resumes to release the completed writer slot. It may now send one successor.
            output.yield(1)
            owner.enqueue(
                SidecarPayload(Data([2])),
                lane: lane,
                write: { _ in output.yield(2) },
                failed: { _ in output.yield(-1) })
        }, failed: { _ in output.yield(-1) })
        var iterator = events.makeAsyncIterator()
        #expect(await iterator.next() == 1)
        #expect(await iterator.next() == 2)
    }
}
