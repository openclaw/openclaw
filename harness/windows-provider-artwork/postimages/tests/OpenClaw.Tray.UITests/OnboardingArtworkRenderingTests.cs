using System.Runtime.InteropServices.WindowsRuntime;
using System.Diagnostics;
using System.Reflection;
using System.Security.Cryptography;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Media.Imaging;
using Microsoft.UI.Xaml.Shapes;
using OpenClaw.SetupEngine;
using OpenClaw.SetupEngine.UI.Controls;
using OpenClaw.TestSupport;
using Windows.Graphics.Imaging;
using Windows.Storage.Streams;
using Xunit.Abstractions;

namespace OpenClaw.Tray.UITests;

[Collection(UICollection.Name)]
public sealed class OnboardingArtworkRenderingTests(UIThreadFixture ui, ITestOutputHelper output)
{
    [Theory]
    [InlineData(ElementTheme.Light)]
    [InlineData(ElementTheme.Dark)]
    public async Task EveryMascotMood_RendersNativeVectorPixelsWithoutAnimation(ElementTheme theme)
    {
        await ui.ResetContainerAsync();
        await ui.RunOnUIAsync(async () =>
        {
            ui.Container.RequestedTheme = theme;
            var gallery = new StackPanel { Width = 640, Spacing = 12, Padding = new Thickness(16) };
            gallery.Background = new SolidColorBrush(
                theme == ElementTheme.Dark ? Microsoft.UI.Colors.Black : Microsoft.UI.Colors.White);
            gallery.Children.Add(new TextBlock
            {
                Text = $"OpenClaw onboarding: {theme}, animation disabled",
                TextWrapping = TextWrapping.Wrap,
            });
            var rows = new Grid { ColumnSpacing = 8, RowSpacing = 8 };
            for (var column = 0; column < 4; column++)
                rows.ColumnDefinitions.Add(new ColumnDefinition());
            for (var row = 0; row < 3; row++)
                rows.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
            var moods = Enum.GetValues<OnboardingMascotMood>();
            List<OnboardingMascot> mascots = [];
            for (var index = 0; index < moods.Length; index++)
            {
                var mascot = new OnboardingMascot
                {
                    Mood = moods[index],
                    IsAnimationEnabled = false,
                };
                mascots.Add(mascot);
                var cell = new StackPanel { Spacing = 4 };
                cell.Children.Add(mascot);
                cell.Children.Add(new TextBlock
                {
                    Text = moods[index].ToString(),
                    HorizontalAlignment = HorizontalAlignment.Center,
                });
                Grid.SetColumn(cell, index % 4);
                Grid.SetRow(cell, index / 4);
                rows.Children.Add(cell);
            }
            gallery.Children.Add(rows);
            ui.Container.Children.Add(gallery);
            ui.Container.UpdateLayout();
            await ui.YieldToRenderAsync();

            foreach (var mascot in mascots)
            {
                Assert.True(TestSupport.FindDescendants<Shape>(mascot).Count() >= 10,
                    $"{mascot.Mood} should use independently drawn vector parts.");
                var bitmap = new RenderTargetBitmap();
                await bitmap.RenderAsync(mascot);
                var scale = mascot.XamlRoot.RasterizationScale;
                Assert.Equal(NativeProofLayout.PhysicalPixels(mascot.ActualWidth, scale), bitmap.PixelWidth);
                Assert.Equal(NativeProofLayout.PhysicalPixels(mascot.ActualHeight, scale), bitmap.PixelHeight);
                var pixels = (await bitmap.GetPixelsAsync()).ToArray();
                var coloredPixels = 0;
                for (var offset = 0; offset < pixels.Length; offset += 4)
                {
                    if (pixels[offset + 3] > 0 &&
                        pixels[offset + 2] > pixels[offset + 1] + 20 &&
                        pixels[offset + 2] > pixels[offset] + 20)
                        coloredPixels++;
                }
                Assert.True(coloredPixels > 100, $"{mascot.Mood} rendered no visible coral body.");
            }
            await SaveProofAsync(gallery, $"onboarding-mascot-{theme.ToString().ToLowerInvariant()}", output);
            ui.Container.Children.Clear();
        });
    }

