using System.Runtime.InteropServices;
using System.Runtime.CompilerServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using OpenClaw.TestSupport;
using Windows.Graphics.Imaging;
using Xunit.Abstractions;
using Uia = System.Windows.Automation;

namespace OpenClaw.Tray.UITests;

// Packet-only consumer of MountedControlCapture, not a second capture implementation.
// This contract deliberately has no foreground, Z-order, compositor, pointer or keyboard claim.
internal static class ProviderArtworkPrivatePresentation
{
    internal const string JobVariable = "OPENCLAW_PROVIDER_ARTWORK_PRIVATE_CAPTURE_JOB";
    internal const string JobValue = "private-mounted-v1";
    internal static bool IsRequested => Environment.GetEnvironmentVariable(JobVariable) == JobValue;

    internal static async Task PresentAsync(Window window)
    {
        RequireJob();
        OnboardingNativeProof.AssertSourceUnchanged();
        AssertPrivateOwned(window);
        var work = Microsoft.UI.Windowing.DisplayArea.GetFromWindowId(window.AppWindow.Id,
            Microsoft.UI.Windowing.DisplayAreaFallback.Nearest).WorkArea;
        window.AppWindow.Move(new Windows.Graphics.PointInt32(work.X, work.Y));
        // Existing supported non-activating AppWindow presentation, also used by WindowManager.
        // Showing a real private HWND is not an attempt to make that desktop the input desktop.
        window.AppWindow.Show(activateWindow: false);
        var root = Assert.IsAssignableFrom<FrameworkElement>(window.Content);
        await TestSupport.WaitForRenderedConditionAsync(() => root.IsLoaded && root.XamlRoot is not null,
            "private owned window root Loaded");
        root.UpdateLayout();
        await OnboardingNativeProof.NextCompositionAsync();
        _ = Measure(window);
        OnboardingNativeProof.AssertSourceUnchanged();
    }

