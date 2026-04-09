using Microsoft.Graph.Communications.Calls;

namespace OpenClaw.MsTeams.Voice;

/// <summary>
/// Manages recording compliance for a call. After the call reaches Established,
/// calls updateRecordingStatus on the Graph call resource. No audio data is
/// forwarded to the TS agent plane until compliance reaches the "active" state.
/// </summary>
public sealed class ComplianceGate
{
    private readonly string _callId;
    private readonly ILogger<ComplianceGate> _logger;
    private volatile string _state = "awaiting";

    /// <summary>
    /// Fires whenever the compliance state changes (awaiting, active, denied).
    /// </summary>
    public event EventHandler<ComplianceEvent>? OnComplianceChanged;

    /// <summary>
    /// Current compliance state: "awaiting", "active", or "denied".
    /// </summary>
    public string State => _state;

    /// <summary>
    /// Returns true only when recording compliance has been confirmed active.
    /// This is the hard gate: no audio forwarding until this returns true.
    /// </summary>
    public bool IsActive => _state == "active";

    public ComplianceGate(string callId, ILogger<ComplianceGate> logger)
    {
        _callId = callId;
        _logger = logger;
    }

    /// <summary>
    /// Initiates the recording compliance flow by calling updateRecordingStatus
    /// on the Graph call resource. This should be called once the call reaches
    /// the Established state.
    /// </summary>
    /// <param name="call">The Graph call resource to update.</param>
    public async Task InitiateRecordingCompliance(ICall call)
    {
        _logger.LogInformation("Initiating recording compliance for call {CallId}", _callId);
        SetState("awaiting");

        try
        {
            // Request the meeting to acknowledge bot recording.
            // The SDK call.Resource.UpdateRecordingStatusAsync sets the recording
            // indicator in the Teams UI and returns the compliance acknowledgment.
            await call.Resource.UpdateRecordingStatusAsync(
                Microsoft.Graph.RecordingStatus.Recording);

            // If we reach here without exception, recording is acknowledged.
            SetState("active");
            _logger.LogInformation("Recording compliance active for call {CallId}", _callId);
        }
        catch (Microsoft.Graph.ServiceException ex)
            when (ex.StatusCode == System.Net.HttpStatusCode.Forbidden)
        {
            // The meeting policy denied recording.
            SetState("denied");
            _logger.LogWarning(
                "Recording compliance denied for call {CallId}: {Message}",
                _callId, ex.Message);
        }
        catch (Exception ex)
        {
            // Unexpected failure -- treat as denied for safety.
            SetState("denied");
            _logger.LogError(ex,
                "Recording compliance failed for call {CallId}", _callId);
        }
    }

    /// <summary>
    /// Updates the compliance state and emits the corresponding event.
    /// </summary>
    private void SetState(string newState)
    {
        var previousState = _state;
        _state = newState;

        if (previousState != newState)
        {
            _logger.LogInformation(
                "Compliance state for call {CallId}: {Previous} -> {Current}",
                _callId, previousState, newState);

            OnComplianceChanged?.Invoke(this, new ComplianceEvent
            {
                Status = newState,
            });
        }
    }
}
