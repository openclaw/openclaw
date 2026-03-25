using MediatR;
using OpenClawWindows.Domain.Gateway;

namespace OpenClawWindows.Domain.Events;

// Published by UpdateTrayMenuStateHandler (UC-036) whenever gateway state changes.
// TrayIconPresenter subscribes to update icon + tooltip without polling.
public sealed record TrayMenuStateChangedEvent(
    GatewayState State,
    string? ActiveSessionLabel) : INotification;
