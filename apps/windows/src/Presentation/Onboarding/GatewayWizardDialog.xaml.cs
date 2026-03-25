using OpenClawWindows.Presentation.ViewModels;

namespace OpenClawWindows.Presentation.Onboarding;

internal sealed partial class GatewayWizardDialog : ContentDialog
{
    private readonly OnboardingViewModel _vm;

    internal GatewayWizardDialog(OnboardingViewModel vm)
    {
        _vm = vm;
        InitializeComponent();
        DataContext = vm;

        // Primary button submits the current step via the VM command.
        PrimaryButtonClick += async (_, args) =>
        {
            var deferral = args.GetDeferral();
            try
            {
                await vm.SubmitStepCommand.ExecuteAsync(null);
                // Keep dialog open unless wizard is done or an error appeared.
                args.Cancel = !vm.IsComplete && vm.ErrorMessage is null;
            }
            finally
            {
                deferral.Complete();
            }
        };
    }

    // PasswordBox.Password is not a DependencyProperty — sync via event.
    private void WizardPasswordBox_PasswordChanged(object sender, RoutedEventArgs e)
    {
        if (sender is PasswordBox pb) _vm.PasswordInput = pb.Password;
    }

    // Radio-style selection for "select" wizard steps.
    private void WizardSelectOption_Click(object sender, RoutedEventArgs e)
    {
        if (sender is Button { Tag: int index }) _vm.SelectedOptionIndex = index;
    }
}
