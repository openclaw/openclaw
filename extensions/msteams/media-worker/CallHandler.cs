using System.Collections.Concurrent;
using Microsoft.Graph;
using Microsoft.Graph.Communications.Calls;
using Microsoft.Graph.Communications.Calls.Media;
using Microsoft.Graph.Communications.Client;
using Microsoft.Graph.Communications.Resources;
using Microsoft.Skype.Bots.Media;

namespace OpenClaw.MsTeams.Voice;

/// <summary>
/// Manages the full call lifecycle: joining meetings, tracking state, handling
/// Graph notification callbacks, and wiring unmixed audio capture.
/// </summary>
public sealed class CallHandler
{
    private readonly ICommunicationsClient _commsClient;
    private readonly WorkerRegistry _registry;
    private readonly ILogger<CallHandler> _logger;
    private readonly ConcurrentDictionary<string, CallSession> _activeCalls = new();

    public CallHandler(
        ICommunicationsClient commsClient,
        WorkerRegistry registry,
        ILoggerFactory loggerFactory)
    {
        _commsClient = commsClient;
        _registry = registry;
        _logger = loggerFactory.CreateLogger<CallHandler>();
    }

    /// <summary>
    /// Represents an active call with all associated state and capture machinery.
    /// </summary>
    public sealed class CallSession
    {
        /// <summary>Internal call ID assigned by the TS manager.</summary>
        public string CallId { get; }

        /// <summary>Graph API call resource ID.</summary>
        public string? GraphCallId { get; set; }

        /// <summary>Current call state.</summary>
        public string State { get; set; } = "establishing";

        /// <summary>Active participants keyed by AAD object ID.</summary>
        public ConcurrentDictionary<string, ParticipantInfo> Participants { get; } = new();

        /// <summary>Per-speaker unmixed audio capture handler.</summary>
        public UnmixedAudioCapture? AudioCapture { get; set; }

        /// <summary>Recording compliance gate.</summary>
        public ComplianceGate? Compliance { get; set; }

        /// <summary>TTS audio playback handler.</summary>
        public AudioPlayback? Playback { get; set; }

        /// <summary>QoE monitor instance.</summary>
        public QoEMonitor? QoEMonitor { get; set; }

        /// <summary>Reference to the Graph call resource.</summary>
        public ICall? GraphCall { get; set; }

        /// <summary>Event subscribers for streaming call events to gRPC clients.</summary>
        public ConcurrentBag<Action<CallEvent>> EventSubscribers { get; } = new();

        /// <summary>Audio subscribers for streaming unmixed audio segments.</summary>
        public ConcurrentBag<Action<UnmixedAudioSegment>> AudioSubscribers { get; } = new();

        /// <summary>Cancellation source for the call lifetime.</summary>
        public CancellationTokenSource Cts { get; } = new();

        /// <summary>Whether unmixed audio was requested.</summary>
        public bool ReceiveUnmixed { get; set; } = true;

        public CallSession(string callId)
        {
            CallId = callId;
        }
    }

    /// <summary>
    /// Tracks participant information.
    /// </summary>
    public sealed class ParticipantInfo
    {
        public string AadUserId { get; set; } = "";
        public string DisplayName { get; set; } = "";
    }

