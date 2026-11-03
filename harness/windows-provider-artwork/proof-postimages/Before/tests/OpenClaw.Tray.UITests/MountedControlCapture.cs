using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Controls.Primitives;
using Microsoft.UI.Xaml.Media;
using OpenClaw.TestSupport;

namespace OpenClaw.Tray.UITests;

internal static class MountedControlCapture
{
    private const string PopupClass = "Microsoft.UI.Content.PopupWindowSiteBridge";

    internal static async Task OptionalAsync(Window window, string state)
    {
        var directory = CaptureDirectory();
        if (directory is null) return;
        var handle = ParentHandle(window);
        var work = WorkArea(window);
        // Mounted fixtures normally live offscreen. Requested capture stays on the private desktop.
        window.AppWindow.Move(new Windows.Graphics.PointInt32(work.X, work.Y));
        await CaptureAsync(window, handle, state, directory, () =>
        {
            Assert.Equal(handle, ParentHandle(window));
        });
    }

    internal static async Task OptionalPopupAsync(Window window, ComboBox picker, string state)
    {
        var directory = CaptureDirectory();
        if (directory is null) return;
        var admitted = AdmitPopup(window, picker);
        // A ComboBox popup is a separate owned HWND. Never move/reopen it or composite it into its parent.
        await CaptureAsync(window, admitted.Handle, state, directory, () =>
        {
            var current = AdmitPopup(window, picker);
            Assert.Same(admitted.Popup, current.Popup);
            Assert.Same(admitted.Root, current.Root);
            Assert.Same(admitted.XamlRoot, current.XamlRoot);
            Assert.Equal(admitted.ProcessId, current.ProcessId);
            Assert.Equal(admitted.ThreadId, current.ThreadId);
            Assert.Equal(admitted.Desktop, current.Desktop);
            Assert.Equal(admitted.Parent, current.Parent);
            Assert.Equal(admitted.Handle, current.Handle);
            Assert.Equal(admitted.ParentBounds, current.ParentBounds);
            Assert.Equal(admitted.Bounds, current.Bounds);
            Assert.Equal(admitted.Rows, current.Rows);
            Assert.Equal(admitted.OwnerChain, current.OwnerChain);
        }, admitted);
    }

    private static string? CaptureDirectory()
    {
        var directory = Environment.GetEnvironmentVariable("OPENCLAW_MOUNTED_CONTROL_CAPTURE_DIR");
        if (string.IsNullOrWhiteSpace(directory)) return null;
        OnboardingNativeProof.AssertIsolatedRoots();
        Assert.NotEqual("Default", Desktop(GetCurrentThreadId()));
        return directory;
    }

    private static IntPtr ParentHandle(Window window)
    {
        var handle = WinRT.Interop.WindowNative.GetWindowHandle(window);
        Assert.NotEqual(IntPtr.Zero, handle);
        _ = GetWindowThreadProcessId(handle, out var owner);
        Assert.Equal((uint)Environment.ProcessId, owner);
        return handle;
    }

    private static Windows.Graphics.RectInt32 WorkArea(Window window) =>
        Microsoft.UI.Windowing.DisplayArea.GetFromWindowId(window.AppWindow.Id,
            Microsoft.UI.Windowing.DisplayAreaFallback.Nearest).WorkArea;

