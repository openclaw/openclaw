using System.Threading.Channels;
using Grpc.Core;
using Google.Protobuf;

namespace OpenClaw.MsTeams.Voice;

/// <summary>
/// gRPC service implementation for TeamsMediaBridge. This is the main entry
/// point for the TS agent plane to orchestrate call lifecycle, audio capture,
/// TTS playback, and event subscriptions against the .NET media worker.
/// </summary>
public sealed class BridgeService : TeamsMediaBridge.TeamsMediaBridgeBase
{
    private readonly CallHandler _callHandler;
    private readonly WorkerRegistry _registry;
    private readonly ILoggerFactory _loggerFactory;
    private readonly ILogger<BridgeService> _logger;

    public BridgeService(
        CallHandler callHandler,
        WorkerRegistry registry,
        ILoggerFactory loggerFactory)
    {
        _callHandler = callHandler;
        _registry = registry;
        _loggerFactory = loggerFactory;
        _logger = loggerFactory.CreateLogger<BridgeService>();
    }

    /// <summary>
    /// Joins a Teams meeting. Delegates to CallHandler, which creates the call
    /// via the stateful Graph Communications SDK with app-hosted media config
    /// and unmixed audio.
    /// </summary>
    public override async Task<JoinMeetingResponse> JoinMeeting(
        JoinMeetingRequest request, ServerCallContext context)
    {
        _logger.LogInformation(
            "gRPC JoinMeeting: callId={CallId}, tenant={Tenant}",
            request.CallId, request.TenantId);

        return await _callHandler.JoinMeeting(request, _loggerFactory);
    }

    /// <summary>
    /// Leaves / hangs up a call. Delegates to CallHandler, which tears down
    /// media and cleans up all state.
    /// </summary>
    public override async Task<LeaveCallResponse> LeaveCall(
        LeaveCallRequest request, ServerCallContext context)
    {
        _logger.LogInformation("gRPC LeaveCall: callId={CallId}", request.CallId);
        return await _callHandler.LeaveCall(request.CallId);
    }

    /// <summary>
    /// Server-streaming RPC: subscribes to per-speaker unmixed PCM audio
    /// segments for a call. The stream stays open until the client disconnects
    /// or the call ends.
    /// </summary>
    public override async Task SubscribeUnmixedAudio(
        SubscribeAudioRequest request,
        IServerStreamWriter<UnmixedAudioSegment> responseStream,
        ServerCallContext context)
    {
        _logger.LogInformation("gRPC SubscribeUnmixedAudio: callId={CallId}", request.CallId);

        var session = _callHandler.GetCall(request.CallId);
        if (session == null)
        {
            throw new RpcException(new Status(StatusCode.NotFound, $"Call {request.CallId} not found"));
        }

        // Use a Channel as a thread-safe bridge between the event callbacks
        // and the gRPC response stream writer.
        var channel = Channel.CreateUnbounded<UnmixedAudioSegment>(
            new UnboundedChannelOptions { SingleReader = true });

        void OnSegment(UnmixedAudioSegment segment)
        {
            channel.Writer.TryWrite(segment);
        }

        session.AudioSubscribers.Add(OnSegment);

        try
        {
            await foreach (var segment in channel.Reader.ReadAllAsync(context.CancellationToken))
            {
                await responseStream.WriteAsync(segment);
            }
        }
        catch (OperationCanceledException)
        {
            // Client disconnected or call ended.
            _logger.LogDebug("Audio subscription cancelled for call {CallId}", request.CallId);
        }
        finally
        {
            channel.Writer.TryComplete();
        }
    }

