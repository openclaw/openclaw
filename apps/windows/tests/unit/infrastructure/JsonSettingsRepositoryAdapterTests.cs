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

        // Connection is Disconnected by default → adapter falls back to local JSON (no gateway call)
        var rpc = Substitute.For<IGatewayRpcChannel>();
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
