using System.Text.Json;
using OpenClawWindows.Application.Behaviors;
using OpenClawWindows.Domain.Gateway.Events;

namespace OpenClawWindows.Application.Channels;

// On every gateway reconnect, re-sends channel.subscribe for all registered channels.
// Without this, the gateway loses subscription state after a WebSocket reconnect.
[UseCase("UC-046-resubscribe")]
internal sealed class ResubscribeChannelsOnConnectHandler : INotificationHandler<GatewayConnected>
{
    private readonly IGatewayWebSocket _socket;
    private readonly IChannelStore _channelStore;
    private readonly ILogger<ResubscribeChannelsOnConnectHandler> _logger;

    public ResubscribeChannelsOnConnectHandler(
        IGatewayWebSocket socket,
        IChannelStore channelStore,
        ILogger<ResubscribeChannelsOnConnectHandler> logger)
    {
        _socket       = socket;
        _channelStore = channelStore;
        _logger       = logger;
    }

    public async Task Handle(GatewayConnected notification, CancellationToken ct)
    {
        var active = _channelStore.GetActive();
        if (active.Count == 0) return;

        foreach (var channelId in active)
        {
            var message = JsonSerializer.Serialize(
                new { type = "channel.subscribe", channelId },
                new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.CamelCase });

            var result = await _socket.SendAsync(message, ct);
            if (result.IsError)
                _logger.LogWarning("Re-subscribe failed for channel {ChannelId}: {Error}",
                    channelId, result.FirstError.Description);
            else
                _logger.LogInformation("Re-subscribed channel {ChannelId} after reconnect", channelId);
        }
    }
}
