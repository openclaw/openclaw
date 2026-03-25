namespace OpenClawWindows.Application.VoiceWake;

// Equatable in Swift → reference equality sufficient in C# (all instances are distinct).
internal abstract class VoiceWakeTestState
{
    private VoiceWakeTestState() { }

    internal sealed class Idle : VoiceWakeTestState
    {
        internal static readonly Idle Instance = new();
    }

    internal sealed class Listening : VoiceWakeTestState
    {
        internal static readonly Listening Instance = new();
    }

    internal sealed class Hearing : VoiceWakeTestState
    {
        internal string Text { get; }
        internal Hearing(string text) => Text = text;
    }

    internal sealed class Finalizing : VoiceWakeTestState
    {
        internal static readonly Finalizing Instance = new();
    }

    internal sealed class Detected : VoiceWakeTestState
    {
        internal string Command { get; }
        internal Detected(string command) => Command = command;
    }

    internal sealed class Failed : VoiceWakeTestState
    {
        internal string Message { get; }
        internal Failed(string message) => Message = message;
    }
}
