using OpenClawWindows.Application.Stores;
using OpenClawWindows.Domain.SystemTray;

namespace OpenClawWindows.Infrastructure.Stores;

internal sealed class InMemoryTrayMenuStateStore : ITrayMenuStateStore
{
    private TrayMenuState? _current;

    public TrayMenuState? Current => Volatile.Read(ref _current);

    public void Update(TrayMenuState state) =>
        Interlocked.Exchange(ref _current, state);
}
