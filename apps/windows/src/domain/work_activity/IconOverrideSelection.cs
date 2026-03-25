namespace OpenClawWindows.Domain.WorkActivity;

// to manually lock the tray icon into a specific visual state.
internal enum IconOverrideSelection
{
    System,
    Idle,
    MainBash, MainRead, MainWrite, MainEdit, MainOther,
    OtherBash, OtherRead, OtherWrite, OtherEdit, OtherOther,
}

internal static class IconOverrideSelectionHelper
{
    internal static IconState ToIconState(this IconOverrideSelection sel) => sel switch
    {
        IconOverrideSelection.System or
        IconOverrideSelection.Idle    => new IconState.Idle(),

        IconOverrideSelection.MainBash  => new IconState.WorkingMain(new ActivityKind.Tool(ToolKind.Bash)),
        IconOverrideSelection.MainRead  => new IconState.WorkingMain(new ActivityKind.Tool(ToolKind.Read)),
        IconOverrideSelection.MainWrite => new IconState.WorkingMain(new ActivityKind.Tool(ToolKind.Write)),
        IconOverrideSelection.MainEdit  => new IconState.WorkingMain(new ActivityKind.Tool(ToolKind.Edit)),
        IconOverrideSelection.MainOther => new IconState.WorkingMain(new ActivityKind.Tool(ToolKind.Other)),

        IconOverrideSelection.OtherBash  => new IconState.WorkingOther(new ActivityKind.Tool(ToolKind.Bash)),
        IconOverrideSelection.OtherRead  => new IconState.WorkingOther(new ActivityKind.Tool(ToolKind.Read)),
        IconOverrideSelection.OtherWrite => new IconState.WorkingOther(new ActivityKind.Tool(ToolKind.Write)),
        IconOverrideSelection.OtherEdit  => new IconState.WorkingOther(new ActivityKind.Tool(ToolKind.Edit)),
        IconOverrideSelection.OtherOther => new IconState.WorkingOther(new ActivityKind.Tool(ToolKind.Other)),

        _ => new IconState.Idle(),
    };

    internal static string Label(this IconOverrideSelection sel) => sel switch
    {
        IconOverrideSelection.System    => "System (auto)",
        IconOverrideSelection.Idle      => "Idle",
        IconOverrideSelection.MainBash  => "Working main – bash",
        IconOverrideSelection.MainRead  => "Working main – read",
        IconOverrideSelection.MainWrite => "Working main – write",
        IconOverrideSelection.MainEdit  => "Working main – edit",
        IconOverrideSelection.MainOther => "Working main – other",
        IconOverrideSelection.OtherBash  => "Working other – bash",
        IconOverrideSelection.OtherRead  => "Working other – read",
        IconOverrideSelection.OtherWrite => "Working other – write",
        IconOverrideSelection.OtherEdit  => "Working other – edit",
        IconOverrideSelection.OtherOther => "Working other – other",
        _ => sel.ToString(),
    };
}
