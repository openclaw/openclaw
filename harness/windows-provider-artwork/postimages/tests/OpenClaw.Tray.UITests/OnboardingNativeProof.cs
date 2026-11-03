using System.Diagnostics;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Runtime.CompilerServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Markup;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Media.Animation;
using Microsoft.UI.Xaml.Navigation;
using OpenClaw.TestSupport;
using Windows.Graphics.Imaging;
using Xunit.Abstractions;
using Uia = System.Windows.Automation;

namespace OpenClaw.Tray.UITests;

/// <summary>Fail-closed capture and input for a test-owned, unobscured foreground HWND only.</summary>
internal static class OnboardingNativeProof
{
    private static readonly Lazy<SourceIdentity> Source = new(ReadSourceIdentity);
    private static readonly string RunId = Guid.NewGuid().ToString("N");
    internal static readonly TimeSpan OcrPassTimeout = TimeSpan.FromSeconds(30);
    private static readonly ConditionalWeakTable<Microsoft.UI.Xaml.Controls.Frame, NavigationCaptureState> NavigationStates = new();
    private static readonly List<string> DpiContextTrace = [];

    internal static void InitializeProductProcessDpi()
    {
        var initialized = SetProcessDpiAwarenessContext(new IntPtr(-4));
        var error = initialized ? 0 : Marshal.GetLastWin32Error();
        using var process = Process.GetCurrentProcess();
        var context = GetDpiAwarenessContextForProcess(process.Handle);
        TraceDpiContext($"testhost process initialization: success={initialized}; error={error}; " +
            $"processContext=0x{context:X}; PresentationCoreLoaded=" +
            AppDomain.CurrentDomain.GetAssemblies().Any(assembly => assembly.GetName().Name == "PresentationCore"));
        // PresentationCore's module initializer calls SetProcessDPIAware when native UIA
        // first loads WPF. Lock our testhost default before any HWND, like the product manifest.
        Assert.True(AreDpiAwarenessContextsEqual(context, new IntPtr(-4)),
            $"Cannot initialize owned testhost as PerMonitorV2: success={initialized}, error={error}, context=0x{context:X}.");
    }

    internal static void AssertProductDpi(Window window)
    {
        using var process = Process.GetCurrentProcess();
        Assert.True(AreDpiAwarenessContextsEqual(GetDpiAwarenessContextForProcess(process.Handle), new IntPtr(-4)),
            "The owned testhost process must remain PerMonitorV2.");
        Assert.True(AreDpiAwarenessContextsEqual(GetThreadDpiAwarenessContext(), new IntPtr(-4)),
            "The owned UI callback must retain the product DPI context.");
        Assert.True(AreDpiAwarenessContextsEqual(GetWindowDpiAwarenessContext(Handle(window)), new IntPtr(-4)),
            "The same owned HWND must remain PerMonitorV2 after native UIA initialization.");
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    internal static Task AssertNativeLabelAfterWpfLoadAsync(IntPtr handle, string label) => Task.Run(() =>
    {
        Assert.Equal(ApartmentState.MTA, Thread.CurrentThread.GetApartmentState());
        RuntimeHelpers.RunModuleConstructor(typeof(System.Windows.Media.Visual).Module.ModuleHandle);
        AssertOwned(handle);
        var window = Uia.AutomationElement.FromHandle(handle);
        Assert.Equal(Environment.ProcessId, window.Current.ProcessId);
        var matches = window.FindAll(Uia.TreeScope.Descendants,
            new Uia.PropertyCondition(Uia.AutomationElement.NameProperty, label)).Cast<Uia.AutomationElement>();
        Assert.Contains(matches, element => !element.Current.IsOffscreen &&
            !element.Current.BoundingRectangle.IsEmpty && element.Current.Name == label);
    });

    internal static void TraceDpiContext(string phase, Window? window = null)
    {
        var thread = GetThreadDpiAwarenessContext();
        var hwnd = window is null ? IntPtr.Zero : Handle(window);
        var context = hwnd == IntPtr.Zero ? IntPtr.Zero : GetWindowDpiAwarenessContext(hwnd);
        var message = $"phase={phase}; nativeThread={GetCurrentThreadId()}; " +
            $"thread=0x{thread:X}; awareness={GetAwarenessFromDpiAwarenessContext(thread)}; " +
            $"hwnd=0x{hwnd:X}; windowContext=0x{context:X}; windowPMv2={AreDpiAwarenessContextsEqual(context, new IntPtr(-4))}";
        DpiContextTrace.Add(message);
        Console.WriteLine($"proof-dpi-trace {message}");
    }

    internal static void WriteDpiTrace(ITestOutputHelper output) =>
        output.WriteLine(string.Join(Environment.NewLine, DpiContextTrace));

    internal static T CreateWindow<T>(Func<T> create, [CallerMemberName] string caller = "") where T : Window
    {
        TraceDpiContext($"{caller}: before window creation");
        T window;
        // Win32 mixed-mode DPI contract: HWND awareness is fixed at creation; window-proc
        // dispatch temporarily adopts that HWND's context. Scope only synchronous creation,
        // never an await or Application.Start's message pump.
        // https://learn.microsoft.com/windows/win32/hidpi/high-dpi-improvements-for-desktop-applications
        using (var dpi = new DpiContext())
        {
            TraceDpiContext($"{caller}: entering window constructor");
            window = create();
            Assert.NotEqual(IntPtr.Zero, Handle(window));
            TraceDpiContext($"{caller}: HWND initialized", window);
            Assert.True(AreDpiAwarenessContextsEqual(GetWindowDpiAwarenessContext(Handle(window)), new IntPtr(-4)),
                "The owned HWND must be created in the product's PerMonitorV2 context.");
        }
        TraceDpiContext($"{caller}: restored after creation", window);
        return window;
    }

    internal static IDisposable TrackNavigation(Microsoft.UI.Xaml.Controls.Frame frame)
    {
        var state = new NavigationCaptureState(frame);
        NavigationStates.Add(frame, state);
        return state;
    }

    private sealed class NavigationCaptureState : IDisposable
    {
        private readonly Microsoft.UI.Xaml.Controls.Frame _frame;
        private object? _page;
        private long _admitted;
        private int _generation;
        private int _waitedGeneration = -1;
        private string _transition = "initial-page-observed";
        private bool _supported = true;

        internal NavigationCaptureState(Microsoft.UI.Xaml.Controls.Frame frame)
        {
            _frame = frame;
            _page = frame.Content;
            _admitted = Stopwatch.GetTimestamp();
            frame.Navigated += Navigated;
        }

        private void Navigated(object sender, NavigationEventArgs args)
        {
            _generation++;
            _page = args.Content;
            _admitted = Stopwatch.GetTimestamp();
            _transition = args.NavigationTransitionInfo?.GetType().Name ?? "default-entrance";
            _supported = args.NavigationTransitionInfo is null or SlideNavigationTransitionInfo or
                EntranceNavigationTransitionInfo or SuppressNavigationTransitionInfo;
        }

        internal async Task<object> WaitAsync()
        {
            Assert.True(_supported, $"No source-duration bound defined for {_transition}.");
            var page = Assert.IsAssignableFrom<Page>(_page);
            var generation = _generation;
            var admitted = _admitted;
            Assert.Same(page, _frame.Content);
            if (_waitedGeneration != generation)
            {
                await TestSupport.WaitForRenderedConditionAsync(() => page.IsLoaded, "admitted navigation page Loaded");
                _frame.UpdateLayout();
                // No public Frame transition-completion event exists. This is a source-duration
                // bound, NOT an observed completion signal: microsoft-ui-xaml 948461c2,
                // ThemeTransitions.cpp horizontal Slide/Entrance = 150+300ms; vertical Slide
                // NavigateTransitionHelper.h = 250+350ms. One wait per admitted navigation.
                var ready = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
                void Rendered(object? sender, object args)
                {
                    if (generation != _generation || !ReferenceEquals(page, _frame.Content))
                        ready.TrySetException(new InvalidOperationException("Navigation changed during capture readiness."));
                    else if (Stopwatch.GetElapsedTime(admitted) >= TimeSpan.FromMilliseconds(600))
                        ready.TrySetResult();
                }
                CompositionTarget.Rendering += Rendered;
                try { await ready.Task.WaitAsync(TimeSpan.FromSeconds(3)); }
                finally { CompositionTarget.Rendering -= Rendered; }
                await NextCompositionAsync();
                Assert.Equal(generation, _generation);
                Assert.Same(page, _frame.Content);
                _waitedGeneration = generation;
            }
            return new
            {
                generation, admittedTicks = admitted, transition = _transition,
                page = page.GetType().FullName, boundMilliseconds = 600,
                observedCompletion = false, elapsedMilliseconds = Stopwatch.GetElapsedTime(admitted).TotalMilliseconds,
            };
        }

        public void Dispose()
        {
            _frame.Navigated -= Navigated;
            NavigationStates.Remove(_frame);
        }
    }

    internal static void AssertIsolatedRoots()
    {
        var realRoots = new[]
        {
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "OpenClawTray"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "OpenClawTray"),
        };
        foreach (var variable in new[] { "OPENCLAW_TRAY_DATA_DIR", "OPENCLAW_TRAY_APPDATA_DIR", "OPENCLAW_TRAY_LOCALAPPDATA_DIR" })
        {
            var value = Environment.GetEnvironmentVariable(variable);
            Assert.False(string.IsNullOrWhiteSpace(value), $"Set isolated {variable} before native proof.");
            Assert.True(Path.IsPathFullyQualified(value!), $"{variable} must be an absolute isolated path.");
            var actual = Path.GetFullPath(value!);
            var product = variable == "OPENCLAW_TRAY_DATA_DIR" ? actual : Path.Combine(actual, "OpenClawTray");
            foreach (var real in realRoots)
                Assert.False(IsWithin(product, real) || IsWithin(real, product),
                    $"{variable} overlaps a real OpenClawTray data directory.");
            // Reject junction aliases rather than assuming string-distinct roots are isolated.
            for (var ancestor = new DirectoryInfo(actual); ancestor is not null; ancestor = ancestor.Parent)
                if (ancestor.Exists)
                    Assert.False(ancestor.Attributes.HasFlag(FileAttributes.ReparsePoint),
                        $"{variable} traverses a reparse point: {ancestor.FullName}");
        }
    }