    internal static async Task CaptureRequiredAsync(Window window, string state, ITestOutputHelper output,
        string[] requiredLabels, FrameworkElement requiredContent, ComboBox? popupPicker = null)
    {
        RequireJob();
        var allowed = new[] { "", "before-" }.SelectMany(prefix =>
            new[] { "Light", "Dark" }.SelectMany(theme =>
                new[] { prefix + "provider-inventory-parent-" + theme, prefix + "provider-inventory-popup-" + theme }.Concat(
                    new[] { "llama-app", "ollama" }.SelectMany(brand =>
                        new[] { "note", "text", "confirm" }.Select(step => prefix + "provider-" + brand + "-" + step + "-" + theme)))))
            .ToArray();
        Assert.Contains(state, allowed);
        Assert.NotEmpty(requiredLabels);
        OnboardingNativeProof.AssertSourceUnchanged();
        var root = Assert.IsAssignableFrom<FrameworkElement>(window.Content);
        root.UpdateLayout();
        await OnboardingNativeProof.NextCompositionAsync();
        OnboardingNativeProof.AssertFullyVisible(requiredContent, root);
        var before = Measure(window);
        var requiredContentBounds = requiredContent.TransformToVisual(root).TransformBounds(
            new Windows.Foundation.Rect(0, 0, requiredContent.ActualWidth, requiredContent.ActualHeight));
        var directory = OnboardingNativeProof.RequireProofDirectory();
        var path = Path.Combine(directory, state + ".png");
        Assert.False(File.Exists(path), "Never adopt or overwrite a previous required frame.");

        // The existing owner performs DwmFlush, PW_RENDERFULLCONTENT, no fallback,
        // private-desktop, PID, visibility, work-area and nonblank-frame admission.
        if (popupPicker is null) await MountedControlCapture.OptionalAsync(window, state);
        else
        {
            Assert.Same(requiredContent, popupPicker);
            await MountedControlCapture.OptionalPopupAsync(window, popupPicker, state);
        }
        Assert.True(File.Exists(path), "The optional owner must actually produce this required frame.");
        Assert.Equal(before, Measure(window));
        OnboardingNativeProof.AssertFullyVisible(requiredContent, root);
        using var attempt = JsonDocument.Parse(File.ReadAllText(Path.Combine(directory, state + ".attempt.json")));
        var observed = attempt.RootElement;
        var target = new NativeTarget(before.Hwnd, before.Left, before.Top, before.Right, before.Bottom);
        JsonElement? popupAdmission = null;
        if (popupPicker is not null)
        {
            var admitted = observed.GetProperty("popup");
            Assert.Equal(before.Hwnd, admitted.GetProperty("parentHwnd").GetInt64());
            Assert.Equal(Environment.ProcessId, admitted.GetProperty("ProcessId").GetInt32());
            Assert.Equal(GetCurrentThreadId(), admitted.GetProperty("ThreadId").GetUInt32());
            Assert.Equal(before.Desktop, admitted.GetProperty("Desktop").GetString());
            Assert.Equal("Microsoft.UI.Content.PopupWindowSiteBridge", admitted.GetProperty("className").GetString());
            Assert.True(admitted.GetProperty("xamlPopupOpen").GetBoolean());
            Assert.Equal(popupPicker.Items.Count, admitted.GetProperty("Rows").GetArrayLength());
            var chain = admitted.GetProperty("OwnerChain").EnumerateArray().Select(owner => owner.GetInt64()).ToArray();
            Assert.NotEmpty(chain);
            Assert.Equal(before.Hwnd, chain[^1]);
            var bounds = admitted.GetProperty("Bounds");
            target = new(admitted.GetProperty("hwnd").GetInt64(), bounds.GetProperty("Left").GetInt32(),
                bounds.GetProperty("Top").GetInt32(), bounds.GetProperty("Right").GetInt32(), bounds.GetProperty("Bottom").GetInt32());
            Assert.NotEqual(before.Hwnd, target.Hwnd);
            popupAdmission = admitted.Clone();
        }
        Assert.Equal(target.Left, observed.GetProperty("left").GetInt32());
        Assert.Equal(target.Top, observed.GetProperty("top").GetInt32());
        Assert.Equal(target.Right, observed.GetProperty("right").GetInt32());
        Assert.Equal(target.Bottom, observed.GetProperty("bottom").GetInt32());
        Assert.Equal(target.Hwnd, observed.GetProperty("hwnd").GetInt64());
        Assert.Equal(before.Hwnd, observed.GetProperty("parentHwnd").GetInt64());
        Assert.Equal(before.Desktop, observed.GetProperty("desktop").GetString());
        Assert.Equal(Environment.ProcessId, observed.GetProperty("ownerProcessId").GetInt32());
        var imageSha256 = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(path)));
        using var receipt = JsonDocument.Parse(File.ReadAllText(Path.ChangeExtension(path, ".json")));
        Assert.Equal(imageSha256, receipt.RootElement.GetProperty("imageSha256").GetString());
        Assert.Equal(Environment.GetEnvironmentVariable("OPENCLAW_MOUNTED_CONTROL_CAPTURE_HEAD"),
            receipt.RootElement.GetProperty("head").GetString());
        Assert.Equal("PrintWindow(PW_RENDERFULLCONTENT); no fallback", receipt.RootElement.GetProperty("method").GetString());
        Assert.Equal(Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(typeof(UIThreadFixture).Assembly.Location))),
            receipt.RootElement.GetProperty("assemblySha256").GetString());
        Assert.Equal(target.Right - target.Left, receipt.RootElement.GetProperty("width").GetInt32());
        Assert.Equal(target.Bottom - target.Top, receipt.RootElement.GetProperty("height").GetInt32());

        // Analyze the original complete PNG. Preserve the existing two-pass OCR policy,
        // including its explicitly unverified title exceptions, plus exact HWND-scoped UIA.
        var ocr = await ReadLabelsAsync(path, requiredLabels);
        var labels = await Task.Run(() => ReadNativeLabels(target, requiredLabels))
            .WaitAsync(OnboardingNativeProof.OcrPassTimeout);
        Assert.Equal(before, Measure(window));
        OnboardingNativeProof.AssertFullyVisible(requiredContent, root);
        OnboardingNativeProof.AssertSourceUnchanged();
        Assert.Equal(imageSha256, Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(path))));
        if (popupPicker is not null) Assert.True(popupPicker.IsDropDownOpen);
        var metadata = new
        {
            schema = "provider-artwork-private-mounted-required-v2", state,
            targetKind = popupPicker is null ? "parent" : "owned-combobox-popup", captureTarget = target, popupAdmission,
            processId = Environment.ProcessId, uiThreadId = GetCurrentThreadId(),
            qualification = "Private owned mounted production controls. Synthetic selected Gateway. Not foreground, native compositor, keyboard, installed-app, or live Gateway proof.",
            method = "PrintWindow(PW_RENDERFULLCONTENT); no fallback",
            head = Environment.GetEnvironmentVariable("OPENCLAW_MOUNTED_CONTROL_CAPTURE_HEAD"),
            freezeManifestSha256 = Environment.GetEnvironmentVariable("OPENCLAW_UI_PROOF_MANIFEST_SHA256"),
            assemblySha256 = receipt.RootElement.GetProperty("assemblySha256").GetString(),
            imageSha256, geometry = before, requiredContentBounds, requiredLabels, ocr, nativeLabels = labels,
            machineOcrPassed = ocr.MissingLabels.Length == 0,
            reviewStatus = "original full-frame human inspection required",
            capturedUtc = DateTimeOffset.UtcNow,
        };
        File.WriteAllText(Path.Combine(directory, state + ".required.json"),
            JsonSerializer.Serialize(metadata, new JsonSerializerOptions { WriteIndented = true }));
        output.WriteLine($"private-mounted-required={path}; sha256={imageSha256}; no foreground/input/compositor claim");
    }

    private static void RequireJob()
    {
        Assert.True(IsRequested, $"This overlay requires explicit {JobVariable}={JobValue}.");
        OnboardingNativeProof.AssertIsolatedRoots();
        var head = Environment.GetEnvironmentVariable("OPENCLAW_MOUNTED_CONTROL_CAPTURE_HEAD");
        Assert.Matches("^[a-f0-9]{40}$", head ?? "");
        var freeze = Environment.GetEnvironmentVariable("OPENCLAW_UI_PROOF_FREEZE_DIR")!;
        using var manifest = JsonDocument.Parse(File.ReadAllText(Path.Combine(freeze, "manifest.json")));
        Assert.Equal(manifest.RootElement.GetProperty("head").GetString(), head);
        var directory = OnboardingNativeProof.RequireProofDirectory();
        var mounted = Environment.GetEnvironmentVariable("OPENCLAW_MOUNTED_CONTROL_CAPTURE_DIR");
        Assert.False(string.IsNullOrWhiteSpace(mounted));
        Assert.True(Path.IsPathFullyQualified(mounted!));
        Assert.Equal(Path.GetFullPath(directory), Path.GetFullPath(mounted!));
    }

    private static string DesktopName(IntPtr desktop)
    {
        Assert.NotEqual(IntPtr.Zero, desktop);
        var name = new StringBuilder(256);
        Assert.True(GetUserObjectInformationW(desktop, 2, name, 512, out _));
        Assert.False(string.IsNullOrWhiteSpace(name.ToString()));
        Assert.False(string.Equals("Default", name.ToString(), StringComparison.OrdinalIgnoreCase));
        return name.ToString();
    }

    private static string AssertPrivateOwned(Window window)
    {
        var handle = WinRT.Interop.WindowNative.GetWindowHandle(window);
        Assert.NotEqual(IntPtr.Zero, handle);
        Assert.True(IsWindow(handle));
        var thread = GetWindowThreadProcessId(handle, out var owner);
        Assert.Equal((uint)Environment.ProcessId, owner);
        Assert.Equal(GetCurrentThreadId(), thread);
        var desktop = DesktopName(GetThreadDesktop(GetCurrentThreadId()));
        Assert.Equal(desktop, DesktopName(GetThreadDesktop(thread)));
        OnboardingNativeProof.AssertProductDpi(window);
        return desktop;
    }

    private static Geometry Measure(Window window)
    {
        var desktop = AssertPrivateOwned(window);
        var handle = WinRT.Interop.WindowNative.GetWindowHandle(window);
        Assert.True(window.AppWindow.IsVisible && IsWindowVisible(handle) && !IsIconic(handle));
        Assert.True(GetWindowRect(handle, out var bounds));
        Assert.True(bounds.Right > bounds.Left && bounds.Bottom > bounds.Top);
        var work = Microsoft.UI.Windowing.DisplayArea.GetFromWindowId(window.AppWindow.Id,
            Microsoft.UI.Windowing.DisplayAreaFallback.Nearest).WorkArea;
        Assert.True(bounds.Left >= work.X && bounds.Top >= work.Y &&
            bounds.Right <= work.X + work.Width && bounds.Bottom <= work.Y + work.Height,
            "The complete private HWND must fit without clipping. Never resize to manufacture a passing capture.");
        Assert.True(GetClientRect(handle, out var client));
        var origin = new Point();
        Assert.True(ClientToScreen(handle, ref origin));
        var root = Assert.IsAssignableFrom<FrameworkElement>(window.Content);
        Assert.True(root.IsLoaded && root.Visibility == Visibility.Visible);
        Assert.NotNull(root.XamlRoot);
        Assert.Same(root, root.XamlRoot.Content);
        Assert.IsType<Microsoft.UI.Windowing.OverlappedPresenter>(window.AppWindow.Presenter);
        var inset = NativeProofLayout.ContentTopInset(window.ExtendsContentIntoTitleBar, IsZoomed(handle));
        var scale = root.XamlRoot.RasterizationScale;
        Assert.True(double.IsFinite(scale) && scale > 0);
        Assert.Equal(client.Right - client.Left, NativeProofLayout.PhysicalPixels(root.XamlRoot.Size.Width, scale));
        Assert.Equal(client.Bottom - client.Top - inset, NativeProofLayout.PhysicalPixels(root.XamlRoot.Size.Height, scale));
        Assert.True(origin.X >= bounds.Left && origin.Y >= bounds.Top &&
            origin.X + client.Right <= bounds.Right && origin.Y + client.Bottom <= bounds.Bottom);
        return new(handle.ToInt64(), desktop, bounds.Left, bounds.Top, bounds.Right, bounds.Bottom,
            origin.X, origin.Y, client.Right, client.Bottom, inset, scale,
            root.XamlRoot.Size.Width, root.XamlRoot.Size.Height);
    }

    private static NativeLabel[] ReadNativeLabels(NativeTarget geometry, string[] requiredLabels)
    {
        Assert.Equal(ApartmentState.MTA, Thread.CurrentThread.GetApartmentState());
        RuntimeHelpers.RunModuleConstructor(typeof(System.Windows.Media.Visual).Module.ModuleHandle);
        var handle = new IntPtr(geometry.Hwnd);
        Assert.True(IsWindow(handle));
        Assert.NotEqual(0u, GetWindowThreadProcessId(handle, out var owner));
        Assert.Equal((uint)Environment.ProcessId, owner);
        var window = Uia.AutomationElement.FromHandle(handle);
        Assert.Equal(Environment.ProcessId, window.Current.ProcessId);
        return requiredLabels.Select(label =>
        {
            var nodes = window.FindAll(Uia.TreeScope.Descendants,
                new Uia.PropertyCondition(Uia.AutomationElement.NameProperty, label)).Cast<Uia.AutomationElement>()
                .Where(node => !node.Current.IsOffscreen && !node.Current.BoundingRectangle.IsEmpty).ToArray();
            Assert.NotEmpty(nodes);
            var node = nodes.First();
            var rectangle = node.Current.BoundingRectangle;
            Assert.Equal(label, node.Current.Name);
            Assert.True(rectangle.Width > 0 && rectangle.Height > 0 &&
                rectangle.Left >= geometry.Left && rectangle.Top >= geometry.Top &&
                rectangle.Right <= geometry.Right && rectangle.Bottom <= geometry.Bottom);
            return new NativeLabel(label, node.Current.Name, rectangle.Left, rectangle.Top,
                rectangle.Width, rectangle.Height);
        }).ToArray();
    }

    private static async Task<Labels> ReadLabelsAsync(string path, string[] requiredLabels)
    {
        var engine = Windows.Media.Ocr.OcrEngine.TryCreateFromLanguage(new Windows.Globalization.Language("en-US"))
            ?? throw new InvalidOperationException("English Windows OCR is required for the original complete private frame.");
        var file = await Windows.Storage.StorageFile.GetFileFromPathAsync(path);
        using var stream = await file.OpenAsync(Windows.Storage.FileAccessMode.Read);
        var decoder = await BitmapDecoder.CreateAsync(stream);
        static string Normalize(string text) => string.Concat(text.Where(char.IsLetterOrDigit)).ToLowerInvariant();
        static string[] Missing(string text, string[] labels) => labels.Where(label =>
            !Normalize(text).Contains(Normalize(label), StringComparison.Ordinal)).ToArray();
        using var original = await decoder.GetSoftwareBitmapAsync(BitmapPixelFormat.Bgra8, BitmapAlphaMode.Ignore);
        var first = await OnboardingNativeProof.RunOcrPassAsync(ct => engine.RecognizeAsync(original).AsTask(ct));
        if (Missing(first.Text, requiredLabels).Length == 0)
            return new(first.Text, first.Text, 1, []);
        var factor = Math.Min(2d, (double)Windows.Media.Ocr.OcrEngine.MaxImageDimension /
            Math.Max(decoder.PixelWidth, decoder.PixelHeight));
        var transform = new BitmapTransform
        {
            ScaledWidth = (uint)Math.Max(1, Math.Round(decoder.PixelWidth * factor)),
            ScaledHeight = (uint)Math.Max(1, Math.Round(decoder.PixelHeight * factor)),
            InterpolationMode = BitmapInterpolationMode.Cubic,
        };
        using var scaled = await decoder.GetSoftwareBitmapAsync(BitmapPixelFormat.Bgra8, BitmapAlphaMode.Ignore,
            transform, ExifOrientationMode.IgnoreExifOrientation, ColorManagementMode.DoNotColorManage);
        var second = await OnboardingNativeProof.RunOcrPassAsync(ct => engine.RecognizeAsync(scaled).AsTask(ct));
        var missing = Missing(second.Text, requiredLabels);
        OnboardingNativeProof.AssertManualLabelExceptions(missing, first.Text, second.Text);
        return new(first.Text, second.Text, factor, missing);
    }

    private sealed record Labels(string OriginalText, string Text, double AnalysisScale, string[] MissingLabels);
    private sealed record NativeTarget(long Hwnd, int Left, int Top, int Right, int Bottom);
    private sealed record NativeLabel(string Expected, string ActualName, double Left, double Top, double Width, double Height);
    private sealed record Geometry(long Hwnd, string Desktop, int Left, int Top, int Right, int Bottom,
        int ClientLeft, int ClientTop, int ClientWidth, int ClientHeight, int ContentTopInset,
        double RasterizationScale, double XamlWidth, double XamlHeight);
    [StructLayout(LayoutKind.Sequential)] private struct Bounds { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] private struct Point { public int X, Y; }
    [DllImport("user32.dll")] private static extern bool IsWindow(IntPtr window);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] private static extern bool IsIconic(IntPtr window);
    [DllImport("user32.dll")] private static extern bool IsZoomed(IntPtr window);
    [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr window, out Bounds bounds);
    [DllImport("user32.dll")] private static extern bool GetClientRect(IntPtr window, out Bounds bounds);
    [DllImport("user32.dll")] private static extern bool ClientToScreen(IntPtr window, ref Point point);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
    [DllImport("kernel32.dll")] private static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] private static extern IntPtr GetThreadDesktop(uint thread);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern bool GetUserObjectInformationW(IntPtr handle, int index, StringBuilder value,
        uint length, out uint needed);
}