    private static PopupAdmission AdmitPopup(Window window, ComboBox picker)
    {
        var parent = ParentHandle(window);
        var thread = GetWindowThreadProcessId(parent, out var owner);
        Assert.Equal(GetCurrentThreadId(), thread);
        var desktop = Desktop(thread);
        Assert.NotEqual("Default", desktop);
        OnboardingNativeProof.AssertProductDpi(window);
        Assert.True(IsWindowVisible(parent) && !IsIconic(parent));
        Assert.True(GetWindowRect(parent, out var parentBounds));
        var root = Assert.IsAssignableFrom<FrameworkElement>(window.Content);
        Assert.True(root.IsLoaded && picker.IsLoaded && picker.Visibility == Visibility.Visible && picker.IsDropDownOpen,
            "An active owned ComboBox popup is required.");
        Assert.NotNull(root.XamlRoot);
        Assert.Same(root.XamlRoot, picker.XamlRoot);
        Assert.Same(root, root.XamlRoot.Content);
        Assert.True(picker.Items.Count > 0);
        var rows = Enumerable.Range(0, picker.Items.Count).Select(index =>
            Assert.IsType<ComboBoxItem>(picker.ContainerFromIndex(index))).ToArray();
        Assert.All(rows, row => Assert.True(row.IsLoaded && row.Visibility == Visibility.Visible));
        static bool Contains(DependencyObject child, DependencyObject row)
        {
            for (DependencyObject? current = row; current is not null; current = VisualTreeHelper.GetParent(current))
                if (ReferenceEquals(current, child)) return true;
            return false;
        }
        var popup = Assert.Single(VisualTreeHelper.GetOpenPopupsForXamlRoot(root.XamlRoot),
            candidate => candidate.IsOpen && candidate.Child is DependencyObject child && rows.All(row => Contains(child, row)));
        var popupChild = Assert.IsAssignableFrom<FrameworkElement>(popup.Child);
        Assert.True(popupChild.IsLoaded && popupChild.Visibility == Visibility.Visible);
        Assert.Same(root.XamlRoot, popupChild.XamlRoot);
        var origin = new NativePoint();
        Assert.True(ClientToScreen(parent, ref origin));
        var inset = NativeProofLayout.ContentTopInset(window.ExtendsContentIntoTitleBar, IsZoomed(parent));
        var scale = root.XamlRoot.RasterizationScale;
        Assert.True(double.IsFinite(scale) && scale > 0);
        var rowBounds = rows.Select(row =>
        {
            Assert.Same(root.XamlRoot, row.XamlRoot);
            var bounds = row.TransformToVisual(root).TransformBounds(new Windows.Foundation.Rect(0, 0, row.ActualWidth, row.ActualHeight));
            var physical = new RowBounds(origin.X + bounds.Left * scale, origin.Y + inset + bounds.Top * scale,
                bounds.Width * scale, bounds.Height * scale);
            Assert.True(double.IsFinite(physical.Left) && double.IsFinite(physical.Top) &&
                double.IsFinite(physical.Width) && double.IsFinite(physical.Height) && physical.Width > 0 && physical.Height > 0);
            return physical;
        }).ToArray();
        var handles = new List<IntPtr>();
        bool Collect(IntPtr handle, IntPtr unused) { handles.Add(handle); return true; }
        Assert.True(EnumThreadWindows(thread, Collect, IntPtr.Zero));
        var candidates = handles.Where(handle =>
        {
            var candidateThread = GetWindowThreadProcessId(handle, out var candidateOwner);
            if (candidateOwner != owner || candidateThread != thread || !IsWindowVisible(handle)) return false;
            var name = new StringBuilder(256);
            _ = GetClassNameW(handle, name, name.Capacity);
            return name.ToString() == PopupClass;
        }).ToArray();
        var target = Assert.Single(candidates);
        Assert.NotEqual(parent, target);
        Assert.False(IsIconic(target));
        Assert.True(GetWindowRect(target, out var targetBounds));
        var chain = new List<long>();
        var seen = new HashSet<IntPtr>();
        var currentOwner = GetWindow(target, 4);
        while (currentOwner != IntPtr.Zero)
        {
            Assert.True(seen.Add(currentOwner), "Popup owner chain must not cycle.");
            var ownerThread = GetWindowThreadProcessId(currentOwner, out var ownerPid);
            Assert.Equal(owner, ownerPid);
            Assert.Equal(thread, ownerThread);
            Assert.Equal(desktop, Desktop(ownerThread));
            chain.Add(currentOwner.ToInt64());
            if (currentOwner == parent) break;
            currentOwner = GetWindow(currentOwner, 4);
        }
        Assert.Equal(parent.ToInt64(), Assert.Single(chain));
        Assert.InRange(targetBounds.Right - targetBounds.Left, 1, int.MaxValue);
        Assert.InRange(targetBounds.Bottom - targetBounds.Top, 1, int.MaxValue);
        AssertWithinWorkArea(targetBounds, WorkArea(window));
        Assert.All(rowBounds, row => Assert.True(Math.Floor(row.Left) >= targetBounds.Left &&
            Math.Floor(row.Top) >= targetBounds.Top && Math.Ceiling(row.Left + row.Width) <= targetBounds.Right &&
            Math.Ceiling(row.Top + row.Height) <= targetBounds.Bottom, "Every real ComboBox row must fit inside the admitted popup HWND."));
        return new(parent, target, owner, thread, desktop, parentBounds, targetBounds, rowBounds, chain.ToArray(), popup, root, root.XamlRoot);
    }

