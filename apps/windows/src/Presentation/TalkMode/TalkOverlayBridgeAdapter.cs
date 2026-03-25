using Microsoft.UI.Dispatching;
using OpenClawWindows.Application.TalkMode;
using OpenClawWindows.Domain.TalkMode;
using OpenClawWindows.Presentation.ViewModels;
using OpenClawWindows.Presentation.Windows;

namespace OpenClawWindows.Presentation.TalkMode;

/// <summary>
/// Manages TalkOverlayWindow lifecycle and forwards phase/level/paused updates to the active ViewModel.
/// </summary>
internal sealed class TalkOverlayBridgeAdapter : ITalkOverlayBridge
{
    private readonly IServiceProvider _services;
    private readonly DispatcherQueue _queue;

    private TalkOverlayWindow? _window;
    private TalkOverlayViewModel? _vm;

    public TalkOverlayBridgeAdapter(IServiceProvider services, DispatcherQueue queue)
    {
        _services = services;
        _queue = queue;
    }

    public void Present()
    {
        _queue.TryEnqueue(() =>
        {
            if (_window != null) return;
            _vm = _services.GetRequiredService<TalkOverlayViewModel>();
            _window = new TalkOverlayWindow(_vm);
            _window.Activate();
            _window.Closed += (_, _) => { _window = null; _vm = null; };
        });
    }

    public void Dismiss()
    {
        _queue.TryEnqueue(() =>
        {
            _window?.Close();
            _window = null;
            _vm = null;
        });
    }

    public void UpdatePhase(TalkModePhase phase) =>
        _queue.TryEnqueue(() => _vm?.UpdatePhase(phase));

    public void UpdateLevel(double level) =>
        _queue.TryEnqueue(() => _vm?.UpdateLevel(level));

    public void UpdatePaused(bool paused) =>
        _queue.TryEnqueue(() => _vm?.UpdatePaused(paused));
}
