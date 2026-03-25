using OpenClawWindows.Domain.Pairing;

namespace OpenClawWindows.Application.Ports;

/// <summary>
/// Secure storage for the ed25519 keypair using DPAPI.
/// </summary>
public interface IKeypairStorage
{
    Task<ErrorOr<Ed25519KeyPair>> LoadAsync(CancellationToken ct);
    Task SaveAsync(Ed25519KeyPair keyPair, CancellationToken ct);
    Task<bool> ExistsAsync(CancellationToken ct);
    Task DeleteAsync(CancellationToken ct);
}