    /// <summary>
    /// Joins a Teams meeting by creating a call via the stateful Graph Communications SDK
    /// with app-hosted media configuration and unmixed audio support.
    /// </summary>
    public async Task<JoinMeetingResponse> JoinMeeting(JoinMeetingRequest request, ILoggerFactory loggerFactory)
    {
        if (_activeCalls.ContainsKey(request.CallId))
        {
            return new JoinMeetingResponse
            {
                Success = false,
                Error = $"Call {request.CallId} already exists.",
            };
        }

        if (!_registry.CanAcceptCall())
        {
            return new JoinMeetingResponse
            {
                Success = false,
                Error = "Worker at maximum capacity.",
            };
        }

        var session = new CallSession(request.CallId)
        {
            ReceiveUnmixed = request.ReceiveUnmixed || true,
        };

        try
        {
            // Build the media configuration for app-hosted media with unmixed audio.
            var audioSocketSettings = new AudioSocketSettings
            {
                StreamDirections = StreamDirection.Recvonly,
                SupportedAudioFormat = AudioFormat.Pcm16K,
                ReceiveUnmixedMeetingAudio = true,
            };

            var audioSocket = new AudioSocket(audioSocketSettings);

            // Wire unmixed audio capture.
            var audioCapture = new UnmixedAudioCapture(
                request.CallId,
                loggerFactory.CreateLogger<UnmixedAudioCapture>());
            session.AudioCapture = audioCapture;

            audioSocket.AudioMediaReceived += (sender, args) =>
            {
                audioCapture.OnAudioReceived(args);
            };

            // Wire audio playback.
            var playback = new AudioPlayback(
                audioSocket,
                loggerFactory.CreateLogger<AudioPlayback>());
            session.Playback = playback;

            // Wire QoE monitoring.
            var qoeMonitor = new QoEMonitor(
                request.CallId,
                loggerFactory.CreateLogger<QoEMonitor>());
            session.QoEMonitor = qoeMonitor;
            qoeMonitor.AttachToSocket(audioSocket);

            // When QoE detects a fatal failure, attempt rejoin.
            qoeMonitor.OnMediaFailure += async (_, _) =>
            {
                _logger.LogWarning("Media stream failure on call {CallId}, attempting rejoin", request.CallId);
                await AttemptRejoin(request, loggerFactory);
            };

            // Forward QoE events to subscribers.
            qoeMonitor.OnQoEEvent += (_, evt) =>
            {
                var callEvent = new CallEvent
                {
                    CallId = request.CallId,
                    Qoe = evt,
                };
                EmitEvent(session, callEvent);
            };

            var mediaSession = _commsClient.CreateMediaSession(
                audioSocket,
                videoSocketSettings: null,
                vbssSocketSettings: null,
                mediaSessionId: Guid.NewGuid());

            // Parse the join URL to extract the meeting info.
            var joinParams = new JoinMeetingParameters
            {
                ChatInfo = new ChatInfo
                {
                    ThreadId = ExtractThreadId(request.JoinUrl),
                    MessageId = "0",
                },
                MeetingInfo = new OrganizerMeetingInfo
                {
                    Organizer = new IdentitySet
                    {
                        User = new Identity
                        {
                            Id = request.TenantId,
                        },
                    },
                },
                TenantId = request.TenantId,
                MediaSession = mediaSession,
            };

            var call = await _commsClient.Calls().AddAsync(joinParams, session.Cts.Token);

            session.GraphCallId = call.Id;
            session.GraphCall = call;

            // Set up compliance gate.
            var compliance = new ComplianceGate(
                request.CallId,
                loggerFactory.CreateLogger<ComplianceGate>());
            session.Compliance = compliance;

            // Wire compliance events to subscribers.
            compliance.OnComplianceChanged += (_, evt) =>
            {
                var callEvent = new CallEvent
                {
                    CallId = request.CallId,
                    Compliance = evt,
                };
                EmitEvent(session, callEvent);
            };

            // Forward audio segments to subscribers only when compliance is active.
            audioCapture.OnSegmentReady += (_, segment) =>
            {
                if (session.Compliance?.IsActive != true)
                {
                    return;
                }

                // Resolve speaker identity from participants.
                var speakerInfo = ResolveSpeaker(session, segment.SpeakerId);
                var enrichedSegment = new UnmixedAudioSegment
                {
                    CallId = segment.CallId,
                    SpeakerId = segment.SpeakerId,
                    AadUserId = speakerInfo.AadUserId,
                    DisplayName = speakerInfo.DisplayName,
                    DurationMs = segment.DurationMs,
                    PcmData = segment.PcmData,
                    IsFinal = segment.IsFinal,
                };

                foreach (var subscriber in session.AudioSubscribers)
                {
                    subscriber(enrichedSegment);
                }
            };

            // Wire call state change handler.
            call.OnUpdated += (sender, args) =>
            {
                HandleCallUpdated(session, args);
            };

            // Wire participant events.
            call.Participants.OnUpdated += (sender, args) =>
            {
                HandleParticipantsUpdated(session, args);
            };

            _activeCalls[request.CallId] = session;
            _registry.IncrementCalls();

            _logger.LogInformation(
                "Joined meeting for call {CallId}, Graph call ID: {GraphCallId}",
                request.CallId, call.Id);

            return new JoinMeetingResponse
            {
                GraphCallId = call.Id,
                Success = true,
            };
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to join meeting for call {CallId}", request.CallId);
            session.Cts.Cancel();
            session.Cts.Dispose();
            return new JoinMeetingResponse
            {
                Success = false,
                Error = ex.Message,
            };
        }
    }

