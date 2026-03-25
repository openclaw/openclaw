using OpenClawWindows.Domain.TalkMode;

namespace OpenClawWindows.Application.TalkMode;

// Port interface; Presentation implements it.
internal interface ITalkOverlayBridge
{
    void Present();
    void Dismiss();
    void UpdatePhase(TalkModePhase phase);
    void UpdateLevel(double level);
    void UpdatePaused(bool paused);
}
