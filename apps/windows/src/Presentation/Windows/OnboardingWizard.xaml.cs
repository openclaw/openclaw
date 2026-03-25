using OpenClawWindows.Presentation.ViewModels;

namespace OpenClawWindows.Presentation.Windows;

/// <summary>
/// Gateway-powered setup wizard.
/// </summary>
internal sealed partial class OnboardingWizard : Window
{
    private readonly OnboardingViewModel _vm;

    public OnboardingWizard(OnboardingViewModel vm)
    {
        _vm = vm;
        InitializeComponent();
        if (Content is FrameworkElement fe) fe.DataContext = vm;
        Title = "Welcome to OpenClaw";
        AppWindow.Resize(new global::Windows.Graphics.SizeInt32(540, 700));

        // Start the gateway wizard as soon as the window opens.
        // Idempotent — no-ops if already running or complete.
        _ = vm.StartAsync();

        // Auto-close when the wizard finishes (IsComplete transitions to true).
        vm.PropertyChanged += (_, e) =>
        {
            if (e.PropertyName == nameof(OnboardingViewModel.IsComplete) && vm.IsComplete)
                DispatcherQueue.TryEnqueue(Close);
        };
    }

    // ── Code-behind event handlers ────────────────────────────────────────────

    // PasswordBox.Password is not a dependency property — sync to PasswordInput via event.
    private void StepPasswordBox_PasswordChanged(object sender, RoutedEventArgs e)
    {
        if (sender is PasswordBox pb)
            _vm.PasswordInput = pb.Password;
    }

    // Radio-style selection for "select" steps: clicking a row sets SelectedOptionIndex.
    private void SelectOption_Click(object sender, RoutedEventArgs e)
    {
        if (sender is Button btn && btn.Tag is int index)
            _vm.SelectedOptionIndex = index;
    }

    private void FinishButton_Click(object sender, RoutedEventArgs e) => Close();
}