    [Theory]
    [InlineData(ElementTheme.Light)]
    [InlineData(ElementTheme.Dark)]
    public async Task MountedMascot_SeededFramesRenderInteractionAndAccessoryChannels(ElementTheme theme)
    {
        await ui.ResetContainerAsync();
        await ui.RunOnUIAsync(async () =>
        {
            var mascot = new OnboardingMascot { IsAnimationEnabled = false, RequestedTheme = theme };
            ui.Container.Children.Add(mascot);
            await TestSupport.WaitForRenderedConditionAsync(() => mascot.IsLoaded, "seeded mascot Loaded");
            ui.Container.UpdateLayout();
            await ui.YieldToRenderAsync();
            OnboardingNativeProof.AssertHeroLayout(mascot, output);
            Assert.Equal(180, mascot.Width);

            // Drive the production animator/drawing with deterministic elapsed time, without
            // overriding Windows' preference or waiting for a wall-clock gesture schedule.
            var animator = Field(mascot, "_animator")!;
            var drawing = Field(mascot, "_drawing")!;
            var advance = animator.GetType().GetMethod("Advance")!;
            var render = drawing.GetType().GetMethod("Render")!;
            var tap = animator.GetType().GetMethod("HandleTap")!;
            async Task<byte[]> Frame(double seconds)
            {
                var pose = advance.Invoke(animator, [TimeSpan.FromSeconds(seconds), true]);
                render.Invoke(drawing, [pose]);
                await ui.YieldToRenderAsync();
                var bitmap = new RenderTargetBitmap();
                await bitmap.RenderAsync(mascot);
                return (await bitmap.GetPixelsAsync()).ToArray();
            }

            var idle = await Frame(0);
            tap.Invoke(animator, null);
            tap.Invoke(animator, null);
            tap.Invoke(animator, null);
            await Frame(0.1);
            await Frame(0.1);
            var hearts = await Frame(0.1);
            AssertDifferentPixels(idle, hearts);
            tap.Invoke(animator, null);
            tap.Invoke(animator, null);
            tap.Invoke(animator, null);
            await Frame(0.1);
            await Frame(0.1);
            var dizzy = await Frame(0.1);
            AssertDifferentPixels(hearts, dizzy);
            animator.GetType().GetMethod("SetAccessory")!.Invoke(animator, [OnboardingMascotAccessory.GradCap]);
            for (var i = 0; i < 6; i++)
                await Frame(0.1);
            var gradCap = await Frame(0);
            AssertDifferentPixels(dizzy, gradCap);
            mascot.Mood = OnboardingMascotMood.Sleepy;
            var sleepy = await Frame(0.1);
            AssertDifferentPixels(idle, sleepy);
            ui.Container.Children.Clear();
        });
    }

    [Fact]
    public async Task MountedMascot_PauseVisibilityAndUnloadStopTimerAndReleaseGlow()
    {
        await ui.ResetContainerAsync();
        await ui.RunOnUIAsync(async () =>
        {
            var host = new Grid();
            var mascot = new OnboardingMascot { IsAnimationEnabled = false };
            host.Children.Add(mascot);
            ui.Container.Children.Add(host);
            await TestSupport.WaitForRenderedConditionAsync(() => mascot.IsLoaded, "lifecycle mascot Loaded");
            ui.Container.UpdateLayout();
            await ui.YieldToRenderAsync();
            var timer = Assert.IsType<DispatcherTimer>(Field(mascot, "_timer"));
            Assert.False(timer.IsEnabled);
            Assert.NotNull(Field(mascot, "_heroGlow"));
            var animator = Field(mascot, "_animator")!;
            var elapsed = animator.GetType().GetProperty("ElapsedSeconds")!;
            var before = elapsed.GetValue(animator);
            mascot.SetPointerGaze(1, -1);
            await OnboardingNativeProof.NextCompositionAsync(TimeSpan.FromMilliseconds(200));
            Assert.Equal(before, elapsed.GetValue(animator));
            mascot.IsAnimationEnabled = true;
            if (!new Windows.UI.ViewManagement.UISettings().AnimationsEnabled)
                Assert.False(timer.IsEnabled);
            host.Visibility = Visibility.Collapsed;
            Assert.False(timer.IsEnabled);
            host.Visibility = Visibility.Visible;
            ui.Container.Children.Clear();
            await TestSupport.WaitForRenderedConditionAsync(() => !mascot.IsLoaded, "lifecycle mascot Unloaded");
            await ui.YieldToRenderAsync();
            Assert.Null(Field(mascot, "_timer"));
            Assert.Null(Field(mascot, "_heroGlow"));
            Assert.False(timer.IsEnabled);
        });
    }

    [Fact]
    public async Task MountedMascot_HighContrastSuppressesGlowAndAllNewBrushesUseSystemColors()
    {
        await ui.ResetContainerAsync();
        await ui.RunOnUIAsync(async () =>
        {
            var mascot = new OnboardingMascot
            {
                Mood = OnboardingMascotMood.Sleepy, Accessory = OnboardingMascotAccessory.GradCap,
                IsAnimationEnabled = false,
            };
            ui.Container.Children.Add(mascot);
            await TestSupport.WaitForRenderedConditionAsync(() => mascot.IsLoaded, "high contrast mascot Loaded");
            ui.Container.UpdateLayout();
            await ui.YieldToRenderAsync();
            var drawing = Field(mascot, "_drawing")!;
            drawing.GetType().GetMethod("SetPalette")!.Invoke(drawing, [false, true]);
            var glow = Field(mascot, "_heroGlow")!;
            glow.GetType().GetMethod("SetPalette")!.Invoke(glow, [false, true]);
            var visual = Field(glow, "_visual")!;
            Assert.Equal(false, visual.GetType().GetProperty("IsVisible")!.GetValue(visual));
            var settings = new Windows.UI.ViewManagement.UISettings();
            var colors = new[]
            {
                settings.UIElementColor(Windows.UI.ViewManagement.UIElementType.WindowText),
                settings.UIElementColor(Windows.UI.ViewManagement.UIElementType.Window),
                settings.UIElementColor(Windows.UI.ViewManagement.UIElementType.Highlight),
            };
            foreach (var name in new[] { "_blushFill", "_heartFill", "_capBlue", "_bandBlue", "_capOutline", "_gradFill", "_gradOutline", "_sweatFill" })
                Assert.Contains(Assert.IsType<SolidColorBrush>(Field(drawing, name)).Color, colors);
            ui.Container.Children.Clear();
        });
    }

