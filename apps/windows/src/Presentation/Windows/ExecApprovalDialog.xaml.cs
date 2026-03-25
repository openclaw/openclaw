using OpenClawWindows.Domain.ExecApprovals;
using OpenClawWindows.Presentation.ViewModels;

namespace OpenClawWindows.Presentation.Windows;

internal sealed partial class ExecApprovalDialog : ContentDialog
{
    // Default to Deny so that closing the dialog without clicking is always safe.
    public ExecApprovalDecision DialogResult { get; private set; } = ExecApprovalDecision.Deny;

    public ExecApprovalDialog(ExecApprovalViewModel vm)
    {
        InitializeComponent();
        DataContext = vm;

        // Primary   = "Allow Once"   → allowOnce
        // Secondary = "Allow Always" → allowAlways (adds to allowlist in macOS)
        // Close     = "Deny"         → deny (safe default, also the CloseButton)
        PrimaryButtonClick   += (_, _) => DialogResult = ExecApprovalDecision.AllowOnce;
        SecondaryButtonClick += (_, _) => DialogResult = ExecApprovalDecision.AllowAlways;
        CloseButtonClick     += (_, _) => DialogResult = ExecApprovalDecision.Deny;
    }
}
