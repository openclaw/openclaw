using OpenClawWindows.Presentation.Onboarding;
using OpenClawWindows.Presentation.ViewModels;

namespace OpenClawWindows.Presentation.Windows;

/// <summary>
/// Multi-page onboarding flow: Welcome → Connection → (Wizard dialog) → Ready.
/// </summary>
internal sealed partial class OnboardingWindow : Window
{
    private readonly OnboardingFlowViewModel _vm;

    public OnboardingWindow(OnboardingFlowViewModel vm)
    {
        _vm = vm;
        InitializeComponent();
        if (Content is FrameworkElement fe) fe.DataContext = vm;
        Title = "Welcome to OpenClaw";
        AppWindow.Resize(new global::Windows.Graphics.SizeInt32(520, 700));
        AppWindow.SetIcon(System.IO.Path.Combine(AppContext.BaseDirectory, "Assets", "openclaw.ico"));

        vm.RequestClose       += () => DispatcherQueue.TryEnqueue(Close);
        vm.NavigationRequested += OnNavigationRequested;
        vm.WizardRequested     += OnWizardRequested;

        Activated += (_, _) => vm.OnWindowAppeared();
        Closed    += (_, _) => vm.OnWindowClosed();
    }

    private void OnNavigationRequested(int pageId)
    {
        var pageType = pageId switch
        {
            OnboardingFlowViewModel.ConnectionPageId => typeof(ConnectionPage),
            OnboardingFlowViewModel.ReadyPageId      => typeof(ReadyPage),
            _                                        => typeof(WelcomePage),
        };
        ContentFrame.Navigate(pageType, _vm);
    }

    private async void OnWizardRequested()
    {
        // Await StartAsync first so the skip check runs before we decide whether
        // to show the dialog at all.
        await _vm.WizardVm.StartAsync();

        if (_vm.WizardVm.IsComplete)
        {
            // Wizard was skipped (already configured) — advance directly.
            await _vm.OnWizardCompleted();
            return;
        }

        var dialog = new GatewayWizardDialog(_vm.WizardVm)
        {
            XamlRoot = Content.XamlRoot
        };

        var result = await dialog.ShowAsync();

        if (result == ContentDialogResult.None || result == ContentDialogResult.Secondary)
        {
            _vm.OnWizardCancelled();
        }
        else if (_vm.WizardVm.IsComplete)
        {
            await _vm.OnWizardCompleted();
        }
    }
}
