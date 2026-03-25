using System.Text.Json;
using OpenClawWindows.Application.Behaviors;
using OpenClawWindows.Application.Ports;
using OpenClawWindows.Domain.Skills;

namespace OpenClawWindows.Application.Skills;

public sealed record ListSkillsQuery : IRequest<ErrorOr<IReadOnlyList<SkillStatus>>>;

[UseCase("UC-058-skills-list")]
internal sealed class ListSkillsHandler
    : IRequestHandler<ListSkillsQuery, ErrorOr<IReadOnlyList<SkillStatus>>>
{
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNameCaseInsensitive = true,
    };

    private readonly IGatewayRpcChannel _rpc;

    public ListSkillsHandler(IGatewayRpcChannel rpc) => _rpc = rpc;

    public async Task<ErrorOr<IReadOnlyList<SkillStatus>>> Handle(
        ListSkillsQuery request,
        CancellationToken ct)
    {
        try
        {
            var element = await _rpc.SkillsStatusAsync(ct);

            // Parse into SkillsStatusReport and sort by name
            var report = JsonSerializer.Deserialize<SkillsStatusReport>(
                element.GetRawText(), JsonOptions);

            if (report is null)
                return Error.Unexpected("skills.status.empty", "Gateway returned no skills data");

            var sorted = report.Skills
                .OrderBy(s => s.Name, StringComparer.OrdinalIgnoreCase)
                .ToList();

            return sorted;
        }
        catch (Exception ex)
        {
            return Error.Failure("skills.status.failed", ex.Message);
        }
    }
}