    internal static string RequireProofDirectory()
    {
        var directory = Environment.GetEnvironmentVariable("OPENCLAW_UI_PROOF_DIR");
        Assert.False(string.IsNullOrWhiteSpace(directory), "Native proof requires OPENCLAW_UI_PROOF_DIR for complete frames and metadata.");
        Assert.True(Path.IsPathFullyQualified(directory!));
        return directory!;
    }

    internal static async Task NextCompositionAsync(TimeSpan? cadence = null)
    {
        var started = Stopwatch.GetTimestamp();
        var ready = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var frames = 0;
        void OnRendering(object? sender, object args)
        {
            if (++frames >= 2 && Stopwatch.GetElapsedTime(started) >= (cadence ?? TimeSpan.Zero))
                ready.TrySetResult();
        }
        CompositionTarget.Rendering += OnRendering;
        try { await ready.Task.WaitAsync(TimeSpan.FromSeconds(2)); }
        finally { CompositionTarget.Rendering -= OnRendering; }
    }

    internal static void ActivateOwned(Window window)
    {
        var handle = Handle(window);
        AssertOwned(handle);
        window.Activate();
        for (var attempt = 0; attempt < 20; attempt++)
        {
            BringWindowToTop(handle);
            SetForegroundWindow(handle);
            if (GetForegroundWindow() == handle)
                return;
            Thread.Sleep(50);
        }
        var actual = GetForegroundWindow();
        Assert.Fail($"Could not foreground the owned proof window. Expected {DescribeWindow(handle)}; actual {DescribeWindow(actual)}.");
    }

    private static string DescribeWindow(IntPtr handle)
    {
        if (handle == IntPtr.Zero) return "HWND=0";
        _ = GetWindowThreadProcessId(handle, out var processId);
        var className = new StringBuilder(256);
        var title = new StringBuilder(256);
        _ = GetClassName(handle, className, className.Capacity);
        _ = GetWindowText(handle, title, title.Capacity);
        return $"HWND=0x{handle.ToInt64():X}, PID={processId}, class='{className}', title='{title}'";
    }

    internal static async Task AwaitManualForegroundAdmissionAsync(Window window, ITestOutputHelper output)
    {
        AssertIsolatedRoots();
        AssertSourceUnchanged();
        var directory = RequireProofDirectory();
        var handle = Handle(window);
        AssertOwned(handle);
        using var process = Process.GetCurrentProcess();
        var startedUtc = process.StartTime.ToUniversalTime();
        var executable = process.MainModule!.FileName;
        var originalTitle = window.Title;
        var requestedUtc = DateTimeOffset.UtcNow;
        var timeout = TimeSpan.FromMinutes(3);
        var ready = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var admitted = false;
        const string title = "OpenClaw setup screenshots - click to start";
        void Activated(object sender, WindowActivatedEventArgs args)
        {
            if (GetForegroundWindow() == handle)
                ready.TrySetResult();
        }
        void Closed(object sender, WindowEventArgs args) =>
            ready.TrySetException(new InvalidOperationException("The owned gallery window closed before foreground admission."));
        var identity = new
        {
            processId = process.Id, processStartedUtc = startedUtc, executable,
            hwnd = handle.ToInt64(), title, requestedUtc, deadlineUtc = requestedUtc + timeout,
            head = Source.Value.Head, manifestSha256 = Source.Value.ManifestSha256,
        };
        window.Title = title;
        window.Activated += Activated;
        window.Closed += Closed;
        try
        {
            Directory.CreateDirectory(directory);
            File.WriteAllText(Path.Combine(directory, "manual-foreground-waiting.json"),
                JsonSerializer.Serialize(new { status = "shown-waiting-for-user-click", identity }));
            output.WriteLine($"Manual gallery admission: HWND={handle}; PID={process.Id}; title='{title}'; timeout={timeout}.");
            if (GetForegroundWindow() == handle)
                ready.TrySetResult();
            await ready.Task.WaitAsync(timeout);
            Assert.Equal(handle, Handle(window));
            AssertOwned(handle);
            process.Refresh();
            Assert.Equal(startedUtc, process.StartTime.ToUniversalTime());
            Assert.Equal(executable, process.MainModule!.FileName);
            Assert.Equal(handle, GetForegroundWindow());
            admitted = true;
        }
        finally
        {
            window.Activated -= Activated;
            window.Closed -= Closed;
            window.Title = originalTitle;
            File.WriteAllText(Path.Combine(directory, "manual-foreground-result.json"),
                JsonSerializer.Serialize(new
                {
                    status = admitted ? "admitted" : "not-admitted", identity,
                    completedUtc = DateTimeOffset.UtcNow, foregroundHwnd = GetForegroundWindow().ToInt64(),
                }));
        }
    }

    internal static async Task ApplyThemeSurfaceAsync(Grid root, ElementTheme theme)
    {
        // Resolve at the element's theme scope, not Application.Resources' default theme.
        var style = Assert.IsType<Style>(XamlReader.Load("""
            <Style xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation" TargetType="Grid">
                <Setter Property="Background" Value="{ThemeResource SolidBackgroundFillColorBaseBrush}" />
            </Style>
            """));
        root.ClearValue(Panel.BackgroundProperty);
        root.Style = style;
        root.RequestedTheme = theme;
        await TestSupport.WaitForRenderedConditionAsync(
            () => root.IsLoaded && root.ActualTheme == theme, "native surface Loaded and requested theme");
        root.UpdateLayout();
        await NextCompositionAsync();
        Assert.Equal(theme, root.ActualTheme);
        var background = Assert.IsType<SolidColorBrush>(root.Background).Color;
        if (!new Windows.UI.ViewManagement.AccessibilitySettings().HighContrast)
        {
            var light = background.R + background.G + background.B > 3 * 128;
            Assert.Equal(theme == ElementTheme.Light, light);
        }
    }

    internal static void AssertFullyVisible(FrameworkElement element, FrameworkElement viewport)
    {
        Assert.True(element.IsLoaded && element.Visibility == Visibility.Visible);
        Assert.Same(viewport.XamlRoot, element.XamlRoot);
        var root = Assert.IsAssignableFrom<FrameworkElement>(viewport.XamlRoot.Content);
        var bounds = element.TransformToVisual(root).TransformBounds(
            new Windows.Foundation.Rect(0, 0, element.ActualWidth, element.ActualHeight));
        var width = viewport is ScrollViewer scroll ? scroll.ViewportWidth : viewport.ActualWidth;
        var height = viewport is ScrollViewer scroller ? scroller.ViewportHeight : viewport.ActualHeight;
        var view = viewport.TransformToVisual(root).TransformBounds(new Windows.Foundation.Rect(0, 0, width, height));
        var scale = viewport.XamlRoot.RasterizationScale;
        Assert.True(bounds.Width > 0 && bounds.Height > 0 && view.Width > 0 && view.Height > 0);
        Assert.True(NativeProofLayout.ContainsPhysicalEdges(
            (view.Left, view.Top, view.Right, view.Bottom), (bounds.Left, bounds.Top, bounds.Right, bounds.Bottom), scale),
            $"{element.GetType().Name} '{element.Name}' clipped: content={bounds}, viewport={view}, scale={scale:R}; " +
            $"physicalBottom={NativeProofLayout.PhysicalEdge(bounds.Bottom, scale)}, " +
            $"viewportBottom={NativeProofLayout.PhysicalEdge(view.Bottom, scale)}.");
    }

