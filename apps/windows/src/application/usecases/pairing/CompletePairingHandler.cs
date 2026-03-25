using OpenClawWindows.Application.Behaviors;
using OpenClawWindows.Domain.Pairing;
using OpenClawWindows.Domain.Pairing.Events;

namespace OpenClawWindows.Application.Pairing;

[UseCase("UC-031")]
public sealed record CompletePairingCommand(string GatewaySignature, string GatewayPublicKey)
    : IRequest<ErrorOr<Success>>;

internal sealed class CompletePairingHandler : IRequestHandler<CompletePairingCommand, ErrorOr<Success>>
{
    private readonly IKeypairStorage _keypairStorage;
    private readonly IMediator _mediator;
    private readonly IAuditLogger _audit;
    private readonly ILogger<CompletePairingHandler> _logger;

    public CompletePairingHandler(IKeypairStorage keypairStorage, IMediator mediator,
        IAuditLogger audit, ILogger<CompletePairingHandler> logger)
    {
        _keypairStorage = keypairStorage;
        _mediator = mediator;
        _audit = audit;
        _logger = logger;
    }

    public async Task<ErrorOr<Success>> Handle(CompletePairingCommand cmd, CancellationToken ct)
    {
        Guard.Against.NullOrWhiteSpace(cmd.GatewaySignature, nameof(cmd.GatewaySignature));
        Guard.Against.NullOrWhiteSpace(cmd.GatewayPublicKey, nameof(cmd.GatewayPublicKey));

        var keypair = await _keypairStorage.LoadAsync(ct);
        if (keypair.IsError)
        {
            _logger.LogError("Cannot load keypair for pairing verification");
            await _mediator.Publish(new DeviceUnpaired(), ct);
            return Error.Failure("PAIR.KEYPAIR_MISSING", "No keypair found to verify gateway signature");
        }

        var verified = keypair.Value.VerifySignature(cmd.GatewaySignature, cmd.GatewayPublicKey);
        if (!verified)
        {
            _logger.LogWarning("Gateway signature verification failed");
            await _mediator.Publish(new DeviceUnpaired(), ct);
            return Error.Forbidden("PAIR.SIGNATURE_INVALID", "Gateway signature verification failed");
        }

        _logger.LogInformation("Pairing completed (fingerprint logged by audit)");
        await _mediator.Publish(new DevicePaired { PublicKeyBase64 = cmd.GatewayPublicKey }, ct);

        await _audit.LogAsync("pairing.completed", "gateway", true, null, ct);
        return Result.Success;
    }
}
