using OpenClawWindows.Presentation.ViewModels;

namespace OpenClawWindows.Presentation.Onboarding;

internal sealed partial class ConnectionPage : Page
{
    public ConnectionPage() => InitializeComponent();

    protected override void OnNavigatedTo(NavigationEventArgs e)
    {
        if (e.Parameter is OnboardingFlowViewModel vm)
            DataContext = vm;
    }

    private void LocalChoiceButton_Click(object sender, RoutedEventArgs e)
    {
        if (DataContext is OnboardingFlowViewModel vm) vm.SelectLocal();
    }

    private void GatewayChoiceButton_Click(object sender, RoutedEventArgs e)
    {
        if (sender is Button { Tag: DiscoveredGatewayItem item } &&
            DataContext is OnboardingFlowViewModel vm)
            vm.SelectGateway(item);
    }

    private void UnconfiguredChoiceButton_Click(object sender, RoutedEventArgs e)
    {
        if (DataContext is OnboardingFlowViewModel vm) vm.SelectUnconfigured();
    }
}
