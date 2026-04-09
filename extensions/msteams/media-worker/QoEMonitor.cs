using Microsoft.Skype.Bots.Media;

namespace OpenClaw.MsTeams.Voice;

/// <summary>
/// Monitors audio stream quality for a call. Subscribes to
/// MediaStreamQualityChangedEventArgs and MediaStreamFailure events on
/// IAudioSocket and emits QoEEvent/ErrorEvent to gRPC subscribers.
///
/// On MediaStreamFailure, triggers automatic rejoin via CallHandler.
/// </summary>
public sealed class QoEMonitor
{
    private readonly string _callId;
    private readonly ILogger<QoEMonitor> _logger;

    /// <summary>
    /// Fires when a QoE metric event is received from the media platform.
    /// </summary>
    public event EventHandler<QoEEvent>? OnQoEEvent;

    /// <summary>
    /// Fires on a fatal media stream failure. The CallHandler should attempt
    /// an automatic rejoin when this fires.
    /// </summary>
    public event EventHandler<ErrorEvent>? OnMediaFailure;

    public QoEMonitor(string callId, ILogger<QoEMonitor> logger)
    {
        _callId = callId;
        _logger = logger;
    }

    /// <summary>
    /// Attaches to an IAudioSocket to receive quality and failure events.
    /// </summary>
    /// <param name="audioSocket">The audio socket to monitor.</param>
    public void AttachToSocket(IAudioSocket audioSocket)
    {
        audioSocket.MediaStreamQualityChanged += OnMediaStreamQualityChanged;
        audioSocket.MediaStreamFailure += OnMediaStreamFailureEvent;

        _logger.LogInformation("QoE monitor attached to audio socket for call {CallId}", _callId);
    }

    /// <summary>
    /// Handles media stream quality change events. These contain packet loss
    /// and jitter metrics from the media platform.
    /// </summary>
    private void OnMediaStreamQualityChanged(object? sender, MediaStreamQualityChangedEventArgs args)
    {
        var evt = new QoEEvent
        {
            SpeakerId = 0, // Quality events are per-stream, not per-speaker.
            PacketLoss = args.PacketLossRate,
            JitterMs = (uint)args.JitterBufferLengthInMs,
        };

        _logger.LogDebug(
            "QoE event for call {CallId}: packetLoss={Loss}%, jitter={Jitter}ms",
            _callId, args.PacketLossRate * 100, args.JitterBufferLengthInMs);

        OnQoEEvent?.Invoke(this, evt);
    }

    /// <summary>
    /// Handles fatal media stream failure events. Logs the failure and raises
    /// the OnMediaFailure event so the call handler can attempt rejoin.
    /// </summary>
    private void OnMediaStreamFailureEvent(object? sender, MediaStreamFailureEventArgs args)
    {
        _logger.LogError(
            "Media stream failure on call {CallId}: {Message}",
            _callId, args.ToString());

        var errorEvent = new ErrorEvent
        {
            Message = $"MediaStreamFailure: {args}",
            Recoverable = true,
        };

        OnMediaFailure?.Invoke(this, errorEvent);
    }
}
