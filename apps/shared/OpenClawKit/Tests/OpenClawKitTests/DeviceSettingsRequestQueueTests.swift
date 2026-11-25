import OpenClawKit
import Testing

@MainActor
struct DeviceSettingsRequestQueueTests {
    @Test func `admitted replies do not block later intent admission`() async {
        let queue = DeviceSettingsRequestQueue()
        let started = AsyncStream<Void>.makeStream()
        let admitted = AsyncStream<Void>.makeStream()
        let finished = AsyncStream<Void>.makeStream()
        var starts = started.stream.makeAsyncIterator()
        var admissions = admitted.stream.makeAsyncIterator()
        var finishes = finished.stream.makeAsyncIterator()
        var release: CheckedContinuation<Void, Never>?
        var order: [Int] = []
        queue.enqueueAdmission {
            order.append(1)
            return {
                await withCheckedContinuation { continuation in
                    release = continuation
                    started.continuation.yield(())
                }
                order.append(3)
                finished.continuation.yield(())
            }
        }
        await starts.next()
        queue.enqueue {
            order.append(2)
            admitted.continuation.yield(())
        }
        await admissions.next()
        #expect(order == [1, 2])
        release?.resume()
        await finishes.next()
        #expect(order == [1, 2, 3])
        queue.cancel()
        started.continuation.finish()
        admitted.continuation.finish()
        finished.continuation.finish()
    }

    @Test func `closing retires an admitted reply and cancels its completion`() async {
        let queue = DeviceSettingsRequestQueue()
        let started = AsyncStream<Void>.makeStream()
        let finished = AsyncStream<Void>.makeStream()
        var starts = started.stream.makeAsyncIterator()
        var finishes = finished.stream.makeAsyncIterator()
        var release: CheckedContinuation<Void, Never>?
        var cancellations = 0
        var wasCancelled = false
        queue.enqueueAdmission {
            {
                await withCheckedContinuation { continuation in
                    release = continuation
                    started.continuation.yield(())
                }
                wasCancelled = Task.isCancelled
                finished.continuation.yield(())
            }
        } onCancel: {
            cancellations += 1
        }
        await starts.next()
        queue.cancel()
        #expect(cancellations == 1)
        release?.resume()
        await finishes.next()
        #expect(wasCancelled)
        queue.cancel()
        #expect(cancellations == 1)
        started.continuation.finish()
        finished.continuation.finish()
    }

    @Test func `requests wait for the active confirmation before running in order`() async {
        let queue = DeviceSettingsRequestQueue()
        let events = AsyncStream<Void>.makeStream()
        var iterator = events.stream.makeAsyncIterator()
        var release: CheckedContinuation<Void, Never>?
        var order: [Int] = []
        queue.enqueue {
            order.append(1)
            await withCheckedContinuation { continuation in
                release = continuation
                events.continuation.yield(())
            }
            order.append(2)
        }
        await iterator.next()
        queue.enqueue {
            order.append(3)
            events.continuation.yield(())
        }
        #expect(order == [1])
        release?.resume()
        await iterator.next()
        #expect(order == [1, 2, 3])
        queue.cancel()
        events.continuation.finish()
    }

    @Test func `closing cancels the active request and drops queued work before reopening`() async {
        let queue = DeviceSettingsRequestQueue()
        let started = AsyncStream<Void>.makeStream()
        let completed = AsyncStream<Void>.makeStream()
        var starts = started.stream.makeAsyncIterator()
        var completions = completed.stream.makeAsyncIterator()
        var releaseActive: CheckedContinuation<Void, Never>?
        var activeWasCancelled = false
        var retiredReplies = 0
        var queuedRequestRan = false
        queue.enqueue {
            #expect(!Task.isCancelled)
            await withCheckedContinuation { continuation in
                releaseActive = continuation
                started.continuation.yield(())
            }
            activeWasCancelled = Task.isCancelled
            completed.continuation.yield(())
        } onCancel: {
            retiredReplies += 1
        }
        await starts.next()
        queue.enqueue { queuedRequestRan = true }

        queue.cancel()
        #expect(retiredReplies == 1)
        releaseActive?.resume()
        await completions.next()
        #expect(activeWasCancelled)

        queue.enqueue { completed.continuation.yield(()) }
        await completions.next()
        #expect(!queuedRequestRan)
        queue.cancel()
        started.continuation.finish()
        completed.continuation.finish()
    }
}
