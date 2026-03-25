using System.Security.Cryptography;
using OpenClawWindows.Application.Ports;
using OpenClawWindows.Application.Settings;
using OpenClawWindows.Domain.DeepLinks;
using OpenClawWindows.Domain.Settings;
using static OpenClawWindows.Application.DeepLinks.DeepLinkParser;

namespace OpenClawWindows.Application.DeepLinks;

// and unattended-key logic.
internal sealed class DeepLinkHandler
{
    // Generated once per process — used for Canvas→agent calls without user confirmation.
    private static readonly string _canvasKey = GenerateRandomKey();

    private const int MaxMessageChars        = 20_000;
    private const int MaxUnkeyedConfirmChars = 240;

    private readonly IDeepLinkKeyStore        _keyStore;
    private readonly IDeepLinkConfirmation    _confirm;
    private readonly IGatewayRpcChannel       _rpc;
    private readonly ISender                  _sender;
    private readonly ILogger<DeepLinkHandler> _log;

    // 1-second throttle between confirmation prompts
    private DateTime _lastPromptAt = DateTime.MinValue;

    public DeepLinkHandler(
        IDeepLinkKeyStore        keyStore,
        IDeepLinkConfirmation    confirm,
        IGatewayRpcChannel       rpc,
        ISender                  sender,
        ILogger<DeepLinkHandler> log)
    {
        _keyStore = keyStore;
        _confirm  = confirm;
        _rpc      = rpc;
        _sender   = sender;
        _log      = log;
    }

    // Exposed so other components (e.g. Canvas) can embed the current keys in URLs.
    public static string CurrentKey()       => string.Empty; // forwarded via keyStore at callsite
    public static string CurrentCanvasKey() => _canvasKey;

    public async Task HandleAsync(Uri url)
    {
        var route = Parse(url);
        if (route is null)
        {
            _log.LogDebug("Ignored URL {Url}", url.AbsoluteUri);
            return;
        }

        switch (route)
        {
            case AgentRoute a:
                await HandleAgentAsync(a.Link, url);
                break;

            case GatewayRoute g:
                await HandleGatewayAsync(g.Link);
                break;
        }
    }

    private async Task HandleAgentAsync(AgentDeepLink link, Uri originalUrl)
    {
        var message = link.Message.Trim();

        if (message.Length > MaxMessageChars)
        {
            await _confirm.AlertAsync("Deep link too large", "Message exceeds 20,000 characters.");
            return;
        }

        var expectedKey    = _keyStore.GetOrCreateKey();
        var allowUnattended = link.Key == _canvasKey || link.Key == expectedKey;

        if (!allowUnattended)
        {
            // Throttle — prevents prompt flooding from rapid external activations.
            if (DateTime.UtcNow - _lastPromptAt < TimeSpan.FromSeconds(1))
            {
                _log.LogDebug("Throttling deep link prompt");
                return;
            }
            _lastPromptAt = DateTime.UtcNow;

            if (message.Length > MaxUnkeyedConfirmChars)
            {
                await _confirm.AlertAsync(
                    "Deep link blocked",
                    $"Message is too long to confirm safely ({message.Length} chars; max {MaxUnkeyedConfirmChars} without key).");
                return;
            }

            var urlText    = originalUrl.AbsoluteUri;
            var urlPreview = urlText.Length > 500 ? urlText[..500] + "…" : urlText;
            var body       = $"Run the agent with this message?\n\n{message}\n\nURL:\n{urlPreview}";

            if (!await _confirm.ConfirmAsync("Run OpenClaw agent?", body))
                return;
        }

        var sessionKey = !string.IsNullOrWhiteSpace(link.SessionKey)
            ? link.SessionKey
            : await _rpc.MainSessionKeyAsync(ct: default);

        var invocation = new GatewayAgentInvocation(
            Message:        message,
            SessionKey:     sessionKey,
            Thinking:       link.Thinking,
            Deliver:        link.Deliver,
            To:             link.To,
            Channel:        link.Channel ?? "last",
            TimeoutSeconds: link.TimeoutSeconds);

        var (ok, error) = await _rpc.SendAgentAsync(invocation);
        if (!ok)
            _log.LogWarning("Deep link agent dispatch failed: {Error}", error);
    }

    private async Task HandleGatewayAsync(GatewayConnectDeepLink link)
    {
        var scheme = link.Tls ? "wss" : "ws";
        var url    = $"{scheme}://{link.Host}:{link.Port}";

        if (!await _confirm.ConfirmAsync("Connect to gateway?", $"Connect OpenClaw to gateway at:\n\n{url}"))
            return;

        var settingsResult = await _sender.Send(new GetSettingsQuery());
        if (settingsResult.IsError)
        {
            _log.LogWarning("Gateway deep link: failed to load settings — {Error}", settingsResult.FirstError.Description);
            return;
        }

        var settings = settingsResult.Value;
        settings.SetRemoteUrl(url);
        settings.SetConnectionMode(ConnectionMode.Remote);

        var saveResult = await _sender.Send(new SaveSettingsCommand(settings));
        if (saveResult.IsError)
            _log.LogWarning("Gateway deep link: failed to save settings — {Error}", saveResult.FirstError.Description);
    }

    private static string GenerateRandomKey()
    {
        var bytes = new byte[32];
        RandomNumberGenerator.Fill(bytes);
        return Convert.ToBase64String(bytes)
            .Replace('+', '-')
            .Replace('/', '_')
            .TrimEnd('=');
    }
}
