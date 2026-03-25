using OpenClawWindows.Application.Behaviors;
using OpenClawWindows.Domain.Pairing;

namespace OpenClawWindows.Application.Pairing;

[UseCase("UC-030")]
public sealed record InitiatePairingCommand : IRequest<ErrorOr<string>>;

internal sealed class InitiatePairingHandler : IRequestHandler<InitiatePairingCommand, ErrorOr<string>>
{
    private readonly IKeypairStorage _storage;
    private readonly ILogger<InitiatePairingHandler> _logger;

    public InitiatePairingHandler(IKeypairStorage storage, ILogger<InitiatePairingHandler> logger)
    {
        _storage = storage;
        _logger = logger;
    }

    public async Task<ErrorOr<string>> Handle(InitiatePairingCommand _, CancellationToken ct)
    {
        if (await _storage.ExistsAsync(ct))
        {
            var existing = await _storage.LoadAsync(ct);
            if (existing.IsError)
                return existing.Errors;
            return existing.Value.PublicKeyBase64;
        }

        var generated = Ed25519KeyPair.Generate();
        if (generated.IsError)
        {
            _logger.LogWarning("Ed25519 generation failed: {Error}", generated.FirstError.Description);
            return generated.Errors;
        }

        await _storage.SaveAsync(generated.Value, ct);
        _logger.LogInformation("Ed25519 keypair generated and stored");
        return generated.Value.PublicKeyBase64;
    }
}
