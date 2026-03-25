using System.Text.Json;
using OpenClawWindows.Application.Behaviors;
using OpenClawWindows.Application.Ports;
using OpenClawWindows.Domain.Skills;

namespace OpenClawWindows.Application.Skills;

// timeoutMs=300_000 matches the 5-minute timeout used in macOS.
public sealed record InstallSkillCommand(string SkillName, string InstallId)
    : IRequest<ErrorOr<SkillInstallResult>>;

[UseCase("UC-058-skills-install")]
internal sealed class InstallSkillHandler
    : IRequestHandler<InstallSkillCommand, ErrorOr<SkillInstallResult>>
{
    // Tunables
    private const int InstallTimeoutMs = 300_000;

    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNameCaseInsensitive = true,
    };

    private readonly IGatewayRpcChannel _rpc;

    public InstallSkillHandler(IGatewayRpcChannel rpc) => _rpc = rpc;

    public async Task<ErrorOr<SkillInstallResult>> Handle(
        InstallSkillCommand request,
        CancellationToken ct)
    {
        try
        {
            var element = await _rpc.SkillsInstallAsync(
                request.SkillName,
                request.InstallId,
                InstallTimeoutMs,
                ct);

            var result = JsonSerializer.Deserialize<SkillInstallResult>(
                element.GetRawText(), JsonOptions);

            return result is null
                ? Error.Unexpected("skills.install.empty", "Gateway returned no install result")
                : result;
        }
        catch (Exception ex)
        {
            return Error.Failure("skills.install.failed", ex.Message);
        }
    }
}
