using Microsoft.Extensions.Logging;
using OpenClawWindows.Application.Ports;

namespace OpenClawWindows.Application.VoiceWake;

internal sealed record ForwardOptions
{
    internal string  SessionKey { get; init; } = "main";
    internal string  Thinking   { get; init; } = "low";
    internal bool    Deliver    { get; init; } = true;
    internal string? To         { get; init; }
    // stored as string to match GatewayAgentInvocation.Channel
    internal string  Channel    { get; init; } = "webchat";
}

internal interface IVoiceWakeForwarder
{
    Task<(bool Ok, string? Error)> ForwardAsync(
        string transcript,
        ForwardOptions? options = null,
        CancellationToken ct = default);
}

/// <summary>
/// Routes voice-recognized transcripts to the gateway agent, adding a voice origin prefix.
/// </summary>
internal sealed class VoiceWakeForwarder : IVoiceWakeForwarder
{
    private readonly IGatewayRpcChannel          _rpc;
    private readonly ILogger<VoiceWakeForwarder> _logger;

    public VoiceWakeForwarder(IGatewayRpcChannel rpc, ILogger<VoiceWakeForwarder> logger)
    {
        _rpc    = rpc;
        _logger = logger;
    }

    internal static string PrefixedTranscript(string transcript, string? machineName = null)
    {
        var resolved = machineName?.Trim() is { Length: > 0 } trimmed
            ? trimmed
            : Environment.MachineName;

        var safeMachine = string.IsNullOrEmpty(resolved) ? "this PC" : resolved;

        return $"User talked via voice recognition on {safeMachine} - repeat prompt first " +
               $"+ remember some words might be incorrectly transcribed.\n\n{transcript}";
    }

    // Explicit interface implementation: IVoiceWakeForwarder is internal, so implicit impl would require public.
    async Task<(bool Ok, string? Error)> IVoiceWakeForwarder.ForwardAsync(
        string transcript,
        ForwardOptions? options,
        CancellationToken ct)
        => await ForwardAsync(transcript, options, ct);

    internal async Task<(bool Ok, string? Error)> ForwardAsync(
        string transcript,
        ForwardOptions? options = null,
        CancellationToken ct = default)
    {
        options ??= new ForwardOptions();
        var payload = PrefixedTranscript(transcript);
        var deliver = ShouldDeliver(options.Channel, options.Deliver);

        var result = await _rpc.SendAgentAsync(new GatewayAgentInvocation(
            Message:    payload,
            SessionKey: options.SessionKey,
            Thinking:   options.Thinking,
            Deliver:    deliver,
            To:         options.To,
            Channel:    options.Channel), ct);

        if (result.Ok)
        {
            _logger.LogInformation("voice wake forward ok");
            return (true, null);
        }

        var message = result.Error ?? "agent rpc unavailable";
        _logger.LogError("voice wake forward failed: {Message}", message);
        return (false, message);
    }

    internal async Task<(bool Ok, string? Error)> CheckConnectionAsync(CancellationToken ct = default)
    {
        var status = await _rpc.StatusAsync(ct);
        if (status.Ok) return (true, null);
        return (false, status.Error ?? "agent rpc unreachable");
    }

    private static bool ShouldDeliver(string channel, bool deliver)
        => deliver && channel != "webchat";
}
