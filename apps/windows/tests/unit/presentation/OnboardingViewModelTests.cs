using OpenClawWindows.Application.Ports;
using OpenClawWindows.Domain.Settings;
using OpenClawWindows.Presentation.ViewModels;

namespace OpenClawWindows.Tests.Unit.Presentation;

// OnboardingViewModel is a gateway-powered wizard (not a page-based nav VM).
// Tests cover observable initial state only — RPC-driven transitions require integration tests.
public sealed class OnboardingViewModelTests
{
    private static OnboardingViewModel BuildVm()
    {
        var rpc = Substitute.For<IGatewayRpcChannel>();
        var settings = Substitute.For<ISettingsRepository>();
        return new OnboardingViewModel(rpc, settings);
    }

    [Fact]
    public void Ctor_IsNotStarting()
    {
        var vm = BuildVm();
        Assert.False(vm.IsStarting);
    }

    [Fact]
    public void Ctor_IsNotComplete()
    {
        var vm = BuildVm();
        Assert.False(vm.IsComplete);
    }

    [Fact]
    public void Ctor_ShowStepContentIsFalse_WhenNoStep()
    {
        var vm = BuildVm();
        // No step received yet — content should be hidden
        Assert.False(vm.ShowStepContent);
    }

    [Fact]
    public void Ctor_CanSubmitIsFalse_WhenNoStep()
    {
        var vm = BuildVm();
        Assert.False(vm.CanSubmit);
    }

    [Fact]
    public void Ctor_ShowLoadingIsFalse_Initially()
    {
        var vm = BuildVm();
        Assert.False(vm.ShowLoading);
    }

    [Fact]
    public void Ctor_ShowErrorIsFalse_Initially()
    {
        var vm = BuildVm();
        Assert.False(vm.ShowError);
    }
}
