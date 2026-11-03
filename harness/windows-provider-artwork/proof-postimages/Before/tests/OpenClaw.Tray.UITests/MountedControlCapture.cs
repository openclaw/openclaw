using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.UI.Xaml;

namespace OpenClaw.Tray.UITests;

internal static class MountedControlCapture
{
    internal static async Task OptionalAsync(Window window, string state)
    {
        var directory = Environment.GetEnvironmentVariable("OPENCLAW_MOUNTED_CONTROL_CAPTURE_DIR");
        if (string.IsNullOrWhiteSpace(directory))
            return;

        OnboardingNativeProof.AssertIsolatedRoots();
        var desktop = new StringBuilder(256);
        Assert.True(GetUserObjectInformationW(GetThreadDesktop(GetCurrentThreadId()), 2,
            desktop, 512, out _));
        Assert.NotEqual("Default", desktop.ToString());
        var handle = WinRT.Interop.WindowNative.GetWindowHandle(window);
        GetWindowThreadProcessId(handle, out var owner);
        Assert.Equal((uint)Environment.ProcessId, owner);
        var work = Microsoft.UI.Windowing.DisplayArea.GetFromWindowId(window.AppWindow.Id,
            Microsoft.UI.Windowing.DisplayAreaFallback.Nearest).WorkArea;
        // Mounted fixtures normally live offscreen. Requested capture stays on the private desktop.
        ProviderArtworkPopupBoundary.Observe(window, "owner-before-move");
        if (!ProviderArtworkPopupBoundary.IsActive || ProviderArtworkPopupBoundary.ShouldMove(window))
            window.AppWindow.Move(new Windows.Graphics.PointInt32(work.X, work.Y));
        ProviderArtworkPopupBoundary.Observe(window, "owner-after-move");
        await OnboardingNativeProof.NextCompositionAsync();
        ProviderArtworkPopupBoundary.Observe(window, "owner-after-composition");
        Assert.Equal(0, DwmFlush());
        Assert.True(IsWindowVisible(handle));
        Assert.False(IsIconic(handle));
        Assert.True(GetWindowRect(handle, out var bounds));
        Assert.True(bounds.Right > bounds.Left && bounds.Bottom > bounds.Top);
        using var bitmap = new Bitmap(bounds.Right - bounds.Left, bounds.Bottom - bounds.Top);
        using (var graphics = Graphics.FromImage(bitmap))
        {
            var dc = graphics.GetHdc();
            try
            {
                ProviderArtworkPopupBoundary.Observe(window, "owner-before-printwindow");
                Assert.True(PrintWindow(handle, dc, 2), "Owned-window capture failed. No fallback is permitted.");
                ProviderArtworkPopupBoundary.Observe(window, "owner-after-printwindow");
            }
            finally
            {
                graphics.ReleaseHdc(dc);
            }
        }
        var colors = new HashSet<int>();
        for (var y = 0; y < bitmap.Height; y += Math.Max(1, bitmap.Height / 40))
            for (var x = 0; x < bitmap.Width; x += Math.Max(1, bitmap.Width / 40))
                colors.Add(bitmap.GetPixel(x, y).ToArgb());
        Directory.CreateDirectory(directory);
        File.WriteAllText(Path.Combine(directory, state + ".attempt.json"), JsonSerializer.Serialize(new
        {
            state,
            qualification = "Capture attempt only. Not evidence of rendered content.",
            method = "PrintWindow(PW_RENDERFULLCONTENT); no fallback",
            head = Environment.GetEnvironmentVariable("OPENCLAW_MOUNTED_CONTROL_CAPTURE_HEAD"),
            assemblySha256 = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(typeof(MountedControlCapture).Assembly.Location))),
            desktop = desktop.ToString(),
            ownerProcessId = owner,
            left = bounds.Left,
            top = bounds.Top,
            right = bounds.Right,
            bottom = bounds.Bottom,
            workLeft = work.X,
            workTop = work.Y,
            workWidth = work.Width,
            workHeight = work.Height,
            sampledColors = colors.Count,
            attemptedUtc = DateTimeOffset.UtcNow,
        }, new JsonSerializerOptions { WriteIndented = true }));
        Assert.True(bounds.Left >= work.X && bounds.Top >= work.Y &&
            bounds.Right <= work.X + work.Width && bounds.Bottom <= work.Y + work.Height,
            "Owned capture window must fit within its display work area.");
        Assert.True(colors.Count >= 8, "Mounted production-control frame is blank or near-uniform.");
        var image = Path.Combine(directory, state + ".png");
        bitmap.Save(image, ImageFormat.Png);
        File.WriteAllText(Path.Combine(directory, state + ".json"), JsonSerializer.Serialize(new
        {
            state,
            qualification = "Synthetic dependencies; private owned production window. Not native compositor, keyboard, installed-app, or live Gateway proof.",
            method = "PrintWindow(PW_RENDERFULLCONTENT); no fallback",
            head = Environment.GetEnvironmentVariable("OPENCLAW_MOUNTED_CONTROL_CAPTURE_HEAD"),
            assemblySha256 = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(typeof(MountedControlCapture).Assembly.Location))),
            imageSha256 = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(image))),
            width = bitmap.Width,
            height = bitmap.Height,
            sampledColors = colors.Count,
            capturedUtc = DateTimeOffset.UtcNow,
        }, new JsonSerializerOptions { WriteIndented = true }));
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct Bounds { public int Left, Top, Right, Bottom; }

    [DllImport("user32.dll")] private static extern bool PrintWindow(IntPtr window, IntPtr dc, uint flags);
    [DllImport("dwmapi.dll")] private static extern int DwmFlush();
    [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr window, out Bounds bounds);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] private static extern bool IsIconic(IntPtr window);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
    [DllImport("kernel32.dll")] private static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] private static extern IntPtr GetThreadDesktop(uint thread);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern bool GetUserObjectInformationW(IntPtr handle, int index, StringBuilder value,
        uint length, out uint needed);
}
