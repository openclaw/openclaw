import OpenClawKit
import OSLog

private let logger = Logger(subsystem: "ai.openclaw", category: "gateway-push-subscription")

enum GatewayPushSubscription {
    @MainActor
    static func consume(
        bufferingNewest: Int? = nil,
        onPush: @escaping @MainActor (GatewayPush) -> Void) async
    {
        // Re-subscribe in a loop: when the GatewayConnection replaces its underlying
        // GatewayChannelActor (e.g. after a gateway restart), the old AsyncStream ends.
        // Without this loop the consumer would silently stop receiving pushes.
        while !Task.isCancelled {
            let stream: AsyncStream<GatewayPush> = if let bufferingNewest {
                await GatewayConnection.shared.subscribe(bufferingNewest: bufferingNewest)
            } else {
                await GatewayConnection.shared.subscribe()
            }

            for await push in stream {
                if Task.isCancelled { return }
                await MainActor.run {
                    onPush(push)
                }
            }
            // Stream ended — the connection was reconfigured. Back off briefly, then re-subscribe.
            if Task.isCancelled { return }
            logger.info("gateway push stream ended; re-subscribing")
            try? await Task.sleep(nanoseconds: 1_000_000_000) // 1s
        }
    }

    @MainActor
    static func restartTask(
        task: inout Task<Void, Never>?,
        bufferingNewest: Int? = nil,
        onPush: @escaping @MainActor (GatewayPush) -> Void)
    {
        task?.cancel()
        task = Task {
            await self.consume(bufferingNewest: bufferingNewest, onPush: onPush)
        }
    }
}
