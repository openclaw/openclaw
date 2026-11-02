using System.Diagnostics;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text.Json;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation.Peers;
using Microsoft.UI.Xaml.Automation.Provider;
using Microsoft.UI.Xaml.Controls;
using OpenClaw.SetupEngine;
using OpenClaw.SetupEngine.UI;
using OpenClaw.SetupEngine.UI.Controls;
using OpenClaw.SetupEngine.UI.Pages;
using OpenClawTray.Services;

namespace OpenClaw.Tray.UITests;

// Test-only overlay, deliberately NOT an xUnit Fact: run in its own WinExe, never VSTest.
// A test-runner hang collector or a tree-killing wrapper must not own the real installer.
public static class RealOllamaAppQualificationTests
{
    private const BindingFlags Private = BindingFlags.Instance | BindingFlags.NonPublic;
    private static readonly Dictionary<string, object> Rows = new();
    private static readonly TaskCompletionSource<int> ExitObserved = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private static string Root => Required("OPENCLAW_REAL_APP_PROOF_DIR");
    private static string Mode => Required("OPENCLAW_REAL_APP_MODE");
    private static bool _finalFreezeVerified;
    private static readonly TimeSpan UiBound = TimeSpan.FromSeconds(90);
    private static readonly TimeSpan AcquisitionBound = TimeSpan.FromMinutes(35);
    private sealed record StartEvent(string Path, DateTimeOffset Timestamp);
    private sealed record ProcessFact(int processId, DateTime processStartUtc, string path, int sessionId, string sid);

    public static async Task<int> RunStandaloneAsync()
    {
        // These rows are never silently skipped or promoted by a zero process exit code.
        foreach (var name in new[] { "fresh-inventory", "unchecked-consent", "real-installer-admission",
            "install-needs-model", "reuse-running-service", "cancel-live", "close-live", "quit-live",
            "settlement-releases-lock-and-logger", "cancelled-installation-present", "app-created", "final-freeze", "actual-application-exit", "stopped-open" })
            Row(name, "blocked", "Not reached in this mode or boundary unavailable.");
        Row("stopped-open", "blocked", "No qualified graceful owned-app shutdown contract; no forced stop or reinstall.");
        UIThreadFixture? ui = null;
        try
        {
            Assert.Equal("1", Required("OPENCLAW_REAL_APP_AUTHORIZED"));
            Assert.True(Mode is "Normal" or "CancelCloseQuit");
            VerifyFreeze();
            OnboardingNativeProof.AssertIsolatedRoots();
            using var me = Process.GetCurrentProcess();
            Save("testhost.json", new { processId = me.Id, processStartUtc = me.StartTime.ToUniversalTime(),
                path = me.MainModule!.FileName, mode = Mode });
            ui = new UIThreadFixture();
            var mounted = ui.RunOnUIAsync(() => RunMountedAsync(ui));
            // Actual Exit stops the UI dispatcher's await continuations. The one-shot root
            // observes the real Exit call directly instead of awaiting a dead dispatcher.
            var completed = await Task.WhenAny(mounted, ExitObserved.Task);
            if (completed == ExitObserved.Task) return await ExitObserved.Task;
            await mounted;
            throw new InvalidOperationException("Mounted consumer returned without actual Application.Exit.");
        }
        catch (Exception error)
        {
            Row("consumer", "blocked", SetupLogger.Sanitize(error.ToString()));
            // RunMountedAsync drains before it throws; startup faults have admitted nothing.
            if (ui is not null)
                await ui.RunOnUIAsync(() => Application.Current.Exit());
            return 2;
        }
        // Do not Dispose after actual Application.Exit: the shared fixture Dispose marshals
        // ResetContainer/GC to a dispatcher which has already exited. This host is one-shot.
    }

