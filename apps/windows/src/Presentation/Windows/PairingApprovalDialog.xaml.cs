using OpenClawWindows.Presentation.ViewModels;

namespace OpenClawWindows.Presentation.Windows;

internal sealed partial class PairingApprovalDialog : ContentDialog
{
    public PairingDecision DialogResult { get; private set; } = PairingDecision.Later;

    public PairingApprovalDialog(PairingApprovalViewModel vm)
    {
        InitializeComponent();
        DataContext = vm;

        PrimaryButtonClick   += (_, _) => DialogResult = PairingDecision.Approve;
        SecondaryButtonClick += (_, _) => DialogResult = PairingDecision.Reject;
        CloseButtonClick     += (_, _) => DialogResult = PairingDecision.Later;
    }
}

internal enum PairingDecision { Approve, Reject, Later }
