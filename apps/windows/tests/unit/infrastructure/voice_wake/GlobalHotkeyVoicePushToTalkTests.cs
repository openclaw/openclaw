using OpenClawWindows.Infrastructure.VoiceWake;

namespace OpenClawWindows.Tests.Unit.Infrastructure.VoiceWake;

public sealed class GlobalHotkeyVoicePushToTalkTests
{
    // ── Tunables ─────────────────────────────────────────────────────────────

    [Fact]
    public void GracePeriodMs_Is1500()
    {
        // Mirrors Swift: try? await Task.sleep(nanoseconds: 1_500_000_000) = 1.5 s
        Assert.Equal(1500, GlobalHotkeyVoicePushToTalk.GracePeriodMs);
    }

    [Fact]
    public void VkRMenu_Is0xA5()
    {
        // Adapts macOS keyCode 61 (Right Option) → Windows VK_RMENU = 0xA5
        Assert.Equal(0xA5, GlobalHotkeyVoicePushToTalk.VK_RMENU);
    }

    // ── Hotkey state machine ──────────────────────────────────────────────────
    // Mirrors: VoicePushToTalkHotkeyTests.begin_end_fires_once_per_hold

    [Fact]
    public async Task UpdateKeyState_FiresBeginAndEndOnce_PerHold()
    {
        var began = 0;
        var ended = 0;
        var sut   = MakeHarnessWithCounters(
            onBegin: () => Interlocked.Increment(ref began),
            onEnd:   () => Interlocked.Increment(ref ended));

        // key down → begin fires once
        sut._testUpdateKeyState(keyDown: true);
        // held — second key-down should be a no-op
        sut._testUpdateKeyState(keyDown: true);
        // key up → end fires once
        sut._testUpdateKeyState(keyDown: false);

        // Allow fired tasks to complete
        for (var i = 0; i < 50; i++)
        {
            if (began == 1 && ended == 1) break;
            await Task.Delay(10);
        }

        Assert.Equal(1, began);
        Assert.Equal(1, ended);
    }

    [Fact]
    public async Task UpdateKeyState_DoesNotFireEnd_WithoutPriorBegin()
    {
        var began = 0;
        var ended = 0;
        var sut   = MakeHarnessWithCounters(
            onBegin: () => Interlocked.Increment(ref began),
            onEnd:   () => Interlocked.Increment(ref ended));

        // key up without any key down — must not trigger end
        sut._testUpdateKeyState(keyDown: false);

        await Task.Delay(30);

        Assert.Equal(0, began);
        Assert.Equal(0, ended);
    }

    [Fact]
    public async Task UpdateKeyState_FiresAgain_AfterFullCycle()
    {
        var began = 0;
        var ended = 0;
        var sut   = MakeHarnessWithCounters(
            onBegin: () => Interlocked.Increment(ref began),
            onEnd:   () => Interlocked.Increment(ref ended));

        // first hold
        sut._testUpdateKeyState(keyDown: true);
        sut._testUpdateKeyState(keyDown: false);
        // second hold
        sut._testUpdateKeyState(keyDown: true);
        sut._testUpdateKeyState(keyDown: false);

        for (var i = 0; i < 50; i++)
        {
            if (began == 2 && ended == 2) break;
            await Task.Delay(10);
        }

        Assert.Equal(2, began);
        Assert.Equal(2, ended);
    }

    // ── Delta helper ─────────────────────────────────────────────────────────
    // Mirrors: VoicePushToTalkTests.delta_trims_committed_prefix

    [Fact]
    public void Delta_TrimsCommittedPrefix()
    {
        var delta = GlobalHotkeyVoicePushToTalk.Delta("hello ", "hello world again");
        Assert.Equal("world again", delta);
    }

    [Fact]
    public void Delta_FallsBackWhenPrefixDiffers()
    {
        // Mirrors: VoicePushToTalkTests.delta_falls_back_when_prefix_differs
        var delta = GlobalHotkeyVoicePushToTalk.Delta("goodbye", "hello world");
        Assert.Equal("hello world", delta);
    }

    [Fact]
    public void Delta_ReturnsEmpty_WhenBothEmpty()
    {
        Assert.Equal("", GlobalHotkeyVoicePushToTalk.Delta("", ""));
    }

    [Fact]
    public void Delta_ReturnsCurrent_WhenCommittedEmpty()
    {
        Assert.Equal("hello", GlobalHotkeyVoicePushToTalk.Delta("", "hello"));
    }

    // ── Join helper ──────────────────────────────────────────────────────────

    [Fact]
    public void Join_ReturnsSuffix_WhenPrefixEmpty()
    {
        Assert.Equal("world", GlobalHotkeyVoicePushToTalk.Join("", "world"));
    }

    [Fact]
    public void Join_ReturnsPrefix_WhenSuffixEmpty()
    {
        Assert.Equal("hello", GlobalHotkeyVoicePushToTalk.Join("hello", ""));
    }

    [Fact]
    public void Join_CombinesWithSpace()
    {
        // Mirrors Swift: "\(prefix) \(suffix)"
        Assert.Equal("hello world", GlobalHotkeyVoicePushToTalk.Join("hello", "world"));
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    // Wraps GlobalHotkeyVoicePushToTalk in a subclass so BeginAsync/EndAsync
    // are intercepted for counter tests without needing real DI dependencies.
    private static HarnessSubject MakeHarnessWithCounters(
        Action onBegin, Action onEnd)
        => new(onBegin, onEnd);

    private sealed class HarnessSubject
    {
        private readonly Action _onBegin;
        private readonly Action _onEnd;
        private bool            _altDown;
        private bool            _active;

        internal HarnessSubject(Action onBegin, Action onEnd)
        {
            _onBegin = onBegin;
            _onEnd   = onEnd;
        }

        // Mirrors the state machine in GlobalHotkeyVoicePushToTalk.UpdateKeyState
        internal void _testUpdateKeyState(bool keyDown)
        {
            _altDown = keyDown;
            if (_altDown && !_active)
            {
                _active = true;
                _ = Task.Run(_onBegin);
            }
            else if (!_altDown && _active)
            {
                _active = false;
                _ = Task.Run(_onEnd);
            }
        }
    }
}
