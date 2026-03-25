using OpenClawWindows.Application.Behaviors;
using OpenClawWindows.Application.Ports;

namespace OpenClawWindows.Application.Skills;

// isPrimary=true → apiKey, isPrimary=false → env dict.
public sealed record SetSkillEnvCommand(
    string SkillKey,
    string EnvKey,
    string Value,
    bool IsPrimary) : IRequest<ErrorOr<Success>>;

[UseCase("UC-058-skills-set-env")]
internal sealed class SetSkillEnvHandler : IRequestHandler<SetSkillEnvCommand, ErrorOr<Success>>
{
    private readonly IGatewayRpcChannel _rpc;

    public SetSkillEnvHandler(IGatewayRpcChannel rpc) => _rpc = rpc;

    public async Task<ErrorOr<Success>> Handle(SetSkillEnvCommand request, CancellationToken ct)
    {
        try
        {
            if (request.IsPrimary)
                await _rpc.SkillsUpdateAsync(
                    skillKey: request.SkillKey,
                    apiKey: request.Value,
                    ct: ct);
            else
                await _rpc.SkillsUpdateAsync(
                    skillKey: request.SkillKey,
                    env: new Dictionary<string, string> { [request.EnvKey] = request.Value },
                    ct: ct);

            return Result.Success;
        }
        catch (Exception ex)
        {
            return Error.Failure("skills.set-env.failed", ex.Message);
        }
    }
}