    internal static async Task InvokeSettingsCardAsync(Window window, CommunityToolkit.WinUI.Controls.SettingsCard card)
    {
        AssertIsolatedRoots();
        Assert.True(card.IsEnabled && card.IsClickEnabled && card.IsLoaded);
        card.StartBringIntoView(new BringIntoViewOptions { AnimationDesired = false });
        Assert.IsAssignableFrom<FrameworkElement>(window.Content).UpdateLayout();
        await NextCompositionAsync();
        ActivateOwned(window);
        AssertCaptureTarget(window);
        Assert.True(card.Focus(FocusState.Keyboard));
        Assert.Same(card, Microsoft.UI.Xaml.Input.FocusManager.GetFocusedElement(card.XamlRoot));
        var inputs = new[]
        {
            new NativeInput { Type = 1, Keyboard = new KeyboardInput { VirtualKey = 0x20 } },
            new NativeInput { Type = 1, Keyboard = new KeyboardInput { VirtualKey = 0x20, Flags = 2 } },
        };
        Assert.Equal(2u, SendInput(2, inputs, Marshal.SizeOf<NativeInput>()));
    }

    internal static void InvokeButton(Window window, Button button)
    {
        AssertIsolatedRoots();
        Assert.Same(Assert.IsAssignableFrom<FrameworkElement>(window.Content).XamlRoot, button.XamlRoot);
        Assert.True(button.IsLoaded && button.IsEnabled);
        ActivateOwned(window);
        using var dpiContext = new DpiContext();
        AssertCaptureTarget(window);
        var peer = new Microsoft.UI.Xaml.Automation.Peers.ButtonAutomationPeer(button);
        Assert.IsAssignableFrom<Microsoft.UI.Xaml.Automation.Provider.IInvokeProvider>(
            peer.GetPattern(Microsoft.UI.Xaml.Automation.Peers.PatternInterface.Invoke)).Invoke();
    }

