using System.Text.Json;
using OpenClawWindows.Application.Behaviors;
using OpenClawWindows.Application.Gateway;

namespace OpenClawWindows.Application.Channels;

[UseCase("UC-046")]
public sealed record SubscribeChannelCommand(string ChannelId) : IRequest<ErrorOr<Success>>;

internal sealed class SubscribeChannelHandler : IRequestHandler<SubscribeChannelCommand, ErrorOr<Success>>
{
    private readonly IGatewayWebSocket _socket;
    private readonly IChannelStore _channelStore;
    private readonly ILogger<SubscribeChannelHandler> _logger;

    public SubscribeChannelHandler(IGatewayWebSocket socket, IChannelStore channelStore,
        ILogger<SubscribeChannelHandler> logger)
    {
        _socket = socket;
        _channelStore = channelStore;
        _logger = logger;
    }

    public async Task<ErrorOr<Success>> Handle(SubscribeChannelCommand cmd, CancellationToken ct)
    {
        Guard.Against.NullOrEmpty(cmd.ChannelId, nameof(cmd.ChannelId));

        var message = JsonSerializer.Serialize(new { type = "channel.subscribe", channelId = cmd.ChannelId });
        var result = await _socket.SendAsync(message, ct);
        if (result.IsError)
            return result.Errors;

        _channelStore.Register(cmd.ChannelId);
        _logger.LogInformation("Subscribed to channel {ChannelId}", cmd.ChannelId);
        return Result.Success;
    }
}