    /// <summary>
    /// Leaves a call, tearing down media and cleaning up state.
    /// </summary>
    public async Task<LeaveCallResponse> LeaveCall(string callId)
    {
        if (!_activeCalls.TryRemove(callId, out var session))
        {
            return new LeaveCallResponse
            {
                Success = false,
                Error = $"Call {callId} not found.",
            };
        }

        try
        {
            session.Cts.Cancel();

            if (session.GraphCall != null)
            {
                await session.GraphCall.DeleteAsync();
            }

            session.AudioCapture?.Dispose();
            session.Playback?.Dispose();
            session.Cts.Dispose();
            _registry.DecrementCalls();

            _logger.LogInformation("Left call {CallId}", callId);

            return new LeaveCallResponse { Success = true };
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error leaving call {CallId}", callId);
            _registry.DecrementCalls();
            return new LeaveCallResponse
            {
                Success = false,
                Error = ex.Message,
            };
        }
    }

    /// <summary>
    /// Returns all currently active calls.
    /// </summary>
    public IReadOnlyCollection<CallSession> GetActiveCalls()
    {
        return _activeCalls.Values.ToList().AsReadOnly();
    }

    /// <summary>
    /// Retrieves a specific call session by ID.
    /// </summary>
    public CallSession? GetCall(string callId)
    {
        _activeCalls.TryGetValue(callId, out var session);
        return session;
    }

    /// <summary>
    /// Handles Graph call state transitions (establishing, established, terminated).
    /// When the call reaches Established, triggers compliance recording.
    /// </summary>
    private void HandleCallUpdated(CallSession session, ResourceEventArgs<ICall> args)
    {
        var call = args.NewResource;
        var state = call.Resource?.State?.ToString()?.ToLowerInvariant() ?? "unknown";
        var previousState = session.State;
        session.State = state;

        _logger.LogInformation(
            "Call {CallId} state: {Previous} -> {Current}",
            session.CallId, previousState, state);

        var stateEvent = new CallEvent
        {
            CallId = session.CallId,
            State = new StateEvent
            {
                State = state,
                Reason = call.Resource?.ResultInfo?.Message ?? "",
            },
        };
        EmitEvent(session, stateEvent);

        // When call reaches established, trigger compliance recording.
        if (state == "established" && previousState != "established")
        {
            _ = Task.Run(async () =>
            {
                try
                {
                    await session.Compliance!.InitiateRecordingCompliance(session.GraphCall!);
                }
                catch (Exception ex)
                {
                    _logger.LogError(ex, "Failed to initiate compliance for call {CallId}", session.CallId);
                }
            });
        }

        // On termination, clean up.
        if (state == "terminated")
        {
            _ = Task.Run(async () =>
            {
                await LeaveCall(session.CallId);
            });
        }
    }

