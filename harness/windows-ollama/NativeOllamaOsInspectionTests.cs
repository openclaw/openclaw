using System.Reflection;
using System.Text.Json;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation.Peers;
using Microsoft.UI.Xaml.Automation.Provider;
using Microsoft.UI.Xaml.Controls;
using OpenClaw.SetupEngine;
using OpenClaw.SetupEngine.UI;
using OpenClaw.SetupEngine.UI.Controls;
using OpenClaw.SetupEngine.UI.Pages;
using OpenClaw.TestSupport;
using Xunit.Abstractions;

namespace OpenClaw.Tray.UITests;

// Test-only overlay. Real production composition and Windows observation; synthetic selected
// Gateway. No installer acquisition, Open, provider mutation, model pull or application quit.
[Collection(UICollection.Name)]
public sealed class NativeOllamaOsInspectionTests(UIThreadFixture ui, ITestOutputHelper output)
{
    [Fact]
    [Trait("Category", "NativeOnboardingProof")]
    public async Task ProductionWindowFactoryInspectsWindowsWithoutAppConsent()
    {
        OnboardingNativeProof.AssertIsolatedRoots();
        using var temp = new TempDirectory("ollama-native-inspect-");
        var config = temp.Combine("setup.json");
        await File.WriteAllTextAsync(config, JsonSerializer.Serialize(new SetupConfig()));
        await ui.RunOnUIAsync(async () =>
        {
            var resources = OnboardingWindowsFlowTests.LoadProgressResources(
                Environment.GetEnvironmentVariable("OPENCLAW_REPO_ROOT")!);
            Application.Current.Resources.MergedDictionaries.Add(resources);
            SetupWindow? window = null;
            try
            {
                window = OnboardingNativeProof.CreateWindow(() => new SetupWindow(configPath: config,
                    dataDir: temp.Combine("data"), localDataDir: temp.Combine("local"),
                    commandLineArgs: [], startupRegistrationAllowed: false));
                var frame = Assert.IsType<Frame>(Assert.IsType<Grid>(window.Content).FindName("RootFrame"));
                var transport = new InspectionTransport();
                // Preserve the actual factory and window-owned access draft. Only the selected
                // Gateway is a secretless fixture; never substitute an IOllamaWindowsAppHost.
                var args = Assert.IsType<AiSetupPageArgs>(typeof(SetupWindow)
                    .GetMethod("CreateAiSetupArgs", BindingFlags.NonPublic | BindingFlags.Instance)!
                    .Invoke(window, null)) with { TransportFactory = () => transport };
                Assert.NotNull(args.OllamaSetupFactory);
                frame.Navigate(typeof(AiSetupPage), args);
                var page = Assert.IsType<AiSetupPage>(frame.Content);
                OnboardingNativeProof.ActivateOwned(window);
                await TestSupport.WaitForRenderedConditionAsync(() => page.IsLoaded &&
                    TestSupport.FindDescendants<SetupActionCard>(Assert.IsType<ItemsControl>(page.FindName("PrepareChoices")))
                        .Any(card => card.IsEnabled), "real factory Ollama card");
                var card = Assert.Single(TestSupport.FindDescendants<SetupActionCard>(
                    Assert.IsType<ItemsControl>(page.FindName("PrepareChoices"))));
                Assert.IsAssignableFrom<IInvokeProvider>(FrameworkElementAutomationPeer.CreatePeerForElement(card)
                    .GetPattern(PatternInterface.Invoke)).Invoke();
                OllamaWindowsSetupDialog? dialog = null;
                await TestSupport.WaitForRenderedConditionAsync(() =>
                {
                    dialog = typeof(AiSetupPage).GetField("_ollamaDialog", BindingFlags.NonPublic | BindingFlags.Instance)!
                        .GetValue(page) as OllamaWindowsSetupDialog;
                    return dialog is { IsLoaded: true } && TestSupport.FindDescendants<TextBlock>(dialog)
                        .Any(text => text.Name == "OllamaAppStatus" && text.Text != "Checking the selected Gateway and this PC…");
                }, "actual Windows inspection settlement");
                Assert.NotNull(dialog);
                var consent = Assert.Single(TestSupport.FindDescendants<CheckBox>(dialog),
                    item => item.Name == "OllamaAppInstallConsent");
                Assert.False(consent.IsChecked == true);
                Assert.All(transport.Calls, method => Assert.Equal("openclaw.setup.detect", method));
                using (await OnboardingNativeProof.CaptureAsync(window, "ollama-real-windows-inspection", output,
                    ["Ollama"], requiredContent: dialog)) { }
                output.WriteLine(JsonSerializer.Serialize(new
                {
                    qualification = "Real Windows observation through production SetupWindow factory; synthetic selected Gateway. No consent or app mutation.",
                    dialog.PrimaryButtonText, dialog.SecondaryButtonText, consentVisible = consent.Visibility.ToString(),
                    status = Assert.Single(TestSupport.FindDescendants<TextBlock>(dialog), item => item.Name == "OllamaAppStatus").Text,
                }));
            }
            finally
            {
                if (window is not null)
                {
                    if (!window.IsClosed) window.Close();
                    await window.CleanupCompleted.WaitAsync(TimeSpan.FromSeconds(60));
                }
                Application.Current.Resources.MergedDictionaries.Remove(resources);
            }
        });
    }

    private sealed class InspectionTransport : IGatewayAiSetupTransport
    {
        public GatewayAiSetupRoute Route { get; } = new("native-proof-fixture", "agent", "authority",
            new string('A', 64), new string('B', 64), "agent:agent:main");
        public long Generation => 1;
        public bool IsConnected => true;
        public IReadOnlyCollection<string> OperatorScopes => ["operator.admin"];
        public IReadOnlyCollection<string> Methods => ["openclaw.setup.detect", "openclaw.setup.verify",
            "openclaw.setup.prepare.start", "wizard.next", "wizard.cancel"];
        public List<string> Calls { get; } = [];
        public Task<JsonElement> RequestAsync(string method, object parameters, int timeoutMs, CancellationToken ct)
        {
            ct.ThrowIfCancellationRequested();
            Calls.Add(method);
            Assert.Equal("openclaw.setup.detect", method);
            return Task.FromResult(JsonSerializer.SerializeToElement(new
            {
                candidates = Array.Empty<object>(), manualProviders = Array.Empty<object>(),
                prepareOptions = new[] { new { id = "ollama", label = "Ollama", kind = "custom" } },
                workspace = "/synthetic", setupComplete = false,
            }));
        }
    }
}
