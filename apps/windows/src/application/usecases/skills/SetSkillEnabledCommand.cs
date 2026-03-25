using OpenClawWindows.Application.Behaviors;
using OpenClawWindows.Application.Ports;

namespace OpenClawWindows.Application.Skills;

public sealed record SetSkillEnabledCommand(string SkillKey, bool Enabled)
    : IRequest<ErrorOr<Success>>;

[UseCase("UC-058-skills-set-enabled")]
internal sealed class SetSkillEnabledHandler
    : IRequestHandler<SetSkillEnabledCommand, ErrorOr<Success>>
{
    private readonly IGatewayRpcChannel _rpc;

    public SetSkillEnabledHandler(IGatewayRpcChannel rpc) => _rpc = rpc;

    public async Task<ErrorOr<Success>> Handle(
        SetSkillEnabledCommand request,
        CancellationToken ct)
    {
        try
        {
            await _rpc.SkillsUpdateAsync(
                skillKey: request.SkillKey,
                enabled: request.Enabled,
                ct: ct);
            return Result.Success;
        }
        catch (Exception ex)
        {
            return Error.Failure("skills.update.failed", ex.Message);
        }
    }
}
