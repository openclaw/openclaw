using System.Text.Json;
using OpenClawWindows.Application.Behaviors;
using OpenClawWindows.Application.ScreenCapture;
using OpenClawWindows.Domain.Camera;

namespace OpenClawWindows.Application.NodeMode;

internal sealed record NodeScreenRecordCommand(string ParamsJson)
    : IRequest<ErrorOr<ScreenRecordingResult>>;

[UseCase("UC-NODE-SCR")]
internal sealed class NodeScreenCommandsHandler
    : IRequestHandler<NodeScreenRecordCommand, ErrorOr<ScreenRecordingResult>>
{
    private readonly ISender _sender;

    public NodeScreenCommandsHandler(ISender sender) => _sender = sender;

    public Task<ErrorOr<ScreenRecordingResult>> Handle(NodeScreenRecordCommand cmd, CancellationToken ct)
    {
        // Fallback to empty object (all defaults) when JSON is malformed.
        var safeJson = IsValidJson(cmd.ParamsJson) ? cmd.ParamsJson : "{}";
        return _sender.Send(new ScreenRecordCommand(safeJson), ct);
    }

    private static bool IsValidJson(string json)
    {
        try { using var _ = JsonDocument.Parse(json); return true; }
        catch { return false; }
    }
}