    private static async Task RunMountedAsync(UIThreadFixture ui)
    {
        var repo = Required("OPENCLAW_REPO_ROOT");
        var resources = OnboardingWindowsFlowTests.LoadProgressResources(repo);
        Application.Current.Resources.MergedDictionaries.Add(resources);
        var data = Path.Combine(Root, "setup-data");
        var local = Path.Combine(Root, "setup-local");
        var config = Path.Combine(Root, "setup.json");
        await File.WriteAllTextAsync(config, JsonSerializer.Serialize(new SetupConfig()));
        var window = OnboardingNativeProof.CreateWindow(() => new SetupWindow(configPath: config,
            dataDir: data, localDataDir: local, commandLineArgs: [], startupRegistrationAllowed: false));
        var frame = Assert.IsType<Frame>(Assert.IsType<Grid>(window.Content).FindName("RootFrame"));
        var transport = new NoModelTransport();
        var args = Assert.IsType<AiSetupPageArgs>(typeof(SetupWindow).GetMethod("CreateAiSetupArgs", Private)!
            .Invoke(window, null)) with { TransportFactory = () => transport };
        // Preserve production CreateOllamaSetup, CommandRunner, logger and AccessDraft intact.
        Assert.NotNull(args.OllamaSetupFactory);
        frame.Navigate(typeof(AiSetupPage), args);
        var page = Assert.IsType<AiSetupPage>(frame.Content);
        OnboardingNativeProof.ActivateOwned(window);
        OllamaWindowsSetup? setup = null;
        SetupLogger? logger = null;
        var quit = Task.CompletedTask;
        try
        {
            await WaitAsync(() => page.IsLoaded && TestSupport.FindDescendants<SetupActionCard>(
                Assert.IsType<ItemsControl>(page.FindName("PrepareChoices"))).Any(card => card.IsEnabled), UiBound, "Ollama Set up card");
            var card = Assert.Single(TestSupport.FindDescendants<SetupActionCard>(
                Assert.IsType<ItemsControl>(page.FindName("PrepareChoices"))));
            Assert.Contains(TestSupport.FindDescendants<TextBlock>(card), text => text.Text == "Set up");
            Invoke(card);
            var dialog = await DialogAsync(page);
            setup = Field<OllamaWindowsSetup>(page, "_ollamaSetup");
            logger = Field<SetupLogger>(page, "_ollamaLogger");
            var intent = FieldOrNull<OllamaWindowsReviewedIntent>(dialog, "_intent");
            if (intent is null || intent.Action != OllamaWindowsAction.Install)
                throw new InvalidOperationException("Fresh-host refusal: actual production inspection did not offer Install. Existing, unknown, active, API or foreign-runtime evidence is not absence.");
            var observed = intent.Reviewed.Windows;
            Assert.Equal(OllamaWindowsInstallationState.NoSupportedRegistration, observed.InstallationState);
            Assert.Equal(OllamaWindowsActivity.NotActive, observed.Activity);
            Assert.Equal(OllamaWindowsApiState.NotListening, observed.ApiState);
            Assert.False(observed.HasInstallationConflict);
            Assert.Null(observed.Installation);
            Save("initial-observation.json", observed);
            Row("fresh-inventory", "passed", "Actual production registration, default path, PATH, process, foreign llama-server and API observations all permit fresh install.");
            var consent = Named<CheckBox>(dialog, "OllamaAppInstallConsent");
            Assert.False(consent.IsChecked == true);
            Assert.False(Named<Button>(dialog, "PrimaryButton").IsEnabled);
            Row("unchecked-consent", "passed", "Real mounted consent starts unchecked; Install is disabled.");
            await MountedControlCapture.OptionalAsync(window, "real-app-unchecked-review");

            // Wrapper launch-error cleanup can still terminate its exact root. Do not enable
            // consent until the parent has RETURNED from the wrapper and acknowledged identity.
            await WaitAsync(() => File.Exists(Path.Combine(Root, "admission-ack.json")), UiBound, "parent launch admission ack");
            using (var ack = JsonDocument.Parse(await File.ReadAllTextAsync(Path.Combine(Root, "admission-ack.json"))))
            {
                using var self = Process.GetCurrentProcess();
                Assert.Equal(self.Id, ack.RootElement.GetProperty("processId").GetInt32());
                Assert.Equal(self.StartTime.ToUniversalTime(), ack.RootElement.GetProperty("processStartUtc").GetDateTime().ToUniversalTime());
                Assert.Equal(Required("OPENCLAW_REAL_APP_FREEZE_SHA256"), ack.RootElement.GetProperty("freezeSha256").GetString());
            }
            StartEvent? started = null;
            var commandsObserved = 0;
            logger.LogEmitted += (_, entry) =>
            {
                if (!entry.Message.StartsWith("cmd.start:", StringComparison.Ordinal) || entry.Data is null) return;
                Interlocked.Increment(ref commandsObserved);
                var payload = JsonSerializer.SerializeToElement(entry.Data);
                if (!payload.TryGetProperty("exe", out var exe)) return;
                var path = exe.GetString();
                if (path is not null && Path.GetFullPath(path).StartsWith(Path.GetFullPath(local) + Path.DirectorySeparatorChar,
                    StringComparison.OrdinalIgnoreCase) && path.EndsWith(".exe", StringComparison.OrdinalIgnoreCase))
                    Volatile.Write(ref started, new(path, entry.Timestamp));
            };
            Assert.IsAssignableFrom<IToggleProvider>(FrameworkElementAutomationPeer.CreatePeerForElement(consent)
                .GetPattern(PatternInterface.Toggle)).Toggle();
            Invoke(Named<Button>(dialog, "PrimaryButton"));
            await WaitAsync(() => Volatile.Read(ref started) is not null || Result(dialog) is not null,
                AcquisitionBound, "real production WinGet acquisition and installer command event");
            var command = Volatile.Read(ref started) ?? throw new InvalidOperationException(
                "Acquisition did not admit an installer: " + JsonSerializer.Serialize(Result(dialog)));
            Save("installer-command-event.json", command);
            // cmd.start is BEFORE Process.Start. It is NOT admission evidence.
            ProcessFact? installer = null;
            await WaitAsync(() =>
            {
                installer = FindProcess(command.Path, command.Timestamp.UtcDateTime);
                return installer is not null || Result(dialog) is not null;
            }, UiBound, "actual installer process after cmd.start");
            if (installer is null) throw new InvalidOperationException("Actual installer pending window missed; cmd.start alone cannot qualify admission or cancellation.");
            Save("installer-process.json", installer);
            // Observe refusal BEFORE opening the proof reader; our own stream must not
            // manufacture the claimed retained-file observation. Inno image mapping can
            // also deny write access, so this is compatibility evidence, not exclusive
            // attribution of every OS denial to the product's held stream.
            Assert.Throws<IOException>(() => { using var exclusive = File.Open(command.Path, FileMode.Open, FileAccess.ReadWrite, FileShare.None); });
            await Task.Run(() =>
            {
                using var held = new FileStream(command.Path, FileMode.Open, FileAccess.Read, FileShare.Read);
                var hash = Convert.ToHexString(SHA256.HashData(held));
                Assert.Equal(OllamaWindowsPackage.Sha256.ToUpperInvariant(), hash);
                held.Position = 0;
                var verifier = typeof(OpenClaw.Connection.GatewayConnectionManager).Assembly.GetType("OpenClaw.Connection.WindowsAuthenticodeVerifier")!;
                var trust = verifier.GetMethod("VerifyOllamaSignedFile", BindingFlags.Public | BindingFlags.Static)!.Invoke(null, [held])!;
                Assert.True((bool)trust.GetType().GetProperty("IsTrusted")!.GetValue(trust)!);
                Save("installer-held-file.json", new { path = command.Path, sha256 = hash, exclusiveAccessRefusedBeforeProofReader = true,
                    signerTrustedByActualProductVerifier = true, productVersion = OllamaWindowsPackage.Version });
            });
            Row("real-installer-admission", "passed", "Observed actual same-image/current-SID/session process started after command event; production retained hash/signer-verified file and admitted Inno.");

            if (Mode == "CancelCloseQuit")
            {
                Assert.True(IsSameLive(installer));
                Invoke(Named<Button>(dialog, "CloseButton"));
                await WaitAsync(() => dialog.CloseButtonText == "Finishing current step" || Result(dialog) is not null,
                    UiBound, "actual Cancel acknowledgment");
                Assert.True(Result(dialog) is null && IsSameLive(installer), "Installer settled before live Cancel retention observation.");
                AssertRetained(setup, data, logger);
                Row("cancel-live", "passed", "Actual Cancel withdrew continuation while real installer, setup lock and logger remained live.");
                window.Close();
                Assert.True(IsSameLive(installer), "Installer settled before live Window.Close observation.");
                Assert.False(window.CleanupCompleted.IsCompleted);
                AssertRetained(setup, data, logger);
                Row("close-live", "passed", "Actual Window.Close retains cleanup lease, lock and logger while real installer remains live.");
                var manager = Manager(ui);
                typeof(WindowManager).GetField("_setupWindow", Private)!.SetValue(manager, window);
                quit = new AppShutdownCoordinator().ShutdownAsync(new AppShutdownPlan(manager.BeginShutdown,
                    [new("window manager", async () => await manager.CloseForShutdownAsync()),
                     new("qualification after real drain", async () => await CaptureSettlementAsync(setup, logger, data, local, command, transport))],
                    ExitApplication));
                Assert.True(IsSameLive(installer), "Installer settled before live Quit observation.");
                Assert.False(quit.IsCompleted);
                AssertRetained(setup, data, logger);
                Row("quit-live", "passed", "Actual shutdown coordinator cannot reach Application.Exit until real installer settlement.");
                // Capture settlement and app identity in a real shutdown step BEFORE Exit.
                // Await without the dispatcher: Application.Exit stops its message pump.
                await quit.ConfigureAwait(false);
                return;
            }
            else
            {
                await WaitAsync(() => Result(dialog) is not null, AcquisitionBound, "installer settlement");
                var appBound = Stopwatch.StartNew();
                while (Result(dialog)?.Outcome == OllamaWindowsSetupOutcome.WaitingForApp && appBound.Elapsed < UiBound)
                {
                    Invoke(Named<Button>(dialog, "PrimaryButton"));
                    await WaitAsync(() => !Field<bool>(dialog, "_working"), UiBound, "read-only app recheck");
                    if (Result(dialog)?.Outcome == OllamaWindowsSetupOutcome.WaitingForApp) await Task.Delay(250);
                }
                Assert.Equal(OllamaWindowsSetupOutcome.AppReadyNeedsModel, Result(dialog)?.Outcome);
                Assert.Equal(OllamaWindowsInstallationState.Verified, Result(dialog)!.Windows!.InstallationState);
                Assert.Equal(0, Result(dialog)!.Windows!.LocalChatModelCount);
                Row("install-needs-model", "passed", "Actual signed install and API recheck reached NeedsModel. Selected Gateway is synthetic, no model readiness claimed.");
                await MountedControlCapture.OptionalAsync(window, "real-app-installed-needs-model");
                var commandsBefore = Volatile.Read(ref commandsObserved);
                var beforeReuse = OwnedAppAndService(Result(dialog)!.Windows!.Installation!);
                Save("reuse-before.json", beforeReuse);
                var workVersion = Field<int>(dialog, "_workVersion");
                Invoke(Named<Button>(dialog, "PrimaryButton"));
                await WaitAsync(() => Field<int>(dialog, "_workVersion") > workVersion && !Field<bool>(dialog, "_working"),
                    UiBound, "new read-only reuse recheck settlement");
                Assert.Equal(OllamaWindowsSetupOutcome.AppReadyNeedsModel, Result(dialog)?.Outcome);
                Assert.Equal(commandsBefore, Volatile.Read(ref commandsObserved));
                var afterReuse = OwnedAppAndService(Result(dialog)!.Windows!.Installation!);
                Assert.Equal(beforeReuse, afterReuse);
                Save("reuse-after.json", afterReuse);
                Row("reuse-running-service", "passed", "A new read-only Check again retained the same single app and daemon PID/start/path/SID/session and zero models, without another Install/Open command.");
                Invoke(Named<Button>(dialog, "CloseButton"));
                await WaitAsync(() => NamedPageButton(page, "RefreshButton").IsEnabled, UiBound, "dialog closure");
            }

            window.Close();
            await window.CleanupCompleted;
            await CaptureSettlementAsync(setup, logger, data, local, command, transport);
            if (Mode == "Normal")
            {
                var manager = Manager(ui);
                await new AppShutdownCoordinator().ShutdownAsync(new AppShutdownPlan(manager.BeginShutdown,
                    [new("window manager", async () => await manager.CloseForShutdownAsync())],
                    ExitApplication));
            }
        }
        finally
        {
            // No timeout, Kill, uninstall, compensating Open, or synthetic completion.
            // On a failure after admission this can remain pending; parent reports blocked.
            if (setup is not null) await setup.DrainAsync();
            if (!window.IsClosed) window.Close();
            await window.CleanupCompleted;
            if (Mode == "CancelCloseQuit") await quit;
        }
    }

