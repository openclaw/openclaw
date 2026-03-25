using System.Text.Json;
using OpenClawWindows.Application.Behaviors;
using OpenClawWindows.Application.Gateway;

namespace OpenClawWindows.Application.Channels;

[UseCase("UC-047")]
public sealed record UnsubscribeChannelCommand(string ChannelId) : IRequest<ErrorOr<Success>>;

internal sealed class UnsubscribeChannelHandler : IRequestHandler<UnsubscribeChannelCommand, ErrorOr<Success>>
{
    private readonly IGatewayWebSocket _socket;
    private readonly IChannelStore _channelStore;
    private readonly ILogger<UnsubscribeChannelHandler> _logger;

    public UnsubscribeChannelHandler(IGatewayWebSocket socket, IChannelStore channelStore,
        ILogger<UnsubscribeChannelHandler> logger)
    {
        _socket = socket;
        _channelStore = channelStore;
        _logger = logger;
    }

    public async Task<ErrorOr<Success>> Handle(UnsubscribeChannelCommand cmd, CancellationToken ct)
    {
        Guard.Against.NullOrEmpty(cmd.ChannelId, nameof(cmd.ChannelId));

        var message = JsonSerializer.Serialize(new { type = "channel.unsubscribe", channelId = cmd.ChannelId });
        var result = await _socket.SendAsync(message, ct);
        if (result.IsError)
            return result.Errors;

        _channelStore.Unregister(cmd.ChannelId);
        _logger.LogInformation("Unsubscribed from channel {ChannelId}", cmd.ChannelId);
        return Result.Success;
    }
}