    private static object? Field(object instance, string name) => instance.GetType().GetField(name,
        System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Instance)!.GetValue(instance);

    private static void AssertDifferentPixels(byte[] first, byte[] second)
    {
        Assert.Equal(first.Length, second.Length);
        var changed = 0;
        for (var offset = 0; offset < first.Length; offset += 4)
            if (!first.AsSpan(offset, 4).SequenceEqual(second.AsSpan(offset, 4)))
                changed++;
        Assert.True(changed > 20, $"Expected rendered pose changes, found {changed} changed pixels.");
    }

    [Fact]
    public async Task MountedMascots_AllEffectsKeepDistinctStableGeometryAndRenderNonblank()
    {
        await ui.ResetContainerAsync();
        await ui.RunOnUIAsync(async () =>
        {
            var gallery = new StackPanel { Orientation = Orientation.Horizontal };
            var mascots = new[] { new OnboardingMascot(), new OnboardingMascot() };
            foreach (var mascot in mascots)
            {
                mascot.IsAnimationEnabled = false;
                gallery.Children.Add(mascot);
            }
            try
            {
                ui.Container.Children.Add(gallery);
                ui.Container.UpdateLayout();
                await ui.YieldToRenderAsync();
                var paths = mascots.SelectMany(TestSupport.FindDescendants<Microsoft.UI.Xaml.Shapes.Path>).ToArray();
                Assert.True(paths.Length >= 20);
                var original = paths.Select(path => Assert.IsAssignableFrom<Geometry>(path.Data)).ToArray();
                Assert.Equal(original.Length, original.Distinct(ReferenceEqualityComparer.Instance).Count());
                var drawings = mascots.Select(mascot => Field(mascot, "_drawing")!).ToArray();
                var render = drawings[0].GetType().GetMethod("Render")!;
                var poseType = render.GetParameters()[0].ParameterType;
                var effectProperty = poseType.GetProperty("Effect")!;
                var effects = Enum.GetValues(effectProperty.PropertyType);
                Assert.Contains("Hearts", effects.Cast<object>().Select(effect => effect.ToString()));
                Assert.Contains("Sparks", effects.Cast<object>().Select(effect => effect.ToString()));
                // Two complete passes exercise None after every active effect, not just construction.
                for (var pass = 0; pass < 2; pass++)
                    foreach (var effect in effects)
                    {
                        foreach (var drawing in drawings)
                        {
                            var pose = poseType.GetMethod("Static")!.Invoke(null, [OnboardingMascotMood.Idle])!;
                            effectProperty.SetValue(pose, effect);
                            poseType.GetProperty("EffectPhase")!.SetValue(pose, 0.25 + pass * 0.25);
                            render.Invoke(drawing, [pose]);
                        }
                        await ui.YieldToRenderAsync();
                        for (var index = 0; index < paths.Length; index++)
                            Assert.Same(original[index], paths[index].Data);
                        Assert.Equal(paths.Length, paths.Select(path => path.Data).Distinct(ReferenceEqualityComparer.Instance).Count());
                        foreach (var mascot in mascots)
                        {
                            var bitmap = new RenderTargetBitmap();
                            await bitmap.RenderAsync(mascot, 182, 182);
                            var pixels = (await bitmap.GetPixelsAsync()).ToArray();
                            Assert.True(Enumerable.Range(0, pixels.Length / 4).Count(index =>
                                pixels[index * 4 + 3] > 0 && pixels[index * 4 + 2] > pixels[index * 4 + 1] + 20 &&
                                pixels[index * 4 + 2] > pixels[index * 4] + 20) > 100,
                                $"{effect}, pass {pass}: mounted drawing lost its coral body.");
                        }
                    }
            }
            finally { ui.Container.Children.Clear(); }
        });
    }

