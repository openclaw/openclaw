namespace OpenClawWindows.Application.Ports;

/// <summary>
/// Modal confirmation and alert dialogs for deep-link security prompts.
/// </summary>
public interface IDeepLinkConfirmation
{
    Task<bool> ConfirmAsync(string title, string message);
    Task AlertAsync(string title, string message);
}
