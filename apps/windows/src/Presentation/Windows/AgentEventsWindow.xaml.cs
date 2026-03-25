using OpenClawWindows.Presentation.ViewModels;

namespace OpenClawWindows.Presentation.Windows;

internal sealed partial class AgentEventsWindow : Window
{
    public AgentEventsWindow(AgentEventsViewModel vm)
    {
        InitializeComponent();
        if (Content is FrameworkElement fe) fe.DataContext = vm;
        Title = "Agent Events";
        AppWindow.Resize(new global::Windows.Graphics.SizeInt32(520, 360));
    }
}