    /// <summary>
    /// Client-streaming RPC: receives TTS PCM audio chunks from the TS agent
    /// and forwards them to AudioPlayback for injection into the call.
    /// </summary>
    public override async Task<PlayAudioResponse> PlayAudio(
        IAsyncStreamReader<AudioChunk> requestStream,
        ServerCallContext context)
    {
        string? callId = null;

        try
        {
            // Accumulate all chunks into a single buffer for playback.
            // The AudioPlayback handles frame splitting internally.
            using var pcmStream = new MemoryStream();

            await foreach (var chunk in requestStream.ReadAllAsync(context.CancellationToken))
            {
                callId ??= chunk.CallId;
                pcmStream.Write(chunk.PcmData.Span);
            }

            if (callId == null)
            {
                return new PlayAudioResponse
                {
                    Success = false,
                    Error = "No audio chunks received.",
                };
            }

            var session = _callHandler.GetCall(callId);
            if (session?.Playback == null)
            {
                return new PlayAudioResponse
                {
                    Success = false,
                    Error = $"Call {callId} not found or playback unavailable.",
                };
            }

            _logger.LogInformation(
                "gRPC PlayAudio: callId={CallId}, totalBytes={Bytes}",
                callId, pcmStream.Length);

            await session.Playback.PlayAsync(pcmStream.ToArray(), callId);

            return new PlayAudioResponse { Success = true };
        }
        catch (OperationCanceledException)
        {
            return new PlayAudioResponse
            {
                Success = false,
                Error = "Playback cancelled.",
            };
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "PlayAudio failed for call {CallId}", callId);
            return new PlayAudioResponse
            {
                Success = false,
                Error = ex.Message,
            };
        }
    }

    /// <summary>
    /// Immediately stops any active TTS playback for a call (barge-in support).
    /// </summary>
    public override Task<StopPlaybackResponse> StopPlayback(
        StopPlaybackRequest request, ServerCallContext context)
    {
        _logger.LogInformation("gRPC StopPlayback: callId={CallId}", request.CallId);

        var session = _callHandler.GetCall(request.CallId);
        if (session?.Playback == null)
        {
            return Task.FromResult(new StopPlaybackResponse { Success = false });
        }

        session.Playback.StopPlayback();
        return Task.FromResult(new StopPlaybackResponse { Success = true });
    }

    /// <summary>
    /// Server-streaming RPC: subscribes to call events (state changes,
    /// participant events, compliance status, QoE metrics, errors).
    /// </summary>
    public override async Task SubscribeEvents(
        SubscribeEventsRequest request,
        IServerStreamWriter<CallEvent> responseStream,
        ServerCallContext context)
    {
        _logger.LogInformation("gRPC SubscribeEvents: callId={CallId}", request.CallId);

        var session = _callHandler.GetCall(request.CallId);
        if (session == null)
        {
            throw new RpcException(new Status(StatusCode.NotFound, $"Call {request.CallId} not found"));
        }

        var channel = Channel.CreateUnbounded<CallEvent>(
            new UnboundedChannelOptions { SingleReader = true });

        void OnEvent(CallEvent evt)
        {
            channel.Writer.TryWrite(evt);
        }

        session.EventSubscribers.Add(OnEvent);

        try
        {
            await foreach (var evt in channel.Reader.ReadAllAsync(context.CancellationToken))
            {
                await responseStream.WriteAsync(evt);
            }
        }
        catch (OperationCanceledException)
        {
            _logger.LogDebug("Event subscription cancelled for call {CallId}", request.CallId);
        }
        finally
        {
            channel.Writer.TryComplete();
        }
    }

    /// <summary>
    /// Returns worker health status and capacity information.
    /// </summary>
    public override Task<HealthCheckResponse> HealthCheck(
        HealthCheckRequest request, ServerCallContext context)
    {
        var response = new HealthCheckResponse
        {
            Healthy = _registry.IsHealthy,
            Capacity = _registry.GetCapacity(),
        };

        return Task.FromResult(response);
    }

    /// <summary>
    /// Returns status of all active calls on this worker.
    /// </summary>
    public override Task<StatusResponse> GetStatus(
        StatusRequest request, ServerCallContext context)
    {
        var response = new StatusResponse
        {
            Capacity = _registry.GetCapacity(),
        };

        foreach (var session in _callHandler.GetActiveCalls())
        {
            response.Calls.Add(new CallStatusEntry
            {
                CallId = session.CallId,
                GraphCallId = session.GraphCallId ?? "",
                State = session.State,
                ComplianceState = session.Compliance?.State ?? "unknown",
                ParticipantCount = (uint)session.Participants.Count,
            });
        }

        return Task.FromResult(response);
    }
}
