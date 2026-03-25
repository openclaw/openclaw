namespace OpenClawWindows.Application.Ports;

/// <summary>
/// Load/save the OpenClaw agent config dict (openclaw.json), routing between
/// gateway (remote mode) and local file (local mode with gateway-first fallback).
/// </summary>
public interface IConfigStore
{
    Task<Dictionary<string, object?>> LoadAsync(CancellationToken ct = default);
    Task SaveAsync(Dictionary<string, object?> root, CancellationToken ct = default);
}
