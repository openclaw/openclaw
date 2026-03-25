using System.Runtime.InteropServices;
using OpenClawWindows.Application.Ports;

namespace OpenClawWindows.Presentation.DeepLinks;

// Native Win32 modal dialogs — no XamlRoot needed, runs on any thread.
internal sealed class Win32DeepLinkConfirmation : IDeepLinkConfirmation
{
    private const uint MB_OK            = 0x00000000;
    private const uint MB_YESNO         = 0x00000004;
    private const uint MB_ICONWARNING   = 0x00000030;
    private const uint MB_ICONINFO      = 0x00000040;
    private const int  IDYES            = 6;

    public Task<bool> ConfirmAsync(string title, string message)
    {
        var result = MessageBox(IntPtr.Zero, message, title, MB_YESNO | MB_ICONWARNING);
        return Task.FromResult(result == IDYES);
    }

    public Task AlertAsync(string title, string message)
    {
        MessageBox(IntPtr.Zero, message, title, MB_OK | MB_ICONINFO);
        return Task.CompletedTask;
    }

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = false)]
    private static extern int MessageBox(IntPtr hWnd, string lpText, string lpCaption, uint uType);
}
