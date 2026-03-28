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

    // 1-second throttle between confirmation prompts (Unix ms, Interlocked-safe)
    private long _lastPromptAtMs;

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
            _log.LogDebug("Ignored URL {Url}", RedactUri(url));
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
            var nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            if (nowMs - Interlocked.Read(ref _lastPromptAtMs) < 1000)
            {
                _log.LogDebug("Throttling deep link prompt");
                return;
            }
            Interlocked.Exchange(ref _lastPromptAtMs, nowMs);

            if (message.Length > MaxUnkeyedConfirmChars)
            {
                await _confirm.AlertAsync(
                    "Deep link blocked",
                    $"Message is too long to confirm safely ({message.Length} chars; max {MaxUnkeyedConfirmChars} without key).");
                return;
            }

            var urlText    = RedactUri(originalUrl);
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
        settings.SetRemoteTransport(RemoteTransport.Direct);
        // Preserve existing credentials only when the deep link targets the same host.
        // A host-only link for a different host must clear the old credentials — they would
        // otherwise be forwarded to an unrelated gateway via GatewayEndpointStore.
        var sameHost = !string.IsNullOrEmpty(settings.RemoteUrl)
            && Uri.TryCreate(settings.RemoteUrl, UriKind.Absolute, out var existing)
            && string.Equals(existing.Host, link.Host, StringComparison.OrdinalIgnoreCase);

        if (link.Token    is not null) settings.SetRemoteToken(link.Token);
        else if (!sameHost)            settings.SetRemoteToken(string.Empty);

        if (link.Password is not null) settings.SetRemotePassword(link.Password);
        else if (!sameHost)            settings.SetRemotePassword(string.Empty);

        var saveResult = await _sender.Send(new SaveSettingsCommand(settings));
        if (saveResult.IsError)
            _log.LogWarning("Gateway deep link: failed to save settings — {Error}", saveResult.FirstError.Description);
    }

    // Replaces values of sensitive query params (key, token, password) with *** before
    // logging or displaying a deep-link URI, to prevent credential exposure in logs/UI.
    private static string RedactUri(Uri uri)
    {
        if (string.IsNullOrEmpty(uri.Query)) return uri.AbsoluteUri;
        var parts = uri.Query.TrimStart('?').Split('&');
        var redacted = parts.Select(p =>
        {
            var eq = p.IndexOf('=');
            if (eq < 0) return p;
            var key = Uri.UnescapeDataString(p[..eq]);
            return key is "key" or "token" or "password"
                ? p[..eq] + "=***"
                : p;
        });
        return new UriBuilder(uri) { Query = string.Join("&", redacted) }.Uri.AbsoluteUri;
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