    private static async Task CaptureSettlementAsync(OllamaWindowsSetup setup, SetupLogger logger,
        string data, string local, StartEvent command, NoModelTransport transport)
    {
        await setup.DrainAsync();
        using var inspectionLog = new SetupLogger(null);
        var final = await new OllamaWindowsAppHost(new CommandRunner(inspectionLog), local).ObserveAsync(CancellationToken.None);
        Assert.Equal(OllamaWindowsInstallationState.Verified, final.InstallationState);
        var app = FindProcess(final.Installation!.AppPath, command.Timestamp.UtcDateTime)
            ?? throw new InvalidOperationException("Task-created Ollama desktop app not observed; service-only liveness is insufficient.");
        Save("app-before-exit.json", app);
        Row("app-created", "passed", "Actual product-verified signed Ollama desktop app observed with task-created identity.");
        Assert.All(transport.Calls, method => Assert.Equal("openclaw.setup.detect", method));
        Save("gateway-calls.json", new { synthetic = true, noModels = true, calls = transport.Calls,
            actualGatewayReadiness = false, modelDownload = false });
        Assert.True(SetupRunLock.TryAcquire(data, out var released, out _));
        released!.Dispose();
        using (File.Open(logger.FilePath!, FileMode.Open, FileAccess.ReadWrite, FileShare.None)) { }
        Row("settlement-releases-lock-and-logger", "passed", "Actual product drain completed; setup lock and production logger file released.");
        if (Mode == "CancelCloseQuit")
        {
            Assert.Contains("CancelledInstallationPresent", await File.ReadAllTextAsync(logger.FilePath!));
            Row("cancelled-installation-present", "passed", "Actual post-cancellation installer settlement recorded installation present; no rollback or compensating app action.");
        }
        VerifyFreeze();
        using var self = Process.GetCurrentProcess();
        Save("final-freeze.json", new { verified = true, mode = Mode,
            freezeSha256 = Required("OPENCLAW_REAL_APP_FREEZE_SHA256"),
            processId = self.Id, processStartUtc = self.StartTime.ToUniversalTime(),
            filesAndLoadedAssembliesVerified = true, observedUtc = DateTimeOffset.UtcNow });
        Row("final-freeze", "passed", "Final source, generated inputs and required loaded binary verification completed before actual Exit.");
        Volatile.Write(ref _finalFreezeVerified, true);
    }

