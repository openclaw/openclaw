using OpenClawWindows.Presentation.ViewModels;

namespace OpenClawWindows.Presentation.Onboarding;

internal sealed partial class ReadyPage : Page
{
    public ReadyPage() => InitializeComponent();

    protected override void OnNavigatedTo(NavigationEventArgs e)
    {
        if (e.Parameter is OnboardingFlowViewModel vm)
            DataContext = vm;
    }
}
