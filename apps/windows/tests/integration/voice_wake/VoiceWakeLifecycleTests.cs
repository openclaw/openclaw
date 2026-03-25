using Microsoft.Extensions.Logging.Abstractions;
using OpenClawWindows.Infrastructure.VoiceWake;

namespace OpenClawWindows.Tests.Integration.VoiceWake;

// Integration: PorcupineWakeWordAdapter stub surface (SPIKE-004 blocked).
// Verifies the adapter compiles, wires into DI, and contracts are upheld:
// IsAvailable=false, Start returns failure, Stop is graceful.
public sealed class VoiceWakeLifecycleTests
{
    private static PorcupineWakeWordAdapter MakeAdapter() =>
        new(NullLogger<PorcupineWakeWordAdapter>.Instance);

    [Fact]
    public void IsAvailable_ReturnsFalse_WhileSpike004Pending()
    {
        var adapter = MakeAdapter();
        adapter.IsAvailable.Should().BeFalse();
    }

    [Fact]
    public void IsRunning_Initially_ReturnsFalse()
    {
        var adapter = MakeAdapter();
        adapter.IsRunning.Should().BeFalse();
    }

    [Fact]
    public void WasSuspendedByBatterySaver_Always_ReturnsFalse()
    {
        var adapter = MakeAdapter();
        adapter.WasSuspendedByBatterySaver.Should().BeFalse();
    }

    [Fact]
    public async Task StartAsync_ReturnsFailureWithSpike004Code()
    {
        var adapter = MakeAdapter();

        var result = await adapter.StartAsync(CancellationToken.None);

        result.IsError.Should().BeTrue();
        result.FirstError.Code.Should().Be("SPIKE_004");
    }

    [Fact]
    public async Task StopAsync_IsIdempotent_DoesNotThrow()
    {
        var adapter = MakeAdapter();

        // Stop before any Start — should not throw
        await adapter.StopAsync(CancellationToken.None);

        adapter.IsRunning.Should().BeFalse();
    }

    [Fact]
    public async Task StopAsync_AfterStartAttempt_LeavesRunningFalse()
    {
        var adapter = MakeAdapter();

        await adapter.StartAsync(CancellationToken.None); // returns error but does not crash
        await adapter.StopAsync(CancellationToken.None);

        adapter.IsRunning.Should().BeFalse();
    }

    [Fact]
    public async Task SetSensitivityAsync_IsNoOp_DoesNotThrow()
    {
        var adapter = MakeAdapter();

        // Any sensitivity value in [0,1] must be accepted silently
        await adapter.SetSensitivityAsync(0.7f, CancellationToken.None);
        await adapter.SetSensitivityAsync(0.0f, CancellationToken.None);
        await adapter.SetSensitivityAsync(1.0f, CancellationToken.None);
    }
}
