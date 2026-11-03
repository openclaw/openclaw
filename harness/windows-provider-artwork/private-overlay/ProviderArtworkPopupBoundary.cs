using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;

namespace OpenClaw.Tray.UITests;

// Task-only observation of the existing owner boundary, never another capture backend.
internal static class ProviderArtworkPopupBoundary
{
    private sealed record Context(Window Window, ComboBox Picker, string Arm, string Path, List<object> Events);
    private static Context? _current;
    internal static bool IsActive => _current is not null;
    internal static void Begin(Window window, ComboBox picker, string arm)
    {
        Assert.Null(_current);
        Assert.Contains(arm, new[] { "same-position-move", "conditional-move" });
        Assert.Equal("popup-boundary-light-v1", Environment.GetEnvironmentVariable("OPENCLAW_PROVIDER_ARTWORK_POPUP_DIAGNOSTIC"));
        OnboardingNativeProof.AssertSourceUnchanged();
        var path = Path.Combine(OnboardingNativeProof.RequireProofDirectory(), "popup-" + arm + "-Light.boundary.json");
        Assert.False(File.Exists(path));
        _current = new(window, picker, arm, path, []);
        Observe(window, "before-open");
    }
    internal static void Observe(Window window, string phase)
    {
        var context = _current;
        if (context is null) return;
        Assert.Same(context.Window, window);
        var hwnd = WinRT.Interop.WindowNative.GetWindowHandle(window);
        var thread = GetWindowThreadProcessId(hwnd, out var pid);
        Assert.Equal((uint)Environment.ProcessId, pid);
        Assert.Equal(GetCurrentThreadId(), thread);
        var desktop = Desktop(thread);
        Assert.False(string.Equals("Default", desktop, StringComparison.OrdinalIgnoreCase));
        var root = Assert.IsAssignableFrom<FrameworkElement>(window.Content);
        var xamlRoot = Assert.IsType<XamlRoot>(root.XamlRoot);
        var origin = new Point();
        Assert.True(ClientToScreen(hwnd, ref origin));
        var inset = NativeProofLayout.ContentTopInset(window.ExtendsContentIntoTitleBar, IsZoomed(hwnd));
        object Element(FrameworkElement element)
        {
            object? screen = null;
            string? boundsError = null;
            try
            {
                var bounds = element.TransformToVisual(root).TransformBounds(new Windows.Foundation.Rect(0, 0, element.ActualWidth, element.ActualHeight));
                screen = new { left = origin.X + bounds.X * xamlRoot.RasterizationScale,
                    top = origin.Y + inset + bounds.Y * xamlRoot.RasterizationScale,
                    width = bounds.Width * xamlRoot.RasterizationScale, height = bounds.Height * xamlRoot.RasterizationScale };
            }
            catch (InvalidOperationException error) { boundsError = error.GetType().Name; }
            return new { element.IsLoaded, visibility = element.Visibility.ToString(), element.ActualWidth, element.ActualHeight,
                element.IsHitTestVisible, screen, boundsError };
        }
        var rows = Enumerable.Range(0, 4).Select(index =>
        {
            var row = context.Picker.ContainerFromIndex(index) as ComboBoxItem;
            return new { index, mounted = row is not null, element = row is null ? null : Element(row),
                labels = row is null ? [] : TestSupport.FindDescendants<TextBlock>(row).Select(text => text.Text).ToArray() };
        }).ToArray();
        var popups = VisualTreeHelper.GetOpenPopupsForXamlRoot(xamlRoot).Select(popup => new
        {
            popup.IsOpen, childType = popup.Child?.GetType().FullName,
            child = popup.Child is FrameworkElement element ? Element(element) : null,
        }).ToArray();
        var windows = new List<object>();
        var identities = new List<IntPtr>();
        bool Collect(IntPtr candidate, IntPtr unused) { identities.Add(candidate); return true; }
        // Enumerate identities on this private desktop, retain only this PID. No other HWND is captured.
        Assert.True(EnumDesktopWindows(GetThreadDesktop(thread), Collect, IntPtr.Zero));
        foreach (var candidate in identities)
        {
            var candidateThread = GetWindowThreadProcessId(candidate, out var candidatePid);
            if (candidatePid != pid) continue;
            Assert.Equal(desktop, Desktop(candidateThread));
            var hasBounds = GetWindowRect(candidate, out var bounds);
            var name = new StringBuilder(256);
            _ = GetClassNameW(candidate, name, name.Capacity);
            var owners = new List<object>();
            var seen = new HashSet<IntPtr>();
            var owner = GetWindow(candidate, 4);
            while (owner != IntPtr.Zero && seen.Add(owner))
            {
                var ownerThread = GetWindowThreadProcessId(owner, out var ownerPid);
                owners.Add(new { hwnd = owner.ToInt64(), pid = ownerPid, thread = ownerThread,
                    desktop = ownerPid == pid ? Desktop(ownerThread) : null });
                if (ownerPid != pid) break;
                owner = GetWindow(owner, 4);
            }
            windows.Add(new { hwnd = candidate.ToInt64(), pid = candidatePid, thread = candidateThread, desktop,
                className = name.ToString(), visible = IsWindowVisible(candidate), hasBounds, bounds, owners });
        }
        Assert.True(GetWindowRect(hwnd, out var sourceBounds));
        context.Events.Add(new { sequence = context.Events.Count, phase, atUtc = DateTimeOffset.UtcNow,
            context.Picker.IsDropDownOpen, sourceHwnd = hwnd.ToInt64(), sourcePid = pid, sourceThread = thread,
            desktop, sourceBounds, popups, rows, ownedDesktopWindows = windows });
        Save(context, "observing");
    }
    internal static bool ShouldMove(Window window)
    {
        var context = Assert.IsType<Context>(_current);
        Assert.Same(context.Window, window);
        var work = Microsoft.UI.Windowing.DisplayArea.GetFromWindowId(window.AppWindow.Id,
            Microsoft.UI.Windowing.DisplayAreaFallback.Nearest).WorkArea;
        var position = window.AppWindow.Position;
        // Both controlled arms must start at the same, already-admitted work-area position.
        Assert.Equal(work.X, position.X);
        Assert.Equal(work.Y, position.Y);
        return context.Arm == "same-position-move" || position.X != work.X || position.Y != work.Y;
    }
    internal static void End(Window window)
    {
        try
        {
            Observe(window, "test-finally-before-close");
            if (_current is { } context) Save(context, "observed-not-qualified");
        }
        finally { _current = null; }
    }
    private static void Save(Context context, string state)
    {
        File.WriteAllText(context.Path, JsonSerializer.Serialize(new
        {
            schema = "provider-popup-boundary-observation-v1", state, context.Arm,
            qualification = "Light-only controlled observation. No provider-icon or popup-composition qualification.",
            head = Environment.GetEnvironmentVariable("OPENCLAW_MOUNTED_CONTROL_CAPTURE_HEAD"),
            freezeManifestSha256 = Environment.GetEnvironmentVariable("OPENCLAW_UI_PROOF_MANIFEST_SHA256"),
            assemblySha256 = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(typeof(ProviderArtworkPopupBoundary).Assembly.Location))),
            events = context.Events,
        }, new JsonSerializerOptions { WriteIndented = true, IncludeFields = true }));
    }
    private static string Desktop(uint thread)
    {
        var handle = GetThreadDesktop(thread);
        Assert.NotEqual(IntPtr.Zero, handle);
        var name = new StringBuilder(256);
        Assert.True(GetUserObjectInformationW(handle, 2, name, 512, out _));
        return name.ToString();
    }
    [StructLayout(LayoutKind.Sequential)] private struct Point { public int X, Y; }
    [StructLayout(LayoutKind.Sequential)] private struct Bounds { public int Left, Top, Right, Bottom; }
    private delegate bool EnumThreadWindow(IntPtr window, IntPtr parameter);
    [DllImport("user32.dll")] private static extern bool EnumDesktopWindows(IntPtr desktop, EnumThreadWindow callback, IntPtr parameter);
    [DllImport("user32.dll")] private static extern IntPtr GetWindow(IntPtr window, uint command);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetClassNameW(IntPtr window, StringBuilder name, int length);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
    [DllImport("kernel32.dll")] private static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] private static extern IntPtr GetThreadDesktop(uint thread);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern bool GetUserObjectInformationW(IntPtr handle, int index, StringBuilder value, uint length, out uint needed);
    [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr window, out Bounds bounds);
    [DllImport("user32.dll")] private static extern bool ClientToScreen(IntPtr window, ref Point point);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] private static extern bool IsZoomed(IntPtr window);
}