    internal static async Task<Frame> CaptureAsync(Window window, string name, ITestOutputHelper output,
        string[] requiredLabels, object? channels = null, FrameworkElement? requiredContent = null)
    {
        Assert.NotEmpty(requiredLabels);
        AssertIsolatedRoots();
        var directory = RequireProofDirectory();
        var source = Source.Value;
        var root = Assert.IsAssignableFrom<FrameworkElement>(window.Content);
        await TestSupport.WaitForRenderedConditionAsync(() => root.IsLoaded, "capture root Loaded");
        object? navigationReadiness = null;
        foreach (var frame in TestSupport.FindDescendants<Microsoft.UI.Xaml.Controls.Frame>(root))
            if (frame.Content is Page && NavigationStates.TryGetValue(frame, out var navigation))
                navigationReadiness = await navigation.WaitAsync();
        await NextCompositionAsync();
        Assert.Equal(0, DwmFlush());
        var started = Stopwatch.GetTimestamp();
        var timestamp = DateTimeOffset.UtcNow;
        var handle = Handle(window);
        var xamlRoot = root.XamlRoot;
        Assert.NotNull(xamlRoot);
        Assert.Same(root, xamlRoot.Content);
        var scale = xamlRoot.RasterizationScale;
        var contentSize = xamlRoot.Size;
        var dpiEvidence = ReadDpiEvidence(window);
        output.WriteLine($"capture-dpi-contexts={JsonSerializer.Serialize(dpiEvidence)}");
        Assert.True(dpiEvidence.WindowPerMonitorV2,
            "The owned proof HWND must use the same PerMonitorV2 context as the product executable.");
        Assert.True(double.IsFinite(scale) && scale > 0);
        Assert.True(contentSize.Width > 0 && contentSize.Height > 0);
        Windows.Foundation.Rect? requiredContentBounds = null;
        if (requiredContent is not null)
        {
            Assert.True(requiredContent.IsLoaded && requiredContent.Visibility == Visibility.Visible);
            Assert.Same(xamlRoot, requiredContent.XamlRoot);
            var content = requiredContent.TransformToVisual(root).TransformBounds(
                new Windows.Foundation.Rect(0, 0, requiredContent.ActualWidth, requiredContent.ActualHeight));
            Assert.True(content.Width > 0 && content.Height > 0);
            Assert.True(NativeProofLayout.ContainsPhysicalEdges((0, 0, contentSize.Width, contentSize.Height),
                (content.Left, content.Top, content.Right, content.Bottom), scale),
                $"Asserted content is clipped by XamlRoot: content={content}, host={contentSize}, scale={scale:R}.");
            requiredContentBounds = content;
        }
        Rectangle bounds;
        Rectangle clientBounds;
        Rectangle contentBounds;
        int contentTopInset;
        uint dpi;
        Bitmap bitmap;
        // Win32 measurements are raw pixels here. XamlRoot owns the content's view-to-pixel
        // scale; GetDpiForWindow describes HWND awareness and is diagnostic, not that scale.
        using (var dpiContext = new DpiContext())
        {
            bounds = AssertCaptureTarget(window);
            Assert.True(GetClientRect(handle, out var client));
            var clientOrigin = new NativePoint();
            Assert.True(ClientToScreen(handle, ref clientOrigin));
            clientBounds = Rectangle.FromLTRB(clientOrigin.X, clientOrigin.Y,
                clientOrigin.X + client.Right, clientOrigin.Y + client.Bottom);
            Assert.True(bounds.Contains(clientBounds), "Native client must be fully inside the captured HWND.");
            contentTopInset = GetContentTopInset(window);
            contentBounds = Rectangle.FromLTRB(clientBounds.Left, clientBounds.Top + contentTopInset,
                clientBounds.Right, clientBounds.Bottom);
            dpi = GetDpiForWindow(handle);
            Assert.True(dpi >= 96);
            output.WriteLine($"capture-layout hwndDpi={dpi}; xamlScale={scale:R}; xamlSize={contentSize}; " +
                $"contentActual={root.ActualWidth:R}x{root.ActualHeight:R}; rawClient={client.Right}x{client.Bottom}; " +
                $"extendsTitleBar={window.ExtendsContentIntoTitleBar}; maximized={IsZoomed(handle)}; " +
                $"contentTopInsetPx={contentTopInset}; contentBounds={contentBounds}");
            Assert.True(clientBounds.Contains(contentBounds));
            Assert.Equal(contentBounds.Width, NativeProofLayout.PhysicalPixels(contentSize.Width, scale));
            Assert.Equal(contentBounds.Height, NativeProofLayout.PhysicalPixels(contentSize.Height, scale));
            bitmap = new Bitmap(bounds.Width, bounds.Height);
        }
        var retained = false;
        try
        {
            using (var dpiContext = new DpiContext())
            {
                Assert.Equal(bounds, AssertCaptureTarget(window));
                Assert.Equal(contentTopInset, GetContentTopInset(window));
                using var graphics = Graphics.FromImage(bitmap);
                var dc = graphics.GetHdc();
                try { Assert.True(PrintWindow(handle, dc, 2), "Owned-HWND PrintWindow failed. No screen or other-window fallback is allowed."); }
                finally { graphics.ReleaseHdc(dc); }
                Assert.Equal(bounds, AssertCaptureTarget(window));
            }
            var colors = new HashSet<int>();
            for (var y = 0; y < bitmap.Height; y += Math.Max(1, bitmap.Height / 40))
                for (var x = 0; x < bitmap.Width; x += Math.Max(1, bitmap.Width / 40))
                    colors.Add(bitmap.GetPixel(x, y).ToArgb());
            Assert.True(colors.Count >= 8, "The complete native frame is blank or near-uniform.");
            Directory.CreateDirectory(directory);
            var path = Path.Combine(directory, $"{name}.png");
            bitmap.Save(path, System.Drawing.Imaging.ImageFormat.Png);
            var sha = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(path)));
            var ocr = await AssertLabelsAsync(path, requiredLabels);
            var manualLabelEvidence = ocr.MissingLabels.Length == 0 ? [] :
                await ReadExactVisibleLabelEvidenceAsync(handle, bounds, ocr.MissingLabels);
            var metadata = new
            {
                runId = RunId, timestamp, captureEndedUtc = DateTimeOffset.UtcNow,
                captureTicks = started, stopwatchFrequency = Stopwatch.Frequency,
                captureMilliseconds = Stopwatch.GetElapsedTime(started).TotalMilliseconds,
                hwnd = $"0x{handle:X}", processId = Environment.ProcessId, source.Head, source.ManifestSha256,
                sourceManifest = Path.Combine(directory, $"source-{RunId}.json"),
                dpi, rasterizationScale = scale, xamlRootSize = contentSize,
                dpiEvidence,
                contentActualSize = new { root.ActualWidth, root.ActualHeight },
                requiredContentBounds, bounds, clientBounds, contentBounds, contentTopInset,
                sha256 = sha, requiredLabels, ocr = ocr.Text, ocrEvidence = ocr, navigationReadiness, channels,
                machineOcrPassed = ocr.MissingLabels.Length == 0,
                reviewStatus = ocr.MissingLabels.Length == 0 ? "machine-labels-verified" : "machineOCR-unverified; manualreviewrequired",
                manualLabelEvidence,
                method = "PrintWindow(PW_RENDERFULLCONTENT), no fallback",
            };
            File.WriteAllText(metadata.sourceManifest, source.Json);
            File.WriteAllText(Path.ChangeExtension(path, ".json"), JsonSerializer.Serialize(metadata,
                new JsonSerializerOptions { WriteIndented = true }));
            output.WriteLine($"hwnd-scoped-proof={path}; sha256={sha}; source={source.Head}; utc={timestamp:O}; channels={JsonSerializer.Serialize(channels)}");
            retained = true;
            return new Frame(bitmap, bounds, clientBounds, contentBounds, dpi, scale);
        }
        finally
        {
            if (!retained) bitmap.Dispose();
        }
    }

    internal static void AssertHeroLayout(FrameworkElement hero, ITestOutputHelper? output = null)
    {
        Assert.True(hero.IsLoaded);
        const double size = OpenClaw.SetupEngine.UI.Controls.OnboardingMascot.HeroSize;
        Assert.InRange(size * 120 / 168, 124, 132);
        Assert.Equal(size, hero.Width);
        Assert.Equal(size, hero.Height);
        Assert.True(hero.UseLayoutRounding);
        var scale = hero.XamlRoot.RasterizationScale;
        var expected = NativeProofLayout.RoundedViewSize(size, scale);
        output?.WriteLine($"hero-layout scale={scale:R}; configured={size}x{size}; expectedView={expected:R}; " +
            $"actual={hero.ActualWidth:R}x{hero.ActualHeight:R}; physical={NativeProofLayout.PhysicalPixels(size, scale)}");
        Assert.Equal(expected, hero.ActualWidth);
        Assert.Equal(expected, hero.ActualHeight);
        Assert.Equal(NativeProofLayout.PhysicalPixels(size, scale), NativeProofLayout.PhysicalPixels(hero.ActualWidth, scale));
        Assert.Equal(NativeProofLayout.PhysicalPixels(size, scale), NativeProofLayout.PhysicalPixels(hero.ActualHeight, scale));
    }

    internal static void AssertSourceUnchanged()
    {
        var current = ReadSourceIdentity();
        Assert.Equal(Source.Value.Head, current.Head);
        Assert.Equal(Source.Value.ManifestSha256, current.ManifestSha256);
    }

    internal static void MovePointer(Window window, FrameworkElement target, double x, double y)
    {
        using var dpi = new DpiContext();
        AssertCaptureTarget(window);
        var point = TargetPoint(window, target, x, y);
        AssertPointOwned(window, point);
        var left = GetSystemMetrics(76);
        var top = GetSystemMetrics(77);
        var width = GetSystemMetrics(78);
        var height = GetSystemMetrics(79);
        Assert.True(width > 1 && height > 1);
        var input = new NativeInput
        {
            Type = 0,
            Mouse = new MouseInput
            {
                X = (int)Math.Round((point.X - left) * 65535d / (width - 1)),
                Y = (int)Math.Round((point.Y - top) * 65535d / (height - 1)),
                Flags = 0x0001 | 0x8000 | 0x4000,
            },
        };
        Assert.Equal(1u, SendInput(1, [input], Marshal.SizeOf<NativeInput>()));
    }

    internal static void TapPointer(Window window, FrameworkElement target, double x, double y)
    {
        using var dpi = new DpiContext();
        AssertCaptureTarget(window);
        var expected = TargetPoint(window, target, x, y);
        Assert.True(GetCursorPos(out var actual));
        Assert.InRange(Math.Abs(actual.X - expected.X), 0, 1);
        Assert.InRange(Math.Abs(actual.Y - expected.Y), 0, 1);
        AssertPointOwned(window, actual);
        var inputs = new[]
        {
            new NativeInput { Type = 0, Mouse = new MouseInput { Flags = 0x0002 } },
            new NativeInput { Type = 0, Mouse = new MouseInput { Flags = 0x0004 } },
        };
        var sent = SendInput(2, inputs, Marshal.SizeOf<NativeInput>());
        // If Windows inserted only the down event, release it only while ownership is intact.
        if (sent == 1)
        {
            AssertPointOwned(window, actual);
            Assert.Equal(1u, SendInput(1, [inputs[1]], Marshal.SizeOf<NativeInput>()));
        }
        Assert.Equal(2u, sent);
    }

    internal static Rectangle ClientPixels(Window window, FrameworkElement element, Frame frame)
    {
        var root = Assert.IsAssignableFrom<FrameworkElement>(window.Content);
        var logical = element.TransformToVisual(root).TransformBounds(new Windows.Foundation.Rect(0, 0, element.ActualWidth, element.ActualHeight));
        var scale = frame.RasterizationScale;
        Assert.Equal(scale, root.XamlRoot.RasterizationScale);
        var rectangle = Rectangle.FromLTRB(
            frame.ContentBounds.Left - frame.Bounds.Left + (int)Math.Floor(logical.Left * scale),
            frame.ContentBounds.Top - frame.Bounds.Top + (int)Math.Floor(logical.Top * scale),
            frame.ContentBounds.Left - frame.Bounds.Left + (int)Math.Ceiling(logical.Right * scale),
            frame.ContentBounds.Top - frame.Bounds.Top + (int)Math.Ceiling(logical.Bottom * scale));
        Assert.True(new Rectangle(0, 0, frame.Bitmap.Width, frame.Bitmap.Height).Contains(rectangle));
        Assert.True(rectangle.Width > 0 && rectangle.Height > 0);
        return rectangle;
    }

    internal static void AssertChanged(Frame first, Frame second, Rectangle region)
    {
        Assert.Equal(first.Bounds, second.Bounds);
        var changed = 0;
        for (var y = region.Top; y < region.Bottom; y++)
            for (var x = region.Left; x < region.Right; x++)
                if (first.Bitmap.GetPixel(x, y).ToArgb() != second.Bitmap.GetPixel(x, y).ToArgb())
                    changed++;
        Assert.True(changed > 20, $"Expected composed pose changes inside mascot ROI, found {changed} pixels.");
    }

    private static NativePoint TargetPoint(Window window, FrameworkElement target, double x, double y)
    {
        Assert.InRange(x, 1, target.ActualWidth - 1);
        Assert.InRange(y, 1, target.ActualHeight - 1);
        var logical = target.TransformToVisual(Assert.IsAssignableFrom<FrameworkElement>(window.Content))
            .TransformPoint(new Windows.Foundation.Point(x, y));
        var handle = Handle(window);
        var point = new NativePoint();
        Assert.True(ClientToScreen(handle, ref point));
        point.Y += GetContentTopInset(window);
        var scale = target.XamlRoot.RasterizationScale;
        point.X += (int)Math.Round(logical.X * scale);
        point.Y += (int)Math.Round(logical.Y * scale);
        return point;
    }

    private static int GetContentTopInset(Window window)
    {
        // Pinned WinUI CWindowChrome::UpdateBridgeWindowSizePosition moves the XAML
        // bridge down by GetTopBorderHeight() and subtracts that exact height.
        // These proof windows use only the standard overlapped presenter.
        Assert.IsType<Microsoft.UI.Windowing.OverlappedPresenter>(window.AppWindow.Presenter);
        return NativeProofLayout.ContentTopInset(window.ExtendsContentIntoTitleBar, IsZoomed(Handle(window)));
    }

    private static void AssertPointOwned(Window window, NativePoint point)
    {
        var handle = Handle(window);
        AssertOwned(handle);
        Assert.Equal(handle, GetForegroundWindow());
        Assert.Equal(handle, GetAncestor(WindowFromPoint(point), 2));
    }

    private static Rectangle AssertCaptureTarget(Window window)
    {
        var handle = Handle(window);
        AssertOwned(handle);
        Assert.True(window.AppWindow.IsVisible && IsWindowVisible(handle) && !IsIconic(handle));
        Assert.Equal(handle, GetForegroundWindow());
        Assert.True(GetWindowRect(handle, out var native));
        var bounds = native.Rectangle;
        Assert.True(bounds.Width > 0 && bounds.Height > 0);
        var monitor = new MonitorInfo { Size = Marshal.SizeOf<MonitorInfo>() };
        Assert.True(GetMonitorInfo(MonitorFromWindow(handle, 2), ref monitor));
        Assert.True(monitor.Work.Rectangle.Contains(bounds), "Proof HWND is clipped by the monitor/work area.");
        var found = false;
        List<IntPtr> occluders = [];
        List<IntPtr> unreadable = [];
        EnumWindows((candidate, _) =>
        {
            if (candidate == handle) { found = true; return false; }
            if (!IsWindowVisible(candidate) || IsIconic(candidate)) return true;
            if (DwmGetWindowAttribute(candidate, 14, out int cloaked, sizeof(int)) != 0 ||
                !GetWindowRect(candidate, out var other))
            {
                unreadable.Add(candidate);
                return true;
            }
            if (cloaked == 0 && bounds.IntersectsWith(other.Rectangle))
                occluders.Add(candidate);
            return true;
        }, IntPtr.Zero);
        Assert.True(found, "Owned HWND missing from native Z order.");
        Assert.Empty(unreadable);
        Assert.True(occluders.Count == 0, $"Proof HWND is occluded by {string.Join(", ", occluders.Select(h => $"0x{h:X}"))}.");
        return bounds;
    }

    private static void AssertOwned(IntPtr handle)
    {
        Assert.NotEqual(IntPtr.Zero, handle);
        Assert.NotEqual(0u, GetWindowThreadProcessId(handle, out var processId));
        Assert.Equal((uint)Environment.ProcessId, processId);
    }

    private sealed record OcrEvidence(string OriginalText, string Text, double AnalysisScale,
        uint OriginalWidth, uint OriginalHeight, uint AnalysisWidth, uint AnalysisHeight, string[] MissingLabels);

    private sealed record NativeLabelEvidence(string Expected, string ActualName, string ControlType,
        double Left, double Top, double Width, double Height, string Status);

    internal static async Task AssertNativeDialogNameAsync(Window window,
        OpenClaw.SetupEngine.UI.Controls.ProviderSetupDialog dialog, string expectedName,
        bool openedObserved, string state, ITestOutputHelper output)
    {
        Assert.True(openedObserved, "Observe this dialog's actual Opened event before querying native automation.");
        Assert.True(window.DispatcherQueue.HasThreadAccess);
        AssertOwned(Handle(window));
        var currentRoot = Assert.IsAssignableFrom<FrameworkElement>(window.Content);
        Assert.NotNull(currentRoot.XamlRoot);
        Assert.Same(currentRoot.XamlRoot, dialog.XamlRoot);
        Assert.Equal(expectedName, Assert.IsType<string>(dialog.Title));
        // Logical step readiness precedes WinUI's deferred measure/arrange. Admit current layout before snapshotting it.
        dialog.UpdateLayout();
        var textInput = Assert.IsType<TextBox>(dialog.FindName("TextInput"));
        if (expectedName == "Provider text")
        {
            Assert.True(textInput.IsLoaded && textInput.Visibility == Visibility.Visible);
            Assert.Same(currentRoot.XamlRoot, textInput.XamlRoot);
            Assert.True(double.IsFinite(textInput.ActualWidth) && double.IsFinite(textInput.ActualHeight) &&
                textInput.ActualWidth > 0 && textInput.ActualHeight > 0);
        }
        var layoutAdmission = new
        {
            operation = "UIElement.UpdateLayout", completed = true, currentTitle = Assert.IsType<string>(dialog.Title),
            textInputLoaded = textInput.IsLoaded, textInputVisibility = textInput.Visibility.ToString(),
            textInputWidth = textInput.ActualWidth, textInputHeight = textInput.ActualHeight,
            uiThreadId = GetCurrentThreadId(), completedUtc = DateTimeOffset.UtcNow,
        };
        output.WriteLine($"native-dialog-layout-admitted={state}; operation=UIElement.UpdateLayout; title={layoutAdmission.currentTitle}; thread={layoutAdmission.uiThreadId}");
        var binding = BindNativeDialog(window, dialog);
        var proofDirectory = Environment.GetEnvironmentVariable("OPENCLAW_UI_PROOF_DIR");
        if (!string.IsNullOrWhiteSpace(proofDirectory)) AssertSourceUnchanged();
        Assert.Equal(state, Path.GetFileName(state));
        var path = string.IsNullOrWhiteSpace(proofDirectory) ? null : Path.Combine(proofDirectory, state + ".dialog-uia.json");
        if (path is not null) Assert.False(File.Exists(path), "Never adopt an old dialog-name observation.");
        var observed = await Task.Run(() => ReadNativeDialog(binding));
        void Save(string status, NativeDialogNode? selected = null)
        {
            var json = JsonSerializer.Serialize(new
            {
                schema = "owned-native-dialog-name-v1", layoutAdmission, providerGeometryContract = "rendered-in-native-in-measured-slot-physical-pixels", state, status, expectedName, openedObserved,
                binding.Hwnd, binding.ProcessId, binding.ThreadId, binding.Title, binding.Provider,
                binding.WindowBounds, binding.ContentBounds, binding.RenderedProviderBounds, binding.ProviderLayoutSlotInParent, binding.ProviderLayoutSlotBounds,
                referenceContract = "microsoft-ui-xaml 948461c2d0c93bce2e9c039ec28b4a25976afede: ContentDialog projects Name to PopupAutomationPeer; class Popup, Window role",
                head = string.IsNullOrWhiteSpace(proofDirectory) ? null : Source.Value.Head,
                freezeManifestSha256 = Environment.GetEnvironmentVariable("OPENCLAW_UI_PROOF_MANIFEST_SHA256"),
                assemblySha256 = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(typeof(OnboardingNativeProof).Assembly.Location))),
                observed, selected, recordedUtc = DateTimeOffset.UtcNow,
            }, new JsonSerializerOptions { WriteIndented = true });
            if (path is not null) File.WriteAllText(path, json);
            else if (status == "observed-not-verified") output.WriteLine(json);
            output.WriteLine($"native-dialog-name={state}; status={status}; observation={path ?? "test output"}");
        }
        // Record the real native role/name tree before cardinality/name assertions can fail.
        Save("observed-not-verified");
        Assert.Empty(observed.Errors);
        Assert.False(observed.Overflow, "The owned subtree exceeded the bounded observation budget.");
        var current = BindNativeDialog(window, dialog);
        Assert.Same(binding.Root, current.Root);
        Assert.Same(binding.XamlRoot, current.XamlRoot);
        Assert.Same(binding.ProviderParent, current.ProviderParent);
        Assert.Equal(binding.Hwnd, current.Hwnd);
        Assert.Equal(binding.ProcessId, current.ProcessId);
        Assert.Equal(binding.ThreadId, current.ThreadId);
        Assert.Equal(binding.Title, current.Title);
        Assert.Equal(binding.Provider, current.Provider);
        Assert.Equal(binding.WindowBounds, current.WindowBounds);
        Assert.Equal(binding.ContentBounds, current.ContentBounds);
        Assert.Equal(binding.RenderedProviderBounds, current.RenderedProviderBounds);
        Assert.Equal(binding.ProviderLayoutSlotInParent, current.ProviderLayoutSlotInParent);
        Assert.Equal(binding.ProviderLayoutSlotBounds, current.ProviderLayoutSlotBounds);
        Assert.Equal(expectedName, binding.Title);
        var candidate = Assert.Single(observed.Nodes, node =>
            node.ProcessId == binding.ProcessId && node.Role == "ControlType.Window" && node.ClassName == "Popup" &&
            node.IsModal == true && !node.IsOffscreen && node.RuntimeId.Length > 0 && node.Bounds is { } bounds &&
            binding.WindowBounds.Contains(bounds) && bounds.Contains(binding.ContentBounds) && bounds.Contains(binding.RenderedProviderBounds) &&
            bounds.Contains(binding.ProviderLayoutSlotBounds) &&
            node.TextChildren.Any(text => text.ProcessId == binding.ProcessId && !text.IsOffscreen &&
                // TextBlock ActualWidth is text metrics; UIA encloses the arranged visual, not the full pre-alignment slot.
                // Require the real provider's visible extent inside its native box, itself inside its measured slot.
                text.Name == binding.Provider && text.Bounds is { } providerBounds &&
                providerBounds.ContainsPhysical(binding.RenderedProviderBounds) && binding.ProviderLayoutSlotBounds.ContainsPhysical(providerBounds) &&
                observed.Nodes.Any(providerNode => providerNode.RuntimeId.SequenceEqual(text.RuntimeId) &&
                    providerNode.ProcessId == binding.ProcessId && providerNode.Role == "ControlType.Text" &&
                    providerNode.ClassName == "TextBlock" && providerNode.AutomationId == "ProviderName" && !providerNode.IsOffscreen)) &&
            node.TextChildren.Any(text => text.ProcessId == binding.ProcessId && !text.IsOffscreen &&
                text.Name == expectedName && text.Bounds is { } titleBounds && bounds.Contains(titleBounds)));
        Assert.Equal(expectedName, candidate.Name);
        if (!string.IsNullOrWhiteSpace(proofDirectory)) AssertSourceUnchanged();
        Save("name-verified", candidate);
    }

    private static NativeDialogBinding BindNativeDialog(Window window,
        OpenClaw.SetupEngine.UI.Controls.ProviderSetupDialog dialog)
    {
        var handle = Handle(window);
        AssertOwned(handle);
        var thread = GetWindowThreadProcessId(handle, out var process);
        Assert.Equal(GetCurrentThreadId(), thread);
        Assert.True(IsWindowVisible(handle) && !IsIconic(handle));
        var root = Assert.IsAssignableFrom<FrameworkElement>(window.Content);
        Assert.NotNull(root.XamlRoot);
        Assert.Same(root, root.XamlRoot.Content);
        Assert.Same(root.XamlRoot, dialog.XamlRoot);
        var content = Assert.IsAssignableFrom<FrameworkElement>(dialog.Content);
        var provider = Assert.IsType<TextBlock>(dialog.FindName("ProviderName"));
        Assert.All(new FrameworkElement[] { content, provider }, element =>
        {
            Assert.True(element.IsLoaded && element.Visibility == Visibility.Visible);
            Assert.Same(root.XamlRoot, element.XamlRoot);
        });
        Assert.False(string.IsNullOrWhiteSpace(provider.Text));
        Assert.True(GetWindowRect(handle, out var windowBounds));
        var origin = new NativePoint();
        Assert.True(ClientToScreen(handle, ref origin));
        var inset = GetContentTopInset(window);
        var scale = root.XamlRoot.RasterizationScale;
        Assert.True(double.IsFinite(scale) && scale > 0);
        NativeDialogBounds PhysicalBounds(Windows.Foundation.Rect rect, string context = "rendered element")
        {
            var physical = new NativeDialogBounds(origin.X + rect.Left * scale, origin.Y + inset + rect.Top * scale,
                origin.X + rect.Right * scale, origin.Y + inset + rect.Bottom * scale);
            Assert.True(physical.PositiveFinite,
                $"Rejected native-dialog geometry: context={context}; rootRect={rect}; physical={physical}; clientOrigin=({origin.X},{origin.Y}); inset={inset}; scale={scale}.");
            return physical;
        }
        NativeDialogBounds Bounds(FrameworkElement element) => PhysicalBounds(
            element.TransformToVisual(root).TransformBounds(
                new Windows.Foundation.Rect(0, 0, element.ActualWidth, element.ActualHeight)));
        var providerParent = Assert.IsAssignableFrom<FrameworkElement>(VisualTreeHelper.GetParent(provider));
        Assert.Same(root.XamlRoot, providerParent.XamlRoot);
        var renderedProviderBounds = Bounds(provider);
        var layoutSlot = Microsoft.UI.Xaml.Controls.Primitives.LayoutInformation.GetLayoutSlot(provider);
        var providerLayoutSlotInParent = new NativeDialogBounds(layoutSlot.Left, layoutSlot.Top, layoutSlot.Right, layoutSlot.Bottom);
        var slotContext = $"parent={providerParent.GetType().FullName}/{providerParent.Name}; rawSlot={providerLayoutSlotInParent}; rendered={renderedProviderBounds}";
        Assert.True(providerLayoutSlotInParent.PositiveFinite,
            $"Actual provider layout slot must be finite and nonempty: {slotContext}; physicalSlot=not projected because raw slot was rejected.");
        var providerLayoutSlotBounds = PhysicalBounds(providerParent.TransformToVisual(root).TransformBounds(layoutSlot), slotContext);
        Assert.True(providerLayoutSlotBounds.Contains(renderedProviderBounds),
            $"Actual provider layout slot must contain its rendered extent: {slotContext}; physicalSlot={providerLayoutSlotBounds}.");
        var outer = windowBounds.Rectangle;
        return new(handle.ToInt64(), (int)process, thread, root, root.XamlRoot, providerParent,
            Assert.IsType<string>(dialog.Title), provider.Text,
            new(outer.Left, outer.Top, outer.Right, outer.Bottom), Bounds(content), renderedProviderBounds, providerLayoutSlotInParent, providerLayoutSlotBounds);
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static NativeDialogObservation ReadNativeDialog(NativeDialogBinding binding)
    {
        Assert.Equal(ApartmentState.MTA, Thread.CurrentThread.GetApartmentState());
        RuntimeHelpers.RunModuleConstructor(typeof(System.Windows.Media.Visual).Module.ModuleHandle);
        var nodes = new List<NativeDialogNode>();
        var errors = new List<string>();
        var count = 0;
        try
        {
            var handle = new IntPtr(binding.Hwnd);
            AssertOwned(handle);
            var root = Uia.AutomationElement.FromHandle(handle);
            Assert.Equal(binding.ProcessId, root.Current.ProcessId);
            var owned = new Uia.PropertyCondition(Uia.AutomationElement.ProcessIdProperty, binding.ProcessId);
            var elements = root.FindAll(Uia.TreeScope.Descendants, owned).Cast<Uia.AutomationElement>().ToArray();
            count = elements.Length;
            foreach (var element in elements.Take(512))
            {
                try
                {
                    var current = element.Current;
                    if (current.ProcessId != binding.ProcessId) continue;
                    var role = current.ControlType.ProgrammaticName;
                    var children = new List<NativeDialogText>();
                    bool? modal = null;
                    if (current.ControlType == Uia.ControlType.Window)
                    {
                        if (element.TryGetCurrentPattern(Uia.WindowPattern.Pattern, out var pattern) && pattern is Uia.WindowPattern windowPattern)
                            modal = windowPattern.Current.IsModal;
                        var text = element.FindAll(Uia.TreeScope.Descendants, new Uia.AndCondition(owned,
                            new Uia.PropertyCondition(Uia.AutomationElement.ControlTypeProperty, Uia.ControlType.Text)))
                            .Cast<Uia.AutomationElement>().ToArray();
                        if (text.Length > 512) errors.Add("Dialog text subtree exceeded observation budget.");
                        foreach (var child in text.Take(512))
                        {
                            var childCurrent = child.Current;
                            if (childCurrent.ProcessId != binding.ProcessId) continue;
                            children.Add(new(child.GetRuntimeId(), childCurrent.ProcessId, childCurrent.Name,
                                NativeDialogBounds.From(childCurrent.BoundingRectangle), childCurrent.IsOffscreen));
                        }
                    }
                    nodes.Add(new(element.GetRuntimeId(), current.ProcessId, role, current.ClassName,
                        current.Name, current.AutomationId, NativeDialogBounds.From(current.BoundingRectangle),
                        current.IsOffscreen, modal, children.ToArray()));
                }
                catch (Uia.ElementNotAvailableException error) { errors.Add(error.GetType().Name); }
                catch (COMException error) { errors.Add(error.GetType().Name); }
            }
        }
        catch (Uia.ElementNotAvailableException error) { errors.Add(error.GetType().Name); }
        catch (COMException error) { errors.Add(error.GetType().Name); }
        return new(count, count > 512, nodes.ToArray(), errors.ToArray());
    }

    private sealed record NativeDialogBinding(long Hwnd, int ProcessId, uint ThreadId, FrameworkElement Root,
        XamlRoot XamlRoot, FrameworkElement ProviderParent, string Title, string Provider, NativeDialogBounds WindowBounds,
        NativeDialogBounds ContentBounds, NativeDialogBounds RenderedProviderBounds,
        NativeDialogBounds ProviderLayoutSlotInParent, NativeDialogBounds ProviderLayoutSlotBounds);
    private sealed record NativeDialogObservation(int TotalOwnedNodes, bool Overflow, NativeDialogNode[] Nodes, string[] Errors);
    private sealed record NativeDialogNode(int[] RuntimeId, int ProcessId, string Role, string ClassName,
        string Name, string AutomationId, NativeDialogBounds? Bounds, bool IsOffscreen, bool? IsModal,
        NativeDialogText[] TextChildren);
    private sealed record NativeDialogText(int[] RuntimeId, int ProcessId, string Name, NativeDialogBounds? Bounds, bool IsOffscreen);
    private sealed record NativeDialogBounds(double Left, double Top, double Right, double Bottom)
    {
        internal bool PositiveFinite => double.IsFinite(Left) && double.IsFinite(Top) && double.IsFinite(Right) &&
            double.IsFinite(Bottom) && Right > Left && Bottom > Top;
        internal bool Contains(NativeDialogBounds other) => other.PositiveFinite && other.Left >= Left && other.Top >= Top &&
            other.Right <= Right && other.Bottom <= Bottom;
        internal bool ContainsPhysical(NativeDialogBounds other) => PositiveFinite && other.PositiveFinite &&
            NativeProofLayout.PhysicalEdge(Right, 1) > NativeProofLayout.PhysicalEdge(Left, 1) &&
            NativeProofLayout.PhysicalEdge(Bottom, 1) > NativeProofLayout.PhysicalEdge(Top, 1) &&
            NativeProofLayout.PhysicalEdge(other.Right, 1) > NativeProofLayout.PhysicalEdge(other.Left, 1) &&
            NativeProofLayout.PhysicalEdge(other.Bottom, 1) > NativeProofLayout.PhysicalEdge(other.Top, 1) &&
            NativeProofLayout.PhysicalEdge(other.Left, 1) >= NativeProofLayout.PhysicalEdge(Left, 1) &&
            NativeProofLayout.PhysicalEdge(other.Top, 1) >= NativeProofLayout.PhysicalEdge(Top, 1) &&
            NativeProofLayout.PhysicalEdge(other.Right, 1) <= NativeProofLayout.PhysicalEdge(Right, 1) &&
            NativeProofLayout.PhysicalEdge(other.Bottom, 1) <= NativeProofLayout.PhysicalEdge(Bottom, 1);
        internal static NativeDialogBounds? From(System.Windows.Rect rect)
        {
            var result = new NativeDialogBounds(rect.Left, rect.Top, rect.Right, rect.Bottom);
            return result.PositiveFinite ? result : null;
        }
    }

    private static Task<NativeLabelEvidence[]> ReadExactVisibleLabelEvidenceAsync(
        IntPtr handle, Rectangle capturedBounds, string[] labels) => Task.Run(() =>
    {
        Assert.Equal(ApartmentState.MTA, Thread.CurrentThread.GetApartmentState());
        AssertOwned(handle);
        var window = Uia.AutomationElement.FromHandle(handle);
        Assert.Equal(Environment.ProcessId, window.Current.ProcessId);
        return labels.Select(label =>
        {
            var matches = window.FindAll(Uia.TreeScope.Descendants,
                new Uia.PropertyCondition(Uia.AutomationElement.NameProperty, label)).Cast<Uia.AutomationElement>()
                .Where(element => !element.Current.IsOffscreen && !element.Current.BoundingRectangle.IsEmpty).ToArray();
            Assert.NotEmpty(matches);
            var node = matches.First();
            var rectangle = node.Current.BoundingRectangle;
            Assert.True(rectangle.Left >= capturedBounds.Left && rectangle.Top >= capturedBounds.Top &&
                rectangle.Right <= capturedBounds.Right && rectangle.Bottom <= capturedBounds.Bottom);
            Assert.Equal(label, node.Current.Name);
            return new NativeLabelEvidence(label, node.Current.Name, node.Current.ControlType.ProgrammaticName,
                rectangle.Left, rectangle.Top, rectangle.Width, rectangle.Height,
                "Exact native UIA only; original pixels require coordinator human review. OCR did not pass.");
        }).ToArray();
    });

    private static async Task<OcrEvidence> AssertLabelsAsync(string path, string[] labels)
    {
        var engine = Windows.Media.Ocr.OcrEngine.TryCreateFromLanguage(new Windows.Globalization.Language("en-US"))
            ?? throw new InvalidOperationException("English Windows OCR is required for native-window proof.");
        var file = await Windows.Storage.StorageFile.GetFileFromPathAsync(path);
        using var stream = await file.OpenAsync(Windows.Storage.FileAccessMode.Read);
        var decoder = await BitmapDecoder.CreateAsync(stream);
        static string Normalize(string text) => string.Concat(text.Where(char.IsLetterOrDigit)).ToLowerInvariant();
        using var originalBitmap = await decoder.GetSoftwareBitmapAsync(BitmapPixelFormat.Bgra8, BitmapAlphaMode.Ignore);
        var original = await RunOcrPassAsync(ct => engine.RecognizeAsync(originalBitmap).AsTask(ct));
        if (labels.All(label => Normalize(original.Text).Contains(Normalize(label), StringComparison.Ordinal)))
            return new(original.Text, original.Text, 1, decoder.PixelWidth, decoder.PixelHeight,
                decoder.PixelWidth, decoder.PixelHeight, []);
        // OCR operates on the entire immutable capture at a bounded analysis resolution.
        // One higher-resolution analysis pass, never iterative label/geometry polling.
        // Retain the original PNG; do not recolor, crop or relax expected labels.
        var max = Windows.Media.Ocr.OcrEngine.MaxImageDimension;
        var factor = Math.Min(2d, (double)max / Math.Max(decoder.PixelWidth, decoder.PixelHeight));
        var transform = new BitmapTransform
        {
            ScaledWidth = (uint)Math.Max(1, Math.Round(decoder.PixelWidth * factor)),
            ScaledHeight = (uint)Math.Max(1, Math.Round(decoder.PixelHeight * factor)),
            InterpolationMode = BitmapInterpolationMode.Cubic,
        };
        using var bitmap = await decoder.GetSoftwareBitmapAsync(BitmapPixelFormat.Bgra8, BitmapAlphaMode.Ignore,
            transform, ExifOrientationMode.IgnoreExifOrientation, ColorManagementMode.DoNotColorManage);
        var result = await RunOcrPassAsync(ct => engine.RecognizeAsync(bitmap).AsTask(ct));
        var missing = labels.Where(label => !Normalize(result.Text).Contains(Normalize(label), StringComparison.Ordinal)).ToArray();
        File.WriteAllText(Path.ChangeExtension(path, ".ocr.json"), JsonSerializer.Serialize(new
        {
            image = path, sha256 = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(path))),
            requiredLabels = labels, originalText = original.Text, scaledText = result.Text,
            missingLabels = missing, factor,
        }, new JsonSerializerOptions { WriteIndented = true }));
        // Coordinator-approved evidence split only for documented capital-I/l
        // ambiguities. Never substitute text or call OCR successful; human pixel review
        // and exact visible HWND-scoped native labels are both still required.
        AssertManualLabelExceptions(missing, original.Text, result.Text);
        return new(original.Text, result.Text, factor, decoder.PixelWidth, decoder.PixelHeight,
            transform.ScaledWidth, transform.ScaledHeight, missing);
    }

    internal static void AssertManualLabelExceptions(string[] missingLabels, string originalText, string scaledText)
    {
        static bool HasWelcomeTitleAmbiguity(string text) =>
            $" {text} ".Contains(" Set up OpenCIaw ", StringComparison.Ordinal);

        foreach (var label in missingLabels)
            Assert.True(label is "Set up your AI" or "Set up a local model" ||
                label == "Set up OpenClaw" &&
                HasWelcomeTitleAmbiguity(originalText) && HasWelcomeTitleAmbiguity(scaledText),
                $"OCR did not verify expected label: {label}");
    }

    internal static async Task<T> RunOcrPassAsync<T>(
        Func<CancellationToken, Task<T>> recognize, TimeProvider? timeProvider = null)
    {
        using var timeout = new CancellationTokenSource(OcrPassTimeout, timeProvider ?? TimeProvider.System);
        try { return await recognize(timeout.Token); }
        catch (OperationCanceledException) when (timeout.IsCancellationRequested)
        {
            throw new TimeoutException("Native-window proof OCR exceeded its 30-second pass deadline.");
        }
    }

    private static SourceIdentity ReadSourceIdentity()
    {
        var repo = Environment.GetEnvironmentVariable("OPENCLAW_REPO_ROOT")
            ?? throw new InvalidOperationException("Set OPENCLAW_REPO_ROOT for exact-source native proof.");
        string Git(params string[] arguments)
        {
            var start = new ProcessStartInfo("git") { WorkingDirectory = repo, RedirectStandardOutput = true, UseShellExecute = false, CreateNoWindow = true };
            foreach (var argument in arguments) start.ArgumentList.Add(argument);
            using var process = Process.Start(start)!;
            var text = process.StandardOutput.ReadToEnd();
            Assert.True(process.WaitForExit(5000), "Local source identity query timed out.");
            Assert.Equal(0, process.ExitCode);
            return text;
        }
        var head = Git("rev-parse", "HEAD").Trim();
        var status = Git("status", "--porcelain=v1", "-z");
        var files = Git("ls-files", "-z", "--cached", "--others", "--exclude-standard")
            .Split('\0', StringSplitOptions.RemoveEmptyEntries).Distinct().Order(StringComparer.Ordinal)
            .Select(relative =>
            {
                var path = Path.Combine(repo, relative.Replace('/', Path.DirectorySeparatorChar));
                return new { path = relative, sha256 = File.Exists(path) ? Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(path))) : "deleted" };
            }).ToArray();
        var binaries = new[] { typeof(UIThreadFixture).Assembly.Location,
            typeof(OpenClaw.SetupEngine.UI.Controls.OnboardingMascot).Assembly.Location,
            typeof(OpenClaw.SetupEngine.SetupAccessDraft).Assembly.Location,
            typeof(NativeProofLayout).Assembly.Location }
            .Select(path => new { path, sha256 = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(path))) }).ToArray();
        var freeze = Environment.GetEnvironmentVariable("OPENCLAW_UI_PROOF_FREEZE_DIR");
        var expectedManifestSha = Environment.GetEnvironmentVariable("OPENCLAW_UI_PROOF_MANIFEST_SHA256");
        Assert.False(string.IsNullOrWhiteSpace(freeze), "Set OPENCLAW_UI_PROOF_FREEZE_DIR to the reviewed source/build freeze.");
        Assert.False(string.IsNullOrWhiteSpace(expectedManifestSha), "Set OPENCLAW_UI_PROOF_MANIFEST_SHA256 to its coordinator-verified SHA256.");
        Assert.True(Path.IsPathFullyQualified(freeze!));
        var manifestPath = Path.Combine(freeze!, "manifest.json");
        Assert.Equal(expectedManifestSha!.ToUpperInvariant(), Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(manifestPath))));
        using var manifest = JsonDocument.Parse(File.ReadAllText(manifestPath));
        Assert.Equal(head, manifest.RootElement.GetProperty("head").GetString());
        var sourcePath = Path.Combine(freeze!, "full-source-manifest.json");
        var buildPath = Path.Combine(freeze!, "build-manifest.json");
        Assert.Equal(manifest.RootElement.GetProperty("fullSourceManifestSha").GetString(),
            Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(sourcePath))));
        Assert.Equal(manifest.RootElement.GetProperty("buildManifestSha").GetString(),
            Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(buildPath))));
        using var sourceManifest = JsonDocument.Parse(File.ReadAllText(sourcePath));
        var expectedSource = sourceManifest.RootElement.EnumerateArray().ToDictionary(
            entry => entry.GetProperty("path").GetString()!.Replace('\\', '/'),
            entry => entry.GetProperty("sha256").GetString()!, StringComparer.Ordinal);
        Assert.Equal(expectedSource.Keys.Order(StringComparer.Ordinal), files.Select(file => file.path));
        foreach (var file in files) Assert.Equal(expectedSource[file.path], file.sha256);
        using var buildManifest = JsonDocument.Parse(File.ReadAllText(buildPath));
        foreach (var binary in binaries)
        {
            var expected = Assert.Single(buildManifest.RootElement.EnumerateArray(), entry =>
                entry.GetProperty("path").GetString() == @"build\ui-tests\" + Path.GetFileName(binary.path));
            Assert.Equal(expected.GetProperty("sha256").GetString(), binary.sha256);
        }
        var json = JsonSerializer.Serialize(new { repo, head, status, files, binaries, freeze, expectedManifestSha });
        return new(head, Convert.ToHexString(SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(json))), json);
    }

    private static bool IsWithin(string path, string root) =>
        Path.GetFullPath(path).TrimEnd(Path.DirectorySeparatorChar).Equals(Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar), StringComparison.OrdinalIgnoreCase) ||
        Path.GetFullPath(path).StartsWith(Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase);
    private static IntPtr Handle(Window window) => WinRT.Interop.WindowNative.GetWindowHandle(window);

    private sealed record NativeDpiMeasurement(string Context, int Awareness, uint WindowDpi,
        Rectangle WindowBounds, Rectangle ClientBounds);
    private sealed record DpiEvidence(string ThreadContextBefore, int ThreadAwarenessBefore,
        string WindowContext, int WindowAwareness, bool WindowPerMonitorV2,
        NativeDpiMeasurement CreationContext, NativeDpiMeasurement PerMonitorV2Context,
        uint MonitorScalePercent, double XamlScale, double XamlWidth, double XamlHeight);

    private static DpiEvidence ReadDpiEvidence(Window window)
    {
        var handle = Handle(window);
        AssertOwned(handle);
        var thread = GetThreadDpiAwarenessContext();
        var creation = GetWindowDpiAwarenessContext(handle);
        Assert.NotEqual(IntPtr.Zero, creation);
        NativeDpiMeasurement Measure(IntPtr context)
        {
            using var scope = new DpiContext(context);
            Assert.True(GetWindowRect(handle, out var bounds));
            Assert.True(GetClientRect(handle, out var client));
            var origin = new NativePoint();
            Assert.True(ClientToScreen(handle, ref origin));
            return new($"0x{GetThreadDpiAwarenessContext():X}",
                GetAwarenessFromDpiAwarenessContext(GetThreadDpiAwarenessContext()), GetDpiForWindow(handle),
                bounds.Rectangle, new Rectangle(origin.X, origin.Y, client.Right - client.Left, client.Bottom - client.Top));
        }
        var atCreation = Measure(creation);
        var physical = Measure(new IntPtr(-4));
        uint monitorScale;
        using (var scope = new DpiContext())
            Assert.Equal(0, GetScaleFactorForMonitor(MonitorFromWindow(handle, 2), out monitorScale));
        Assert.True(AreDpiAwarenessContextsEqual(thread, GetThreadDpiAwarenessContext()),
            "Synchronous DPI measurement must restore the calling thread context.");
        var xaml = Assert.IsAssignableFrom<FrameworkElement>(window.Content).XamlRoot;
        return new($"0x{thread:X}", GetAwarenessFromDpiAwarenessContext(thread),
            $"0x{creation:X}", GetAwarenessFromDpiAwarenessContext(creation),
            AreDpiAwarenessContextsEqual(creation, new IntPtr(-4)), atCreation, physical, monitorScale,
            xaml.RasterizationScale, xaml.Size.Width, xaml.Size.Height);
    }

    private sealed record SourceIdentity(string Head, string ManifestSha256, string Json);
    internal sealed record Frame(Bitmap Bitmap, Rectangle Bounds, Rectangle ClientBounds, Rectangle ContentBounds,
        uint Dpi, double RasterizationScale) : IDisposable
    {
        public void Dispose() => Bitmap.Dispose();
    }
    private sealed class DpiContext : IDisposable
    {
        private readonly IntPtr _previous;
        private readonly uint _thread = GetCurrentThreadId();
        public DpiContext() : this(new IntPtr(-4)) { }
        public DpiContext(IntPtr context)
        {
            _previous = SetThreadDpiAwarenessContext(context);
            Assert.NotEqual(IntPtr.Zero, _previous);
            Assert.True(AreDpiAwarenessContextsEqual(context, GetThreadDpiAwarenessContext()));
        }
        public void Dispose()
        {
            Assert.Equal(_thread, GetCurrentThreadId());
            Assert.NotEqual(IntPtr.Zero, SetThreadDpiAwarenessContext(_previous));
        }
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct NativeBounds
    {
        public int Left, Top, Right, Bottom;
        public readonly Rectangle Rectangle => Rectangle.FromLTRB(Left, Top, Right, Bottom);
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct NativePoint { public int X, Y; }
    [StructLayout(LayoutKind.Sequential)]
    private struct MonitorInfo { public int Size; public NativeBounds Monitor, Work; public uint Flags; }
    [StructLayout(LayoutKind.Explicit, Size = 40)]
    private struct NativeInput
    {
        [FieldOffset(0)] public uint Type;
        [FieldOffset(8)] public MouseInput Mouse;
        [FieldOffset(8)] public KeyboardInput Keyboard;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct MouseInput { public int X, Y; public uint Data, Flags, Time; public nuint ExtraInfo; }
    [StructLayout(LayoutKind.Sequential)]
    private struct KeyboardInput { public ushort VirtualKey, ScanCode; public uint Flags, Time; public nuint ExtraInfo; }
    private delegate bool EnumWindowsCallback(IntPtr window, IntPtr parameter);
    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowsCallback callback, IntPtr parameter);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] private static extern bool IsIconic(IntPtr window);
    [DllImport("user32.dll")] private static extern bool IsZoomed(IntPtr window);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
    [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr window, out NativeBounds bounds);
    [DllImport("user32.dll")] private static extern bool GetClientRect(IntPtr window, out NativeBounds bounds);
    [DllImport("user32.dll")] private static extern bool ClientToScreen(IntPtr window, ref NativePoint point);
    [DllImport("user32.dll")] private static extern bool PrintWindow(IntPtr window, IntPtr dc, uint flags);
    [DllImport("user32.dll", SetLastError = true)] private static extern bool SetProcessDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")] private static extern IntPtr GetDpiAwarenessContextForProcess(IntPtr process);
    [DllImport("user32.dll")] private static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")] private static extern IntPtr GetThreadDpiAwarenessContext();
    [DllImport("user32.dll")] private static extern IntPtr GetWindowDpiAwarenessContext(IntPtr window);
    [DllImport("user32.dll")] private static extern int GetAwarenessFromDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")] private static extern bool AreDpiAwarenessContextsEqual(IntPtr first, IntPtr second);
    [DllImport("kernel32.dll")] private static extern uint GetCurrentThreadId();
    [DllImport("shcore.dll")] private static extern int GetScaleFactorForMonitor(IntPtr monitor, out uint scale);
    [DllImport("user32.dll")] private static extern uint GetDpiForWindow(IntPtr window);
    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr window);
    [DllImport("user32.dll")] private static extern bool BringWindowToTop(IntPtr window);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetClassName(
        IntPtr window, StringBuilder className, int maxCount);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowText(
        IntPtr window, StringBuilder title, int maxCount);
    [DllImport("user32.dll")] private static extern IntPtr WindowFromPoint(NativePoint point);
    [DllImport("user32.dll")] private static extern IntPtr GetAncestor(IntPtr window, uint flags);
    [DllImport("user32.dll")] private static extern int GetSystemMetrics(int index);
    [DllImport("user32.dll")] private static extern bool GetCursorPos(out NativePoint point);
    [DllImport("user32.dll")] private static extern uint SendInput(uint count, NativeInput[] input, int size);
    [DllImport("user32.dll")] private static extern IntPtr MonitorFromWindow(IntPtr window, uint flags);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern bool GetMonitorInfo(IntPtr monitor, ref MonitorInfo info);
    [DllImport("dwmapi.dll")] private static extern int DwmFlush();
    [DllImport("dwmapi.dll")] private static extern int DwmGetWindowAttribute(IntPtr window, uint attribute, out int value, int size);
}