    /// <summary>
    /// Handles participant join/leave/mute/unmute events.
    /// </summary>
    private void HandleParticipantsUpdated(CallSession session, CollectionEventArgs<IParticipant> args)
    {
        foreach (var participant in args.AddedResources)
        {
            var info = participant.Resource;
            var identity = info?.Info?.Identity?.User;
            if (identity == null) continue;

            var aadId = identity.Id ?? "";
            var displayName = identity.DisplayName ?? "";

            session.Participants[aadId] = new ParticipantInfo
            {
                AadUserId = aadId,
                DisplayName = displayName,
            };

            EmitEvent(session, new CallEvent
            {
                CallId = session.CallId,
                Participant = new ParticipantEvent
                {
                    Action = "joined",
                    AadUserId = aadId,
                    DisplayName = displayName,
                },
            });

            _logger.LogInformation("Participant joined call {CallId}: {Name} ({AadId})",
                session.CallId, displayName, aadId);
        }

        foreach (var participant in args.RemovedResources)
        {
            var identity = participant.Resource?.Info?.Identity?.User;
            if (identity == null) continue;

            var aadId = identity.Id ?? "";
            session.Participants.TryRemove(aadId, out var removed);

            EmitEvent(session, new CallEvent
            {
                CallId = session.CallId,
                Participant = new ParticipantEvent
                {
                    Action = "left",
                    AadUserId = aadId,
                    DisplayName = removed?.DisplayName ?? "",
                },
            });
        }

        foreach (var participant in args.UpdatedResources)
        {
            var info = participant.Resource;
            var identity = info?.Info?.Identity?.User;
            if (identity == null) continue;

            var aadId = identity.Id ?? "";
            var isMuted = info?.IsMuted == true;

            EmitEvent(session, new CallEvent
            {
                CallId = session.CallId,
                Participant = new ParticipantEvent
                {
                    Action = isMuted ? "muted" : "unmuted",
                    AadUserId = aadId,
                    DisplayName = identity.DisplayName ?? "",
                },
            });
        }
    }

    /// <summary>
    /// Resolves a speaker ID to participant identity info.
    /// </summary>
    private static ParticipantInfo ResolveSpeaker(CallSession session, uint speakerId)
    {
        // The Graph SDK maps speaker IDs to participant MediaStreams.
        // For a direct lookup, iterate participants to find a matching media stream ID.
        // Fall back to unknown if not resolvable.
        foreach (var kvp in session.Participants)
        {
            // Speaker IDs are assigned by the media platform and may correspond
            // to participant order. A production implementation would maintain
            // a mapping from IAudioSocket speaker events.
            // Here we return the best-effort match.
        }

        return new ParticipantInfo
        {
            AadUserId = speakerId.ToString(),
            DisplayName = $"Speaker-{speakerId}",
        };
    }

    /// <summary>
    /// Attempts to rejoin a call after a media failure.
    /// </summary>
    private async Task AttemptRejoin(JoinMeetingRequest request, ILoggerFactory loggerFactory)
    {
        _logger.LogInformation("Attempting rejoin for call {CallId}", request.CallId);

        // Remove old session.
        if (_activeCalls.TryRemove(request.CallId, out var oldSession))
        {
            oldSession.Cts.Cancel();
            oldSession.AudioCapture?.Dispose();
            oldSession.Playback?.Dispose();
            oldSession.Cts.Dispose();
            _registry.DecrementCalls();
        }

        EmitEvent(oldSession, new CallEvent
        {
            CallId = request.CallId,
            Error = new ErrorEvent
            {
                Message = "Media stream failure, attempting automatic rejoin.",
                Recoverable = true,
            },
        });

        // Wait briefly before rejoin to avoid tight loops.
        await Task.Delay(2000);

        var response = await JoinMeeting(request, loggerFactory);
        if (!response.Success)
        {
            _logger.LogError("Rejoin failed for call {CallId}: {Error}", request.CallId, response.Error);
        }
    }

    /// <summary>
    /// Extracts the thread ID from a Teams meeting join URL.
    /// </summary>
    private static string ExtractThreadId(string joinUrl)
    {
        // Teams join URLs contain the thread ID as a path segment:
        // https://teams.microsoft.com/l/meetup-join/19%3ameeting_XXXX%40thread.v2/...
        var uri = new Uri(joinUrl);
        var segments = uri.AbsolutePath.Split('/');
        foreach (var segment in segments)
        {
            var decoded = Uri.UnescapeDataString(segment);
            if (decoded.Contains("@thread.v2") || decoded.Contains("@thread.tacv2"))
            {
                return decoded;
            }
        }

        // Fallback: return the raw join URL for the SDK to parse.
        return joinUrl;
    }

    /// <summary>
    /// Emits a call event to all registered subscribers.
    /// </summary>
    private static void EmitEvent(CallSession? session, CallEvent evt)
    {
        if (session == null) return;
        foreach (var subscriber in session.EventSubscribers)
        {
            try
            {
                subscriber(evt);
            }
            catch
            {
                // Subscriber failures must not crash the event loop.
            }
        }
    }
}
