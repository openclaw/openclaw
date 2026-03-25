using OpenClawWindows.Application.Ports;
using OpenClawWindows.Application.Stores;
using OpenClawWindows.Domain.Updates;
using OpenClawWindows.Infrastructure.Gateway;
using OpenClawWindows.Presentation.ViewModels;

namespace OpenClawWindows.Tests.Unit.Presentation;

public sealed class SettingsViewModelTests
{
    private static SettingsViewModel BuildVm()
    {
        var sender        = Substitute.For<ISender>();
        var channelStore  = Substitute.For<IChannelStore>();
        var cronStore     = Substitute.For<ICronJobsStore>();
        var instanceStore = Substitute.For<IInstancesStore>();
        var permissions   = Substitute.For<IPermissionManager>();
        var health        = Substitute.For<IHealthStore>();
        var updater       = Substitute.For<IUpdaterController>();
        updater.UpdateStatus.Returns(UpdateStatus.Disabled);
        var tailscale     = Substitute.For<ITailscaleService>();
        var rpc           = Substitute.For<IGatewayRpcChannel>();
        var configStore   = Substitute.For<IConfigStore>();

        return new SettingsViewModel(
            new GeneralSettingsViewModel(sender, new TailscaleSettingsViewModel(sender, tailscale)),
            new ChannelsSettingsViewModel(channelStore),
            new SessionsSettingsViewModel(sender),
            new PermissionsSettingsViewModel(permissions),
            new VoiceWakeSettingsViewModel(sender),
            new ConfigSettingsViewModel(rpc, configStore),
            new SystemRunSettingsViewModel(sender, configStore),
            new SkillsSettingsViewModel(sender),
            new InstancesSettingsViewModel(instanceStore),
            new CronSettingsViewModel(sender, cronStore, channelStore),
            new DebugSettingsViewModel(sender, health, new OnboardingViewModel(Substitute.For<IGatewayRpcChannel>(), Substitute.For<ISettingsRepository>())),
            new AboutSettingsViewModel(updater));
    }

    [Fact]
    public void Ctor_AllSubViewModelsInitialized()
    {
        var vm = BuildVm();

        Assert.NotNull(vm.General);
        Assert.NotNull(vm.Channels);
        Assert.NotNull(vm.Sessions);
        Assert.NotNull(vm.Permissions);
        Assert.NotNull(vm.Config);
        Assert.NotNull(vm.SystemRun);
        Assert.NotNull(vm.Skills);
        Assert.NotNull(vm.Instances);
        Assert.NotNull(vm.Cron);
        Assert.NotNull(vm.Debug);
        Assert.NotNull(vm.About);
    }

    [Fact]
    public void DebugPaneEnabled_DefaultsFalse()
    {
        var vm = BuildVm();
        Assert.False(vm.DebugPaneEnabled);
    }

    [Fact]
    public void DebugPaneEnabled_CanBeToggled()
    {
        var vm = BuildVm();
        vm.DebugPaneEnabled = true;
        Assert.True(vm.DebugPaneEnabled);
    }
}