    private static async Task CaptureAsync(Window window, IntPtr handle, string state, string directory,
        Action validate, PopupAdmission? popup = null)
    {
        var bounds = popup is null ? ReadBounds(handle) : popup.Bounds;
        var work = WorkArea(window);
        var desktop = popup?.Desktop ?? Desktop(GetCurrentThreadId());
        var parent = popup?.Parent ?? ParentHandle(window);
        var owner = popup?.ProcessId ?? (uint)Environment.ProcessId;
        var kind = popup is null ? "parent window" : "ComboBox popup";
        object? popupEvidence = popup is null ? null : new
        {
            parentHwnd = popup.Parent.ToInt64(), hwnd = popup.Handle.ToInt64(), popup.ProcessId, popup.ThreadId,
            popup.Desktop, className = PopupClass, popup.ParentBounds, popup.Bounds, popup.Rows, popup.OwnerChain,
            xamlPopupOpen = popup.Popup.IsOpen,
        };
        var options = new JsonSerializerOptions { WriteIndented = true, IncludeFields = true };
        var status = "admitted-not-rendered";
        bool? printWindowSucceeded = null;
        int? sampledColors = null;
        string? failure = null;
        Directory.CreateDirectory(directory);
        void WriteAttempt() => File.WriteAllText(Path.Combine(directory, state + ".attempt.json"), JsonSerializer.Serialize(new
        {
            state, qualification = "Capture attempt only. Not evidence of rendered content.",
            method = "PrintWindow(PW_RENDERFULLCONTENT); no fallback",
            head = Environment.GetEnvironmentVariable("OPENCLAW_MOUNTED_CONTROL_CAPTURE_HEAD"),
            assemblySha256 = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(typeof(MountedControlCapture).Assembly.Location))),
            desktop, ownerProcessId = owner, hwnd = handle.ToInt64(), parentHwnd = parent.ToInt64(),
            left = bounds.Left, top = bounds.Top, right = bounds.Right, bottom = bounds.Bottom,
            workLeft = work.X, workTop = work.Y, workWidth = work.Width, workHeight = work.Height,
            sampledColors, popup = popupEvidence, captureStatus = status, printWindowSucceeded, failure,
            attemptedUtc = DateTimeOffset.UtcNow,
        }, options));
        // Preserve the admitted target even if native rendering or subsequent stability validation fails.
        WriteAttempt();
        try
        {
            validate();
            await OnboardingNativeProof.NextCompositionAsync();
            Assert.Equal(0, DwmFlush());
            validate();
            Assert.True(IsWindowVisible(handle));
            Assert.False(IsIconic(handle));
            bounds = ReadBounds(handle);
            Assert.True(bounds.Right > bounds.Left && bounds.Bottom > bounds.Top);
            AssertWithinWorkArea(bounds, work);
            using var bitmap = new Bitmap(bounds.Right - bounds.Left, bounds.Bottom - bounds.Top);
            using (var graphics = Graphics.FromImage(bitmap))
            {
                var dc = graphics.GetHdc();
                try
                {
                    validate();
                    var rendered = PrintWindow(handle, dc, 2);
                    printWindowSucceeded = rendered;
                    Assert.True(rendered, $"Owned {kind} capture failed for {state}. No fallback is permitted.");
                    validate();
                }
                finally { graphics.ReleaseHdc(dc); }
            }
            Assert.Equal(bounds, ReadBounds(handle));
            var colors = new HashSet<int>();
            for (var y = 0; y < bitmap.Height; y += Math.Max(1, bitmap.Height / 40))
                for (var x = 0; x < bitmap.Width; x += Math.Max(1, bitmap.Width / 40))
                    colors.Add(bitmap.GetPixel(x, y).ToArgb());
            sampledColors = colors.Count;
            _ = GetWindowThreadProcessId(handle, out var currentOwner);
            Assert.Equal(owner, currentOwner);
            Assert.True(colors.Count >= 8, $"Mounted {kind} frame {state} is blank or near-uniform.");
            var image = Path.Combine(directory, state + ".png");
            bitmap.Save(image, ImageFormat.Png);
            validate();
            File.WriteAllText(Path.Combine(directory, state + ".json"), JsonSerializer.Serialize(new
            {
                state,
                qualification = "Synthetic dependencies; private owned production window. Not native compositor, keyboard, installed-app, or live Gateway proof.",
                method = "PrintWindow(PW_RENDERFULLCONTENT); no fallback",
                head = Environment.GetEnvironmentVariable("OPENCLAW_MOUNTED_CONTROL_CAPTURE_HEAD"),
                assemblySha256 = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(typeof(MountedControlCapture).Assembly.Location))),
                imageSha256 = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(image))),
                width = bitmap.Width, height = bitmap.Height, sampledColors = colors.Count,
                hwnd = handle.ToInt64(), parentHwnd = parent.ToInt64(), popup = popupEvidence,
                capturedUtc = DateTimeOffset.UtcNow,
            }, options));
            status = "raw-image-written-not-qualified";
        }
        catch (Exception error)
        {
            status = "failed";
            failure = error.GetType().FullName + ": " + error.Message;
            throw;
        }
        finally { WriteAttempt(); }
    }

    private static Bounds ReadBounds(IntPtr handle)
    {
        Assert.True(GetWindowRect(handle, out var bounds));
        return bounds;
    }

    private static void AssertWithinWorkArea(Bounds bounds, Windows.Graphics.RectInt32 work) =>
        Assert.True(bounds.Left >= work.X && bounds.Top >= work.Y && bounds.Right <= work.X + work.Width &&
            bounds.Bottom <= work.Y + work.Height, "Owned capture window must fit within its display work area.");

    private static string Desktop(uint thread)
    {
        var name = new StringBuilder(256);
        Assert.True(GetUserObjectInformationW(GetThreadDesktop(thread), 2, name, 512, out _));
        return name.ToString();
    }
    private sealed record PopupAdmission(IntPtr Parent, IntPtr Handle, uint ProcessId, uint ThreadId, string Desktop,
        Bounds ParentBounds, Bounds Bounds, RowBounds[] Rows, long[] OwnerChain, Popup Popup, FrameworkElement Root, XamlRoot XamlRoot);
    private sealed record RowBounds(double Left, double Top, double Width, double Height);
    [StructLayout(LayoutKind.Sequential)] private struct Bounds { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] private struct NativePoint { public int X, Y; }
    private delegate bool EnumThreadWindow(IntPtr window, IntPtr parameter);
    [DllImport("user32.dll")] private static extern bool EnumThreadWindows(uint thread, EnumThreadWindow callback, IntPtr parameter);
    [DllImport("user32.dll")] private static extern IntPtr GetWindow(IntPtr window, uint command);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetClassNameW(IntPtr window, StringBuilder name, int length);
    [DllImport("user32.dll")] private static extern bool PrintWindow(IntPtr window, IntPtr dc, uint flags);
    [DllImport("dwmapi.dll")] private static extern int DwmFlush();
    [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr window, out Bounds bounds);
    [DllImport("user32.dll")] private static extern bool ClientToScreen(IntPtr window, ref NativePoint point);
    [DllImport("user32.dll")] private static extern bool IsZoomed(IntPtr window);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] private static extern bool IsIconic(IntPtr window);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
    [DllImport("kernel32.dll")] private static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] private static extern IntPtr GetThreadDesktop(uint thread);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern bool GetUserObjectInformationW(IntPtr handle, int index, StringBuilder value, uint length, out uint needed);
}
