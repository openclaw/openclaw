using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging.Abstractions;
using OpenClawWindows.Infrastructure.Lifecycle;

namespace OpenClawWindows.Tests.Unit.Infrastructure.System;

public sealed class TerminationSignalWatcherTests
{
    private readonly IHostApplicationLifetime _lifetime = Substitute.For<IHostApplicationLifetime>();

    private TerminationSignalWatcher Make() => new(NullLogger<TerminationSignalWatcher>.Instance, _lifetime)
    {
        // Replace Environment.Exit(0) with a no-op so the safety net
        // doesn't kill the test runner process.
        TerminateProcess = _ => { }
    };

    [Fact]
    public void Start_InstallsBothSignals()
    {
        using var watcher = Make();
        watcher.Start();
        watcher.RegistrationCount.Should().Be(2);
    }

    [Fact]
    public void Start_Idempotent_DoesNotDuplicateRegistrations()
    {
        using var watcher = Make();
        watcher.Start();
        watcher.Start();
        watcher.RegistrationCount.Should().Be(2);
    }

    [Fact]
    public void Stop_ClearsRegistrations()
    {
        using var watcher = Make();
        watcher.Start();
        watcher.Stop();
        watcher.RegistrationCount.Should().Be(0);
    }

    [Fact]
    public void Stop_AllowsRestart()
    {
        using var watcher = Make();
        watcher.Start();
        watcher.Stop();
        watcher.Start();
        watcher.RegistrationCount.Should().Be(2);
    }

    [Fact]
    public async Task StartAsync_InstallsSignals()
    {
        using var watcher = Make();
        await watcher.StartAsync(CancellationToken.None);
        watcher.RegistrationCount.Should().Be(2);
    }

    [Fact]
    public async Task StopAsync_ClearsRegistrations()
    {
        using var watcher = Make();
        await watcher.StartAsync(CancellationToken.None);
        await watcher.StopAsync(CancellationToken.None);
        watcher.RegistrationCount.Should().Be(0);
    }

    [Fact]
    public void Handle_CallsStopApplication()
    {
        using var watcher = Make();
        watcher.Handle(15); // SIGTERM
        _lifetime.Received(1).StopApplication();
    }

    [Fact]
    public void Handle_Idempotent_StopsApplicationOnlyOnce()
    {
        using var watcher = Make();
        watcher.Handle(15);
        watcher.Handle(15);
        _lifetime.Received(1).StopApplication();
    }

    [Fact]
    public void Handle_DifferentSignal_StillIdempotent()
    {
        // Once termination is requested for any signal, a second signal is ignored.
        using var watcher = Make();
        watcher.Handle(15); // SIGTERM
        watcher.Handle(2);  // SIGINT
        _lifetime.Received(1).StopApplication();
    }

    [Fact]
    public void Stop_AfterHandle_ResetsTerminationFlag()
    {
        using var watcher = Make();
        watcher.Handle(15);
        watcher.Stop();
        // After Stop(), a new signal should be handleable again.
        watcher.Handle(15);
        _lifetime.Received(2).StopApplication();
    }
}