    [Theory]
    [InlineData(ElementTheme.Light)]
    [InlineData(ElementTheme.Dark)]
    [Trait("Category", "NativeOnboardingProof")]
    public async Task NativeMascot_LiveTimerPointerTapsAndAccessoriesChangeComposedPixels(ElementTheme theme)
    {
        await WithNativeMascotWindowAsync(theme, animation: true, async (window, mascot) =>
        {
            Assert.True(new Windows.UI.ViewManagement.UISettings().AnimationsEnabled,
                "Live motion proof requires Windows animations enabled. The test will not override the system preference.");
            var timer = Assert.IsType<DispatcherTimer>(Field(mascot, "_timer"));
            Assert.True(timer.IsEnabled, "The production Loaded path must start its normal timer.");
            var animator = Field(mascot, "_animator")!;
            var drawing = Field(mascot, "_drawing")!;
            var elapsed = animator.GetType().GetProperty("ElapsedSeconds")!;
            double Time() => Assert.IsType<double>(elapsed.GetValue(animator));
            var started = Stopwatch.StartNew();
            var moved = 0;
            var tapped = 0;
            mascot.PointerMoved += (_, _) => moved++;
            mascot.AddHandler(UIElement.TappedEvent,
                new Microsoft.UI.Xaml.Input.TappedEventHandler((_, _) => tapped++), true);
            var frames = new List<OnboardingNativeProof.Frame>();
            async Task<OnboardingNativeProof.Frame> Sample(string step)
            {
                Assert.True(started.Elapsed < TimeSpan.FromSeconds(15), "Live sample timeline exceeded its 15-second budget.");
                Assert.True(timer.IsEnabled);
                var snapshot = MascotChannels(mascot);
                var frame = await OnboardingNativeProof.CaptureAsync(window,
                    $"onboarding-live-{theme}-{frames.Count:D2}-{step}", output,
                    ["Live native mascot", "Owned window proof"], snapshot);
                frames.Add(frame);
                return frame;
            }
            try
            {
                var initialTime = Time();
                var initial = await Sample("idle");
                var region = OnboardingNativeProof.ClientPixels(window, mascot, initial);
                var initialFloat = Assert.IsType<TranslateTransform>(Field(drawing, "_float")).Y;
                await OnboardingNativeProof.NextCompositionAsync(TimeSpan.FromMilliseconds(350));
                Assert.NotEqual(initialFloat, Assert.IsType<TranslateTransform>(Field(drawing, "_float")).Y);
                var breathing = await Sample("live-idle");
                OnboardingNativeProof.AssertChanged(initial, breathing, region);
                OnboardingNativeProof.MovePointer(window, mascot, 32, 50);
                await OnboardingNativeProof.NextCompositionAsync(TimeSpan.FromMilliseconds(400));
                Assert.True(moved > 0, "Real SendInput must reach the production PointerMoved handler.");
                var gaze = EyeGaze(drawing);
                Assert.True(gaze.X < -0.1 && gaze.Y < -0.1);
                var left = await Sample("pointer-left");
                Assert.True(Time() > initialTime, "ElapsedSeconds must advance through the production DispatcherTimer.");
                OnboardingNativeProof.AssertChanged(initial, left, region);
                OnboardingNativeProof.MovePointer(window, mascot, 150, 50);
                await OnboardingNativeProof.NextCompositionAsync(TimeSpan.FromMilliseconds(400));
                Assert.True(gaze.X > 0.1 && gaze.Y < -0.1);
                var right = await Sample("pointer-right");
                var eyes = System.Drawing.Rectangle.FromLTRB(region.Left + region.Width * 25 / 100,
                    region.Top + region.Height * 25 / 100, region.Left + region.Width * 75 / 100,
                    region.Top + region.Height * 50 / 100);
                OnboardingNativeProof.AssertChanged(left, right, eyes);

                // Widely separated targets avoid DoubleTapped recognition without altering OS settings.
                for (var index = 0; index < 3; index++)
                {
                    var x = index % 2 == 0 ? 40d : 140d;
                    OnboardingNativeProof.MovePointer(window, mascot, x, 95);
                    await OnboardingNativeProof.NextCompositionAsync();
                    OnboardingNativeProof.TapPointer(window, mascot, x, 95);
                    await OnboardingNativeProof.NextCompositionAsync(TimeSpan.FromMilliseconds(180));
                    Assert.Equal(index + 1, tapped);
                    Assert.Equal(index + 1, Assert.IsType<int>(Field(animator, "_tapCount")));
                }
                Assert.Equal("HeartBurst", animator.GetType().GetProperty("ActiveGesture",
                    BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(animator)!.ToString());
                Assert.Contains(Assert.IsType<Microsoft.UI.Xaml.Shapes.Path[]>(Field(drawing, "_hearts")), path => path.Opacity > 0.05);
                var hearts = await Sample("real-tap-hearts");
                OnboardingNativeProof.AssertChanged(right, hearts, region);
                Assert.True(CountChannelPixels(hearts, region, IsHeartPixel) >= 10,
                    "Actual composed heart-pink pixels must render; body motion or internal opacity is not heart proof.");
                var capRegion = System.Drawing.Rectangle.FromLTRB(region.Left + region.Width / 4, region.Top,
                    region.Right - region.Width / 4, region.Top + region.Height / 3);
                Assert.True(CountChannelPixels(hearts, capRegion, IsGraduationCapPixel) < 10);
                mascot.Accessory = OnboardingMascotAccessory.GradCap;
                await OnboardingNativeProof.NextCompositionAsync(TimeSpan.FromMilliseconds(650));
                Assert.InRange(Assert.IsType<Canvas>(Field(drawing, "_gradCap")).Opacity, 0.99, 1);
                var grad = await Sample("grad-cap");
                OnboardingNativeProof.AssertChanged(hearts, grad, capRegion);
                Assert.True(CountChannelPixels(grad, capRegion, IsGraduationCapPixel) >= 25,
                    "The graduation cap must paint its distinct slate crown above the eyes.");
                Assert.True(CountChannelPixels(grad, capRegion, IsNightcapPixel) < 10);
                mascot.Accessory = OnboardingMascotAccessory.Nightcap;
                await OnboardingNativeProof.NextCompositionAsync(TimeSpan.FromMilliseconds(650));
                Assert.InRange(Assert.IsType<Canvas>(Field(drawing, "_nightcap")).Opacity, 0.99, 1);
                Assert.Equal(0, Assert.IsType<Canvas>(Field(drawing, "_gradCap")).Opacity);
                var night = await Sample("night-cap");
                OnboardingNativeProof.AssertChanged(grad, night, capRegion);
                Assert.True(CountChannelPixels(night, capRegion, IsNightcapPixel) >= 25,
                    "The nightcap must paint its blue crown, not merely change the moving head below.");
                Assert.True(CountChannelPixels(night, capRegion, IsGraduationCapPixel) < 10,
                    "Replacing the graduation cap must remove its composed slate pixels.");
                Assert.True(Time() - initialTime > 1);
                Assert.True(started.Elapsed < TimeSpan.FromSeconds(15), "Live sample timeline exceeded its 15-second budget.");
                OnboardingNativeProof.AssertSourceUnchanged();
            }
            finally
            {
                foreach (var frame in frames) frame.Dispose();
            }
        });
    }

    [Theory]
    [InlineData(ElementTheme.Light)]
    [InlineData(ElementTheme.Dark)]
    [Trait("Category", "NativeOnboardingProof")]
    public async Task NativeMascot_StaticReferenceProvesCoralCompositorHaloOutsideSilhouette(ElementTheme theme)
    {
        await WithNativeMascotWindowAsync(theme, animation: false, async (window, mascot) =>
        {
            Assert.False(new Windows.UI.ViewManagement.AccessibilitySettings().HighContrast,
                "Coral halo proof requires a non-high-contrast desktop. High contrast must suppress glow.");
            var timer = Assert.IsType<DispatcherTimer>(Field(mascot, "_timer"));
            Assert.False(timer.IsEnabled);
            var glow = Field(mascot, "_heroGlow")!;
            var visual = Assert.IsAssignableFrom<Microsoft.UI.Composition.Visual>(Field(glow, "_visual"));
            Assert.True(visual.IsVisible);
            var originalVisibility = visual.IsVisible;
            try
            {
                // Only this static reference toggles the existing composition visual. The live
                // test above never disables motion, advances the animator or calls input handlers.
                visual.IsVisible = false;
                using var baseline = await OnboardingNativeProof.CaptureAsync(window, $"onboarding-halo-{theme}-off", output,
                    ["Static halo reference", "Owned window proof"], new { glow = false, channels = MascotChannels(mascot) });
                var region = OnboardingNativeProof.ClientPixels(window, mascot, baseline);
                visual.IsVisible = true;
                using var glowing = await OnboardingNativeProof.CaptureAsync(window, $"onboarding-halo-{theme}-on", output,
                    ["Static halo reference", "Owned window proof"], new { glow = true, channels = MascotChannels(mascot) });
                visual.IsVisible = false;
                using var recovered = await OnboardingNativeProof.CaptureAsync(window, $"onboarding-halo-{theme}-off-again", output,
                    ["Static halo reference", "Owned window proof"], new { glow = false, channels = MascotChannels(mascot) });
                Assert.Equal(baseline.Bounds, glowing.Bounds);
                Assert.Equal(baseline.Bounds, recovered.Bounds);
                var halo = AssertCoralHalo(baseline, glowing, recovered, region, theme);
                output.WriteLine($"compositor-halo={System.Text.Json.JsonSerializer.Serialize(halo)}");
                File.WriteAllText(System.IO.Path.Combine(OnboardingNativeProof.RequireProofDirectory(), $"onboarding-halo-{theme}-roi.json"),
                    System.Text.Json.JsonSerializer.Serialize(new { region, halo, baseline.Dpi, baseline.RasterizationScale, method = "empty baseline pixels 2-8 DIPs outside silhouette; off/on/off" }));
                OnboardingNativeProof.AssertSourceUnchanged();
            }
            finally { visual.IsVisible = originalVisibility; }
        });
    }

    private async Task WithNativeMascotWindowAsync(ElementTheme theme, bool animation,
        Func<Window, OnboardingMascot, Task> assertion)
    {
        OnboardingNativeProof.AssertIsolatedRoots();
        OnboardingNativeProof.RequireProofDirectory();
        await ui.RunOnUIAsync(async () =>
        {
            var mascot = new OnboardingMascot { IsAnimationEnabled = animation, RequestedTheme = theme };
            var root = new Grid
            {
                RequestedTheme = theme, Padding = new Thickness(32),
                Background = new SolidColorBrush(theme == ElementTheme.Light ? Microsoft.UI.Colors.White : Microsoft.UI.Colors.Black),
                RowDefinitions = { new() { Height = GridLength.Auto }, new(), new() { Height = GridLength.Auto } },
            };
            root.Children.Add(new TextBlock
            {
                Text = animation ? "Live native mascot" : "Static halo reference", FontSize = 28,
                Foreground = new SolidColorBrush(theme == ElementTheme.Light ? Microsoft.UI.Colors.Black : Microsoft.UI.Colors.White),
            });
            mascot.HorizontalAlignment = HorizontalAlignment.Center;
            mascot.VerticalAlignment = VerticalAlignment.Center;
            Grid.SetRow(mascot, 1);
            root.Children.Add(mascot);
            var footer = new TextBlock
            {
                Text = "Owned window proof", FontSize = 20,
                Foreground = new SolidColorBrush(theme == ElementTheme.Light ? Microsoft.UI.Colors.Black : Microsoft.UI.Colors.White),
            };
            Grid.SetRow(footer, 2);
            root.Children.Add(footer);
            var window = OnboardingNativeProof.CreateWindow(() =>
                new Window { Title = "OpenClaw mascot native proof", Content = root });
            try
            {
                window.AppWindow.Resize(new Windows.Graphics.SizeInt32(720, 620));
                var work = Microsoft.UI.Windowing.DisplayArea.GetFromWindowId(window.AppWindow.Id,
                    Microsoft.UI.Windowing.DisplayAreaFallback.Nearest).WorkArea;
                window.AppWindow.Move(new Windows.Graphics.PointInt32(work.X + 32, work.Y + 32));
                OnboardingNativeProof.ActivateOwned(window);
                await TestSupport.WaitForRenderedConditionAsync(() => mascot.IsLoaded, "native mascot Loaded");
                root.UpdateLayout();
                await OnboardingNativeProof.NextCompositionAsync();
                OnboardingNativeProof.AssertHeroLayout(mascot, output);
                await assertion(window, mascot);
            }
            finally
            {
                output.WriteLine("Input cleanup: no cursor restore to a pre-test external HWND; only the test-owned window is closed.");
                window.Close();
                await ui.YieldToRenderAsync();
                Assert.Null(Field(mascot, "_timer"));
                Assert.Null(Field(mascot, "_heroGlow"));
            }
        });
    }

    private static TranslateTransform EyeGaze(object drawing)
    {
        var eye = Field(drawing, "_leftEye")!;
        return Assert.IsType<TranslateTransform>(eye.GetType().GetProperty("Gaze")!.GetValue(eye));
    }

    private static int CountChannelPixels(OnboardingNativeProof.Frame frame, System.Drawing.Rectangle region,
        Func<System.Drawing.Color, bool> matches)
    {
        var count = 0;
        for (var y = region.Top; y < region.Bottom; y++)
            for (var x = region.Left; x < region.Right; x++)
                if (matches(frame.Bitmap.GetPixel(x, y))) count++;
        return count;
    }

    // These authored colors distinguish the channels from coral body motion and teal eyes.
    private static bool IsHeartPixel(System.Drawing.Color color) =>
        color.R >= 230 && color.G is >= 90 and <= 160 && color.B - color.G >= 18;
    private static bool IsGraduationCapPixel(System.Drawing.Color color) =>
        color.R is >= 20 and <= 42 && color.G is >= 20 and <= 46 && color.B is >= 28 and <= 58 &&
        color.B - color.R >= 5;
    private static bool IsNightcapPixel(System.Drawing.Color color) =>
        color.R is >= 100 and <= 190 && color.G - color.R >= 20 && color.B - color.G >= 15;

    private static object MascotChannels(OnboardingMascot mascot)
    {
        var animator = Field(mascot, "_animator")!;
        var drawing = Field(mascot, "_drawing")!;
        var gaze = EyeGaze(drawing);
        return new
        {
            elapsedSeconds = animator.GetType().GetProperty("ElapsedSeconds")!.GetValue(animator),
            gesture = animator.GetType().GetProperty("ActiveGesture", BindingFlags.NonPublic | BindingFlags.Instance)!.GetValue(animator)?.ToString(),
            tapCount = Field(animator, "_tapCount"),
            bodyFloat = Assert.IsType<TranslateTransform>(Field(drawing, "_float")).Y,
            gazeX = gaze.X, gazeY = gaze.Y,
            hearts = Assert.IsType<Microsoft.UI.Xaml.Shapes.Path[]>(Field(drawing, "_hearts")).Select(path => path.Opacity).ToArray(),
            nightcap = Assert.IsType<Canvas>(Field(drawing, "_nightcap")).Opacity,
            gradCap = Assert.IsType<Canvas>(Field(drawing, "_gradCap")).Opacity,
            timerEnabled = Assert.IsType<DispatcherTimer>(Field(mascot, "_timer")).IsEnabled,
        };
    }

    private static object AssertCoralHalo(OnboardingNativeProof.Frame baseline, OnboardingNativeProof.Frame glowing,
        OnboardingNativeProof.Frame recovered, System.Drawing.Rectangle region, ElementTheme theme)
    {
        var background = theme == ElementTheme.Light ? 255 : 0;
        var mask = new bool[region.Width, region.Height];
        for (var y = 0; y < region.Height; y++)
            for (var x = 0; x < region.Width; x++)
            {
                var pixel = baseline.Bitmap.GetPixel(region.X + x, region.Y + y);
                Assert.Equal(pixel.ToArgb(), recovered.Bitmap.GetPixel(region.X + x, region.Y + y).ToArgb());
                mask[x, y] = Math.Max(Math.Abs(pixel.R - background), Math.Max(Math.Abs(pixel.G - background), Math.Abs(pixel.B - background))) > 12;
            }
        var inner = (int)Math.Ceiling(2 * baseline.RasterizationScale);
        var outer = (int)Math.Ceiling(8 * baseline.RasterizationScale);
        var candidates = 0;
        var coral = 0;
        var left = 0;
        var right = 0;
        for (var y = outer; y < region.Height - outer; y++)
            for (var x = outer; x < region.Width - outer; x++)
            {
                var nearEdge = false;
                var touchesBody = false;
                for (var dy = -outer; dy <= outer; dy++)
                    for (var dx = -outer; dx <= outer; dx++)
                    {
                        if (dx * dx + dy * dy > outer * outer || !mask[x + dx, y + dy]) continue;
                        nearEdge = true;
                        if (dx * dx + dy * dy <= inner * inner) touchesBody = true;
                    }
                if (!nearEdge || touchesBody) continue;
                var before = baseline.Bitmap.GetPixel(region.X + x, region.Y + y);
                if (Math.Abs(before.R - background) > 1 || Math.Abs(before.G - background) > 1 || Math.Abs(before.B - background) > 1) continue;
                candidates++;
                var after = glowing.Bitmap.GetPixel(region.X + x, region.Y + y);
                var red = after.R - before.R;
                var green = after.G - before.G;
                var blue = after.B - before.B;
                if (red - green < 3 || red - blue < 2 || Math.Abs(red) + Math.Abs(green) + Math.Abs(blue) < 4) continue;
                coral++;
                if (x < region.Width / 2) left++; else right++;
            }
        Assert.True(candidates > 100, $"The measured silhouette must expose a useful empty halo ROI, found {candidates} pixels.");
        Assert.True(coral >= 25 && left >= 10 && right >= 10,
            $"Composed coral halo missing outside body/edge: {coral}/{candidates}, left={left}, right={right}. RTB or non-null glow fields are not proof.");
        return new { candidates, coral, left, right, innerRadiusPixels = inner, outerRadiusPixels = outer };
    }

    [Theory]
    [InlineData("claude")]
    [InlineData("codex")]
    [InlineData("gemini")]
    [InlineData("kimi")]
    [InlineData("lmstudio")]
    [InlineData("ollama")]
    [InlineData("opencode")]
    [InlineData("pi")]
    [InlineData("xai")]
    public async Task BundledProviderArtwork_DecodesUsingNativeSvgRuntime(string brand)
    {
        var root = Environment.GetEnvironmentVariable("OPENCLAW_REPO_ROOT")
            ?? throw new InvalidOperationException("Set OPENCLAW_REPO_ROOT for onboarding artwork proof.");
        var path = System.IO.Path.Combine(root, "src", "OpenClaw.Tray.WinUI",
            "Assets", "Setup", "ProviderIcons", $"ProviderIcon-{brand}.svg");
        var bytes = await File.ReadAllBytesAsync(path);
        await ui.RunOnUIAsync(async () =>
        {
            using var stream = new InMemoryRandomAccessStream();
            await stream.WriteAsync(bytes.AsBuffer());
            stream.Seek(0);
            var image = new SvgImageSource { RasterizePixelWidth = 32, RasterizePixelHeight = 32 };
            var status = await image.SetSourceAsync(stream);
            Assert.Equal(SvgImageSourceLoadStatus.Success, status);
        });
    }

    [Theory]
    [InlineData("claude")]
    [InlineData("xai")]
    public async Task ProviderArtwork_LoadsFromTheProductionLibraryQualifiedUri(string brand)
    {
        await ui.ResetContainerAsync();
        await ui.RunOnUIAsync(async () =>
        {
            var result = new TaskCompletionSource<SvgImageSourceLoadStatus>(
                TaskCreationOptions.RunContinuationsAsynchronously);
            var source = new SvgImageSource { RasterizePixelWidth = 32, RasterizePixelHeight = 32 };
            source.Opened += (_, _) => result.TrySetResult(SvgImageSourceLoadStatus.Success);
            source.OpenFailed += (_, args) => result.TrySetResult(args.Status);
            source.UriSource = new Uri(
                $"ms-appx:///OpenClaw.SetupEngine.UI/Assets/Setup/ProviderIcons/ProviderIcon-{brand}.svg");
            ui.Container.Children.Add(new Image { Source = source, Width = 32, Height = 32 });
            ui.Container.UpdateLayout();
            await ui.YieldToRenderAsync();
            var status = await result.Task.WaitAsync(TimeSpan.FromSeconds(10));
            Assert.Equal(SvgImageSourceLoadStatus.Success, status);
            ui.Container.Children.Clear();
        });
    }

    [Theory]
    [InlineData("claude")]
    [InlineData("codex")]
    [InlineData("gemini")]
    [InlineData("kimi")]
    [InlineData("lmstudio")]
    [InlineData("ollama")]
    [InlineData("opencode")]
    [InlineData("pi")]
    [InlineData("xai")]
    public async Task ProviderArtworkControl_LoadsBundledLogoAndClearsItOnSessionClose(string brand)
    {
        await ui.ResetContainerAsync();
        await ui.RunOnUIAsync(async () =>
        {
            using var session = new ProviderArtworkSession();
            var artwork = new ProviderArtwork
            {
                Session = session,
                Descriptor = GatewayAiSetupPresentation.GetProviderArtwork(brand, null, null, ProviderArtworkFallback.Account)
            };
            try
            {
                ui.Container.Children.Add(artwork);
                ui.Container.UpdateLayout();
                await ui.YieldToRenderAsync();
                var image = Assert.IsType<Image>(artwork.FindName("ArtworkImage"));
                var fallback = Assert.IsType<FontIcon>(artwork.FindName("FallbackIcon"));
                await TestSupport.WaitForRenderedConditionAsync(() => fallback.Visibility == Visibility.Collapsed,
                    "bundled provider image through actual artwork control");
                Assert.IsType<SvgImageSource>(image.Source);
                Assert.Equal(Visibility.Visible, image.Visibility);
                Assert.Equal(Visibility.Collapsed, fallback.Visibility);
                session.Dispose();
                Assert.Null(image.Source);
                Assert.Equal(Visibility.Visible, Assert.IsType<FontIcon>(artwork.FindName("FallbackIcon")).Visibility);
            }
            finally
            {
                ui.Container.Children.Clear();
            }
        });
    }

    [Fact]
    public async Task ProviderArtwork_RebindingDetachesThePreviousSessionWithoutClosingTheBorrowedReplacement()
    {
        await ui.ResetContainerAsync();
        await ui.RunOnUIAsync(async () =>
        {
            using var previous = new ProviderArtworkSession();
            using var replacement = new ProviderArtworkSession();
            var artwork = new ProviderArtwork
            {
                Session = previous,
                Descriptor = GatewayAiSetupPresentation.GetProviderArtwork("llama-app", null, null, ProviderArtworkFallback.Install),
            };
            try
            {
                ui.Container.Children.Add(artwork);
                var image = Assert.IsType<Image>(artwork.FindName("ArtworkImage"));
                var fallback = Assert.IsType<FontIcon>(artwork.FindName("FallbackIcon"));
                await TestSupport.WaitForRenderedConditionAsync(
                    () => artwork.IsLoaded && fallback.Visibility == Visibility.Collapsed, "initial artwork decoded");
                artwork.Session = replacement;
                artwork.Descriptor = GatewayAiSetupPresentation.GetProviderArtwork("ollama", null, null, ProviderArtworkFallback.Install);
                await TestSupport.WaitForRenderedConditionAsync(
                    () => fallback.Visibility == Visibility.Collapsed, "replacement artwork decoded");
                var decoded = Assert.IsType<SvgImageSource>(image.Source);
                Assert.EndsWith("/ProviderIcon-ollama.svg", decoded.UriSource.AbsoluteUri);
                previous.Dispose();
                Assert.Same(decoded, image.Source);
                artwork.Session = null;
                Assert.Null(image.Source);
                artwork.Session = replacement;
                await TestSupport.WaitForRenderedConditionAsync(
                    () => fallback.Visibility == Visibility.Collapsed, "borrowed replacement remains usable after detaching");
                var unloaded = false;
                void Unloaded(object sender, RoutedEventArgs args) => unloaded = true;
                artwork.Unloaded += Unloaded;
                try
                {
                    ui.Container.Children.Remove(artwork);
                    await TestSupport.WaitForRenderedConditionAsync(() => unloaded && !artwork.IsLoaded,
                        "artwork Unloaded callback observed");
                }
                finally { artwork.Unloaded -= Unloaded; }
                Assert.Null(image.Source);
                replacement.Dispose();
                Assert.Null(image.Source);
            }
            finally { ui.Container.Children.Clear(); }
        });
    }

    internal static async Task SaveNativeWindowProofAsync(Window window, string name, ITestOutputHelper output,
        FrameworkElement requiredContent)
    {
        var directory = Environment.GetEnvironmentVariable("OPENCLAW_UI_PROOF_DIR");
        if (string.IsNullOrWhiteSpace(directory))
            return;
        using var frame = await OnboardingNativeProof.CaptureAsync(window, name, output,
            ["providerinput", "syntheticproviderprompt", "testcode"], requiredContent: requiredContent);
    }

    internal static async Task SaveProofAsync(FrameworkElement element, string name, ITestOutputHelper output)
    {
        var directory = Environment.GetEnvironmentVariable("OPENCLAW_UI_PROOF_DIR");
        if (string.IsNullOrWhiteSpace(directory))
            return;
        Directory.CreateDirectory(directory);
        var bitmap = new RenderTargetBitmap();
        await bitmap.RenderAsync(element);
        Assert.True(bitmap.PixelWidth > 0 && bitmap.PixelHeight > 0);
        var pixels = (await bitmap.GetPixelsAsync()).ToArray();
        using var stream = new InMemoryRandomAccessStream();
        var encoder = await BitmapEncoder.CreateAsync(BitmapEncoder.PngEncoderId, stream);
        encoder.SetPixelData(BitmapPixelFormat.Bgra8, BitmapAlphaMode.Premultiplied,
            (uint)bitmap.PixelWidth, (uint)bitmap.PixelHeight, 96, 96, pixels);
        await encoder.FlushAsync();
        stream.Seek(0);
        using var reader = new DataReader(stream);
        await reader.LoadAsync(checked((uint)stream.Size));
        var png = new byte[checked((int)stream.Size)];
        reader.ReadBytes(png);
        var path = System.IO.Path.Combine(directory, name + ".png");
        await File.WriteAllBytesAsync(path, png);
        output.WriteLine($"proof={path}; sha256={Convert.ToHexString(SHA256.HashData(png))}");
    }
}
