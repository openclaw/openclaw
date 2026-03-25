namespace OpenClawWindows.Application.VoiceWake;

// Presentation bridge decouples VoiceSessionCoordinator from the concrete overlay window
// (VoiceOverlaySessionController, N4-04). Infra/Presentation implement; Application drives.

internal enum VoiceSessionSource { WakeWord, PushToTalk }

internal enum VoiceDismissReason { Explicit, Empty }

internal enum VoiceSendOutcome { Sent, Empty }

internal interface IVoiceOverlayBridge
{
    bool IsVisible { get; }
    void StartSession(Guid token, VoiceSessionSource source, string transcript, bool forwardEnabled, bool isFinal);
    void UpdatePartial(Guid token, string transcript);
    void PresentFinal(Guid token, string transcript, double? autoSendAfter, Domain.VoiceWake.VoiceWakeChime sendChime);
    void BeginSendUI(Guid token, Domain.VoiceWake.VoiceWakeChime sendChime);
    void Dismiss(Guid token, VoiceDismissReason reason, VoiceSendOutcome outcome);
    void UpdateLevel(Guid token, double level);
}

// Separate from IVoiceOverlayBridge to break the circular dependency: coordinator → bridge, bridge → notifier.
internal interface IVoiceSessionNotifier
{
    void OverlayDidDismiss(Guid? token);
    void SendNow(Guid token, string reason = "explicit");
}