    private static void ExitApplication()
    {
        Application.Current.Exit();
        Row("actual-application-exit", "passed", "Actual Application.Current.Exit returned after product drain; parent must verify host exit separately.");
        ExitObserved.TrySetResult(Volatile.Read(ref _finalFreezeVerified) ? 0 : 2);
    }

    private static void AssertRetained(OllamaWindowsSetup setup, string data, SetupLogger logger)
    {
        Assert.True(setup.MutationInFlight);
        Assert.False(SetupRunLock.TryAcquire(data, out var refused, out _));
        Assert.Null(refused);
        Assert.Throws<IOException>(() => { using var probe = File.Open(logger.FilePath!, FileMode.Open, FileAccess.ReadWrite, FileShare.None); });
    }
    private static OllamaWindowsSetupResult? Result(ContentDialog dialog) =>
        Field<OllamaWindowsDialogResult>(dialog, "_result").Result;
    private static T Field<T>(object value, string name) => (T)value.GetType().GetField(name, Private)!.GetValue(value)!;
    private static T? FieldOrNull<T>(object value, string name) where T : class => value.GetType().GetField(name, Private)!.GetValue(value) as T;
    private static T Named<T>(DependencyObject root, string name) where T : FrameworkElement =>
        Assert.Single(TestSupport.FindDescendants<T>(root), item => item.Name == name);
    private static Button NamedPageButton(AiSetupPage page, string name) => Assert.IsType<Button>(page.FindName(name));
    private static void Invoke(FrameworkElement element)
    {
        Assert.True(Assert.IsAssignableFrom<Control>(element).IsEnabled);
        Assert.IsAssignableFrom<IInvokeProvider>(FrameworkElementAutomationPeer.CreatePeerForElement(element)
            .GetPattern(PatternInterface.Invoke)).Invoke();
    }
    private static async Task<OllamaWindowsSetupDialog> DialogAsync(AiSetupPage page)
    {
        OllamaWindowsSetupDialog? dialog = null;
        await WaitAsync(() =>
        {
            dialog = FieldOrNull<OllamaWindowsSetupDialog>(page, "_ollamaDialog");
            return dialog is { IsLoaded: true } && !Field<bool>(dialog, "_working") &&
                TestSupport.FindDescendants<Button>(dialog).Any(button => button.Name == "PrimaryButton");
        }, UiBound, "real Windows inspection settlement");
        return dialog!;
    }
    private static async Task WaitAsync(Func<bool> condition, TimeSpan bound, string boundary)
    {
        var timer = Stopwatch.StartNew();
        while (!condition())
        {
            if (timer.Elapsed > bound) throw new InvalidOperationException("Blocked waiting for " + boundary + ". No process termination requested.");
            // Native process/API/render observations are external asynchronous state, not a fake completion signal.
            await Task.Delay(100);
        }
    }
    private static ProcessFact[] OwnedAppAndService(OllamaWindowsInstallation installation)
    {
        var facts = new List<ProcessFact>();
        using var me = Process.GetCurrentProcess();
        foreach (var path in new[] { installation.AppPath, installation.CliPath })
        {
            var matches = new List<ProcessFact>();
            foreach (var process in Process.GetProcessesByName(Path.GetFileNameWithoutExtension(path)))
            using (process)
            {
                if (process.HasExited || !string.Equals(process.MainModule?.FileName, path, StringComparison.OrdinalIgnoreCase)) continue;
                Assert.Equal(me.SessionId, process.SessionId);
                var sid = Sid(process);
                Assert.Equal(WindowsIdentity.GetCurrent().User!.Value, sid);
                matches.Add(new(process.Id, process.StartTime.ToUniversalTime(), path, process.SessionId, sid));
            }
            facts.Add(Assert.Single(matches));
        }
        return facts.ToArray();
    }
    private static ProcessFact? FindProcess(string path, DateTime after)
    {
        using var me = Process.GetCurrentProcess();
        foreach (var process in Process.GetProcessesByName(Path.GetFileNameWithoutExtension(path)))
        using (process)
        {
            try
            {
                var start = process.StartTime.ToUniversalTime();
                if (start < after || process.SessionId != me.SessionId || process.HasExited ||
                    !string.Equals(path, process.MainModule?.FileName, StringComparison.OrdinalIgnoreCase)) continue;
                var sid = Sid(process);
                Assert.Equal(WindowsIdentity.GetCurrent().User!.Value, sid);
                return new(process.Id, start, process.MainModule!.FileName, process.SessionId, sid);
            }
            catch (ArgumentException) { }
            catch (InvalidOperationException) { }
        }
        return null;
    }
    private static bool IsSameLive(ProcessFact fact)
    {
        try
        {
            using var process = Process.GetProcessById(fact.processId);
            return !process.HasExited && process.StartTime.ToUniversalTime() == fact.processStartUtc &&
                process.SessionId == fact.sessionId && Sid(process) == fact.sid &&
                string.Equals(process.MainModule?.FileName, fact.path, StringComparison.OrdinalIgnoreCase);
        }
        catch (ArgumentException) { return false; }
        catch (InvalidOperationException) { return false; }
    }
    private static string Sid(Process process)
    {
        if (!OpenProcessToken(process.Handle, 8, out var token)) throw new System.ComponentModel.Win32Exception();
        try { using var identity = new WindowsIdentity(token); return identity.User!.Value; }
        finally { CloseHandle(token); }
    }
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
    [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);
    private static WindowManager Manager(UIThreadFixture ui) => new(ui.Dispatcher, new WindowManagerCallbacks(
        GetAppState: () => null, GetAppNotificationService: () => null, GetConnectionManager: () => null,
        GetGatewayRegistry: () => null, GetSettings: () => null, GetGatewayDirectConnectService: () => null,
        GetLocalAiRuntime: () => null, GetNodeService: () => null, GetPageActivator: () => null,
        GetPendingChatSessionKey: () => null, GetStartupArgs: () => null, IsDeepLinkArg: _ => false,
        RequiresSetup: () => false, Connect: () => { }, Disconnect: () => { }, SettingsSaved: (_, _) => { },
        AdvancedSetupRequested: (_, _) => { }, SetupCompleted: (_, _) => { }, ApplyTheme: _ => { }));
    private static void VerifyFreeze()
    {
        var path = Required("OPENCLAW_REAL_APP_FREEZE");
        Assert.Equal(Required("OPENCLAW_REAL_APP_FREEZE_SHA256"), Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(path))));
        using var freeze = JsonDocument.Parse(File.ReadAllText(path));
        Assert.Equal("f25cff6b71801078260e2f5080e2d8d9c32584829ad7d7dfb9c59d79e254961d", freeze.RootElement.GetProperty("productPatchSha256").GetString());
        foreach (var item in freeze.RootElement.GetProperty("files").EnumerateArray())
            Assert.Equal(item.GetProperty("sha256").GetString(), Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(item.GetProperty("path").GetString()!))));
        var binaries = freeze.RootElement.GetProperty("binaries").EnumerateArray().ToDictionary(item =>
            Path.GetFullPath(item.GetProperty("path").GetString()!), item => item.GetProperty("sha256").GetString(), StringComparer.OrdinalIgnoreCase);
        var output = Path.GetDirectoryName(Environment.ProcessPath!)! + Path.DirectorySeparatorChar;
        foreach (var required in new[] { typeof(RealOllamaAppQualificationTests).Assembly,
            typeof(UIThreadFixture).Assembly, typeof(SetupWindow).Assembly,
            typeof(OllamaWindowsSetup).Assembly, typeof(OpenClaw.Connection.GatewayConnectionManager).Assembly })
        {
            Assert.True(required.Location.StartsWith(output, StringComparison.OrdinalIgnoreCase),
                "Required product assembly loaded outside the actual frozen launch directory: " + required.Location);
            Assert.True(binaries.TryGetValue(required.Location, out var requiredHash));
            Assert.Equal(requiredHash, Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(required.Location))));
        }
        foreach (var assembly in AppDomain.CurrentDomain.GetAssemblies().Where(a => !a.IsDynamic && !string.IsNullOrEmpty(a.Location)))
        {
            if (!assembly.Location.StartsWith(output, StringComparison.OrdinalIgnoreCase)) continue;
            Assert.True(binaries.TryGetValue(assembly.Location, out var expected), "Loaded local binary missing from freeze: " + assembly.Location);
            Assert.Equal(expected, Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(assembly.Location))));
        }
        Save("loaded-binaries.json", AppDomain.CurrentDomain.GetAssemblies().Where(a => !a.IsDynamic && !string.IsNullOrEmpty(a.Location))
            .Select(a => new { path = a.Location, sha256 = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(a.Location))) }).ToArray());
    }
    private static string Required(string key) => Environment.GetEnvironmentVariable(key) is { Length: > 0 } value ? value : throw new InvalidOperationException("Missing " + key);
    private static void Save(string name, object value)
    {
        Directory.CreateDirectory(Root);
        var destination = Path.Combine(Root, name);
        File.WriteAllText(destination + ".writing", JsonSerializer.Serialize(value, new JsonSerializerOptions { WriteIndented = true }));
        File.Move(destination + ".writing", destination, true);
    }
    private static void Row(string name, string status, string detail)
    {
        Rows[name] = new { name, status, detail, observedUtc = DateTimeOffset.UtcNow };
        Save("cases.json", Rows.Values.ToArray());
    }
    private sealed class NoModelTransport : IGatewayAiSetupTransport
    {
        public GatewayAiSetupRoute Route { get; } = new("real-app-synthetic-gateway", "agent", "authority", new string('A', 64), new string('B', 64), "agent:agent:main");
        public long Generation => 1;
        public bool IsConnected => true;
        public IReadOnlyCollection<string> OperatorScopes => ["operator.admin"];
        // Detect requires at least one advertised choice shape. These wizard names are
        // presentation-only capability metadata; ALL calls except detect are rejected.
        public IReadOnlyCollection<string> Methods => ["openclaw.setup.detect", "openclaw.setup.verify", "openclaw.setup.prepare.start", "wizard.next", "wizard.cancel"];
        public List<string> Calls { get; } = [];
        public Task<JsonElement> RequestAsync(string method, object parameters, int timeoutMs, CancellationToken ct)
        {
            ct.ThrowIfCancellationRequested();
            Calls.Add(method);
            if (method != "openclaw.setup.detect") throw new InvalidOperationException("Forbidden synthetic Gateway mutation/readiness/model call: " + method);
            return Task.FromResult(JsonSerializer.SerializeToElement(new { candidates = Array.Empty<object>(), manualProviders = Array.Empty<object>(),
                prepareOptions = new[] { new { id = "ollama", label = "Ollama", kind = "custom" } }, workspace = "/synthetic", setupComplete = false }));
        }
    }
}
