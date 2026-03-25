internal static class Program
{
    private static readonly string DiagLog = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
        "OpenClaw", "diag.log");

    // Single-instance guard — prevents multiple app windows from opening.
    private static System.Threading.Mutex? _singleInstanceMutex;

    [STAThread]
    private static void Main(string[] args)
    {
        WriteDiag($"Main — exe path: {Environment.ProcessPath}");
        WriteDiag($"Main — current dir: {Environment.CurrentDirectory}");

        // Single-instance: if another instance is already running, exit immediately.
        _singleInstanceMutex = new System.Threading.Mutex(true, "Global\\OpenClawWindows_SingleInstance", out bool createdNew);
        if (!createdNew)
        {
            WriteDiag("Main — another instance already running, exiting");
            return;
        }

        try
        {
            WinRT.ComWrappersSupport.InitializeComWrappers();
            WriteDiag("Main — ComWrappers initialized");
        }
        catch (Exception ex)
        {
            WriteDiag($"Main — ComWrappers FAILED: {ex}");
            return;
        }

        try
        {
            WriteDiag("Main — calling Application.Start()");
            Microsoft.UI.Xaml.Application.Start(static p =>
            {
                // Match the auto-generated WinUI 3 Program.cs: set up the
                // DispatcherQueueSynchronizationContext so async/await and XAML
                // data-binding marshal back to the UI thread correctly.
                var dispatcherQueue = Microsoft.UI.Dispatching.DispatcherQueue.GetForCurrentThread();
                var syncCtx = new Microsoft.UI.Dispatching.DispatcherQueueSynchronizationContext(dispatcherQueue);
                System.Threading.SynchronizationContext.SetSynchronizationContext(syncCtx);
                WriteDiag("Main — SynchronizationContext set");

                WriteDiag("Main — inside Application.Start callback, creating App");
                _ = new OpenClawWindows.App();
                WriteDiag("Main — App created");
            });
            WriteDiag("Main — Application.Start() returned");
        }
        catch (Exception ex)
        {
            WriteDiag($"Main — Application.Start FAILED: {ex}");
        }
    }

    internal static void WriteDiag(string msg)
    {
        try
        {
            var dir = Path.GetDirectoryName(DiagLog)!;
            Directory.CreateDirectory(dir);
            File.AppendAllText(DiagLog, $"[{DateTime.Now:HH:mm:ss.fff}] {msg}{Environment.NewLine}");
        }
        catch
        {
            // Best-effort diagnostic logging.
        }
    }
}
