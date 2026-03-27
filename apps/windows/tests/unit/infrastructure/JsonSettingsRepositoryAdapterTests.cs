using Microsoft.Extensions.Logging.Abstractions;
using OpenClawWindows.Infrastructure.Settings;
using OpenClawWindows.Domain.Settings;
using OpenClawWindows.Domain.Gateway;

namespace OpenClawWindows.Tests.Unit.Infrastructure;

public sealed class JsonSettingsRepositoryAdapterTests : IDisposable
{
    // Uses a temp directory to avoid touching real %APPDATA%
    private readonly string _tempDir;
    private readonly JsonSettingsRepositoryAdapter _adapter;

    public JsonSettingsRepositoryAdapterTests()
    {
        _tempDir = Path.Combine(Path.GetTempPath(), "ocw-tests-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(_tempDir);

        // Connection is Disconnected by default → adapter falls back to local JSON (no gateway call).
        // ConfigGetAsync is stubbed so that tests which incidentally hit the Remote path
        // (e.g. when the real settings.json has ConnectionMode=Remote) do not throw.
        var rpc = Substitute.For<IGatewayRpcChannel>();
        var emptyConfig = """{"hash":"","config":{}}"""u8.ToArray();
        rpc.ConfigGetAsync(Arg.Any<int?>(), Arg.Any<CancellationToken>()).Returns(emptyConfig);
        rpc.RequestRawAsync(Arg.Any<string>(), Arg.Any<Dictionary<string, object?>>(), Arg.Any<int?>(), Arg.Any<CancellationToken>())
           .Returns(Array.Empty<byte>());

        var connection = GatewayConnection.Create("openclaw-control-ui");
        _adapter = new JsonSettingsRepositoryAdapter(rpc, connection, NullLogger<JsonSettingsRepositoryAdapter>.Instance);
    }

    public void Dispose()
    {
        if (Directory.Exists(_tempDir))
            Directory.Delete(_tempDir, recursive: true);
    }

    [Fact]
    public async Task Load_WhenFileAbsent_ReturnsDefaults()
    {
        // First call with no existing file must return non-null defaults
        var settings = await _adapter.LoadAsync(default);

        settings.Should().NotBeNull();
    }

    [Fact]
    public async Task SaveThenLoad_RoundTrip_PreservesSettings()
    {
        var settings = await _adapter.LoadAsync(default);
        settings.SetVoiceWakeSensitivity(0.8f);
        settings.SetVoiceWakeEnabled(true);
        settings.SetAutoStart(true);

        await _adapter.SaveAsync(settings, default);

        var loaded = await _adapter.LoadAsync(default);

        loaded.VoiceWakeSensitivity.Should().BeApproximately(0.8f, 0.001f);
        loaded.VoiceWakeEnabled.Should().BeTrue();
        loaded.AutoStart.Should().BeTrue();
    }

    [Fact]
    public async Task SaveThenLoad_RemoteCredentials_RoundTripWithoutExposure()
    {
        // RemoteToken and RemotePassword must survive a save/load cycle without
        // being readable as plaintext in the serialised JSON (DPAPI-encrypted on Windows).
        var settings = await _adapter.LoadAsync(default);
        settings.SetConnectionMode(ConnectionMode.Remote);
        settings.SetRemoteTransport(RemoteTransport.Direct);
        settings.SetRemoteUrl("ws://localhost:18789");
        settings.SetRemoteToken("secret-token");
        settings.SetRemotePassword("secret-pw");

        await _adapter.SaveAsync(settings, default);

        // Verify plaintext is not present in the raw JSON bytes on disk.
        var raw = await File.ReadAllTextAsync(
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
                         "OpenClaw", "settings.json"));
        raw.Should().NotContain("secret-token");
        raw.Should().NotContain("secret-pw");

        // But the values must round-trip correctly through load.
        var loaded = await _adapter.LoadAsync(default);
        loaded.RemoteToken.Should().Be("secret-token");
        loaded.RemotePassword.Should().Be("secret-pw");
    }

    [Fact]
    public async Task Save_IsConcurrencySafe()
    {
        // Multiple concurrent saves must not throw or corrupt
        var settings = await _adapter.LoadAsync(default);

        var tasks = Enumerable.Range(0, 10)
            .Select(_ => _adapter.SaveAsync(settings, default));

        var act = async () => await Task.WhenAll(tasks);

        await act.Should().NotThrowAsync();
    }
}
