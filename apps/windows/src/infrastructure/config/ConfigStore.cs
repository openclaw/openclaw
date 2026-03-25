using System.Text.Json;
using OpenClawWindows.Application.Ports;
using OpenClawWindows.Domain.Config;
using OpenClawWindows.Domain.Gateway;
using OpenClawWindows.Domain.Settings;

namespace OpenClawWindows.Infrastructure.Config;

/// <summary>
/// Routes OpenClaw agent config load/save between gateway RPC and the local config file.
/// </summary>
internal sealed class ConfigStore : IConfigStore
{
    // Tunables
    private const int ConfigGetTimeoutMs = 8000;
    private const int ConfigSetTimeoutMs = 10000;

    private readonly IGatewayRpcChannel                     _rpc;
    private readonly GatewayConnection                      _connection;
    private readonly ISettingsRepository                    _settings;
    private readonly ILogger<ConfigStore>                   _logger;
    private readonly Func<Dictionary<string, object?>>      _loadLocalFile;
    private readonly Action<Dictionary<string, object?>>    _saveLocalFile;
    private readonly SemaphoreSlim                          _lock = new(1, 1);

    // Cached from last config.get — enables hash-based conflict detection on config.set
    private string? _lastHash;

    public ConfigStore(
        IGatewayRpcChannel rpc,
        GatewayConnection connection,
        ISettingsRepository settings,
        ILogger<ConfigStore> logger)
        : this(rpc, connection, settings, logger,
               OpenClawConfigFile.LoadDict,
               OpenClawConfigFile.SaveDict)
    { }

    // Testing constructor
    internal ConfigStore(
        IGatewayRpcChannel rpc,
        GatewayConnection connection,
        ISettingsRepository settings,
        ILogger<ConfigStore> logger,
        Func<Dictionary<string, object?>> loadLocalFile,
        Action<Dictionary<string, object?>> saveLocalFile)
    {
        _rpc           = rpc;
        _connection    = connection;
        _settings      = settings;
        _logger        = logger;
        _loadLocalFile = loadLocalFile;
        _saveLocalFile = saveLocalFile;
    }

    public async Task<Dictionary<string, object?>> LoadAsync(CancellationToken ct = default)
    {
        await _lock.WaitAsync(ct);
        try
        {
            if (await IsRemoteModeAsync(ct))
            {
                // Remote: gateway mandatory
                return await LoadFromGatewayAsync(ct) ?? [];
            }

            // Local: try gateway first, fall back to file
            if (_connection.State == GatewayConnectionState.Connected)
            {
                var fromGateway = await LoadFromGatewayAsync(ct);
                if (fromGateway is not null) return fromGateway;
            }

            return _loadLocalFile();
        }
        finally
        {
            _lock.Release();
        }
    }

    public async Task SaveAsync(Dictionary<string, object?> root, CancellationToken ct = default)
    {
        await _lock.WaitAsync(ct);
        try
        {
            if (await IsRemoteModeAsync(ct))
            {
                // Remote: gateway mandatory — propagate failure, no local fallback
                await SaveToGatewayAsync(root, ct);
                return;
            }

            // Local: try gateway, fall back to file on error
            if (_connection.State == GatewayConnectionState.Connected)
            {
                try
                {
                    await SaveToGatewayAsync(root, ct);
                    return;
                }
                catch (Exception ex)
                {
                    _logger.LogDebug(ex, "config.set to gateway failed — falling back to local file");
                }
            }

            _saveLocalFile(root);
        }
        finally
        {
            _lock.Release();
        }
    }

    private async Task<bool> IsRemoteModeAsync(CancellationToken ct)
    {
        try
        {
            var appSettings = await _settings.LoadAsync(ct);
            return appSettings.ConnectionMode == ConnectionMode.Remote;
        }
        catch
        {
            return false;
        }
    }

    private async Task<Dictionary<string, object?>?> LoadFromGatewayAsync(CancellationToken ct)
    {
        try
        {
            var data = await _rpc.ConfigGetAsync(ConfigGetTimeoutMs, ct);
            using var doc = JsonDocument.Parse(data);

            if (doc.RootElement.TryGetProperty("hash", out var hashEl))
                _lastHash = hashEl.GetString();

            if (!doc.RootElement.TryGetProperty("config", out var configEl))
                return [];

            return ElementToDict(configEl);
        }
        catch (Exception ex)
        {
            _logger.LogDebug(ex, "config.get from gateway failed");
            return null;
        }
    }

    private async Task SaveToGatewayAsync(Dictionary<string, object?> root, CancellationToken ct)
    {
        // Lazy-fetch hash if missing
        if (_lastHash is null && _connection.State == GatewayConnectionState.Connected)
            _ = await LoadFromGatewayAsync(ct);

        var raw = JsonSerializer.Serialize(root, new JsonSerializerOptions { WriteIndented = true });
        var parameters = new Dictionary<string, object?> { ["raw"] = raw };
        if (_lastHash is not null)
            parameters["baseHash"] = _lastHash;

        await _rpc.RequestRawAsync("config.set", parameters, ConfigSetTimeoutMs, ct);

        // Reload hash after save
        _ = await LoadFromGatewayAsync(ct);
    }

    // ── JSON helpers ──

    private static Dictionary<string, object?> ElementToDict(JsonElement el)
    {
        var dict = new Dictionary<string, object?>();
        foreach (var prop in el.EnumerateObject())
            dict[prop.Name] = ElementToValue(prop.Value);
        return dict;
    }

    private static object? ElementToValue(JsonElement el) => el.ValueKind switch
    {
        JsonValueKind.Object => ElementToDict(el),
        JsonValueKind.Array  => el.EnumerateArray().Select(ElementToValue).ToList(),
        JsonValueKind.String => el.GetString(),
        JsonValueKind.Number => el.TryGetInt64(out var i) ? (object?)i : el.GetDouble(),
        JsonValueKind.True   => true,
        JsonValueKind.False  => false,
        _                    => null,
    };
}
