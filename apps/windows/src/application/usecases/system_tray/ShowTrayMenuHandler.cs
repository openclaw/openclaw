using OpenClawWindows.Application.Behaviors;
using OpenClawWindows.Domain.SystemTray;

namespace OpenClawWindows.Application.SystemTray;

[UseCase("UC-035")]
public sealed record ShowTrayMenuCommand : IRequest<ErrorOr<TrayMenuState>>;

internal sealed class ShowTrayMenuHandler : IRequestHandler<ShowTrayMenuCommand, ErrorOr<TrayMenuState>>
{
    private readonly ITrayMenuStateStore _stateStore;

    public ShowTrayMenuHandler(ITrayMenuStateStore stateStore)
    {
        _stateStore = stateStore;
    }

    public Task<ErrorOr<TrayMenuState>> Handle(ShowTrayMenuCommand cmd, CancellationToken ct)
    {
        var state = _stateStore.Current ?? TrayMenuState.Disconnected();
        return Task.FromResult(ErrorOrFactory.From(state));
    }
}
