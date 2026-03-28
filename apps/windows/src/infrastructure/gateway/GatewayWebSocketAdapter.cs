using System.Net.WebSockets;
using System.Runtime.CompilerServices;
using System.Text;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using OpenClawWindows.Application.Ports;
using OpenClawWindows.Domain.Gateway;

namespace OpenClawWindows.Infrastructure.Gateway;

internal sealed class GatewayWebSocketAdapter : IGatewayWebSocket, IHostedService, IAsyncDisposable
{
    private readonly ILogger<GatewayWebSocketAdapter> _logger;
    private ClientWebSocket _ws = new();
    private bool _suspended;
    private CancellationTokenSource? _receiveCts;

    public GatewayWebSocketAdapter(ILogger<GatewayWebSocketAdapter> logger)
    {
        _logger = logger;
    }

    public bool IsConnected =>
        _ws.State == WebSocketState.Open;

    public async Task ConnectAsync(GatewayEndpoint endpoint, CancellationToken ct)
    {
        // Dispose stale socket so we always start fresh on reconnect
        if (_ws.State != WebSocketState.None)
        {
            _ws.Dispose();
            _ws = new ClientWebSocket();
        }

        // Mirror shanselman pattern: send credentials as Authorization: Basic header
        // and connect to a clean URI without userinfo (ClientWebSocket does not auto-send Basic auth from userinfo).
        var rawUri = endpoint.Uri;
        Uri connectUri;
        if (!string.IsNullOrEmpty(rawUri.UserInfo))
        {
            var token = Uri.UnescapeDataString(rawUri.UserInfo.Split(':')[0]);
            var encoded = Convert.ToBase64String(Encoding.UTF8.GetBytes($"{token}:"));
            _ws.Options.SetRequestHeader("Authorization", $"Basic {encoded}");
            connectUri = new Uri($"{rawUri.Scheme}://{rawUri.Host}:{rawUri.Port}{rawUri.PathAndQuery}");
        }
        else
        {
            connectUri = rawUri;
        }

        // Gateway v2026.3.13 enforces origin check for control-ui clients.
        // Local loopback origin passes checkBrowserOrigin when isLocalClient=true.
        // wss:// → https:// so the origin matches TLS deployments that allow https://<host>.
        var originScheme = connectUri.Scheme.Equals("wss", StringComparison.OrdinalIgnoreCase) ? "https" : "http";
        _ws.Options.SetRequestHeader("Origin", $"{originScheme}://{connectUri.Host}:{connectUri.Port}");

        await _ws.ConnectAsync(connectUri, ct);
        _logger.LogInformation("Connected to gateway {Uri}", endpoint.DisplayName);
    }

    public async Task DisconnectAsync()
    {
        _receiveCts?.Cancel();

        if (_ws.State == WebSocketState.Open)
        {
            await _ws.CloseAsync(WebSocketCloseStatus.NormalClosure, "client disconnect",
                CancellationToken.None);
        }
    }

    public async Task<ErrorOr<Success>> SendAsync(string json, CancellationToken ct)
    {
        if (_ws.State != WebSocketState.Open)
            return Error.Failure("GATEWAY_NOT_CONNECTED", "WebSocket is not open");

        var bytes = Encoding.UTF8.GetBytes(json);
        await _ws.SendAsync(bytes, WebSocketMessageType.Text, endOfMessage: true, ct);
        return Result.Success;
    }

    public async IAsyncEnumerable<string> ReceiveMessagesAsync(
        [EnumeratorCancellation] CancellationToken ct)
    {
        _receiveCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        var token = _receiveCts.Token;

        // 64 KB initial buffer — grows on fragmented messages
        var buffer = new byte[65536];

        while (!token.IsCancellationRequested && _ws.State == WebSocketState.Open)
        {
            if (_suspended)
            {
                await Task.Delay(50, token);
                continue;
            }

            WebSocketReceiveResult result;
            var accumulated = new List<ArraySegment<byte>>();

            try
            {
                do
                {
                    result = await _ws.ReceiveAsync(buffer, token);
                    accumulated.Add(new ArraySegment<byte>(buffer[..result.Count].ToArray()));
                }
                while (!result.EndOfMessage);
            }
            catch (WebSocketException ex) when (ex.WebSocketErrorCode == WebSocketError.ConnectionClosedPrematurely)
            {
                _logger.LogWarning(ex, "Gateway WebSocket closed unexpectedly (ConnectionClosedPrematurely)");
                yield break;
            }

            if (result.MessageType == WebSocketMessageType.Close)
            {
                _logger.LogInformation("Gateway WebSocket closed by server: status={S} desc={D}",
                    result.CloseStatus, result.CloseStatusDescription);
                yield break;
            }

            if (result.MessageType != WebSocketMessageType.Text)
                continue;

            var json = Encoding.UTF8.GetString(accumulated
                .SelectMany<ArraySegment<byte>, byte>(seg => seg)
                .ToArray());

            yield return json;
        }
    }

    public Task SuspendReceivingAsync(CancellationToken ct)
    {
        _suspended = true;
        return Task.CompletedTask;
    }

    public Task ResumeReceivingAsync(CancellationToken ct)
    {
        _suspended = false;
        return Task.CompletedTask;
    }

    // IHostedService — gateway connects when the host starts
    public Task StartAsync(CancellationToken ct) => Task.CompletedTask;

    public async Task StopAsync(CancellationToken ct) => await DisconnectAsync();

    public async ValueTask DisposeAsync()
    {
        _receiveCts?.Cancel();
        _receiveCts?.Dispose();

        if (_ws.State == WebSocketState.Open)
        {
            await _ws.CloseAsync(WebSocketCloseStatus.NormalClosure, "",
                CancellationToken.None);
        }

        _ws.Dispose();
    }
}
