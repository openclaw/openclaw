using System.Collections.ObjectModel;
using OpenClawWindows.Application.Sessions;
using OpenClawWindows.Domain.Sessions;

namespace OpenClawWindows.Presentation.ViewModels;

internal sealed partial class SessionsSettingsViewModel : ObservableObject
{
    private readonly ISender _sender;

    public ObservableCollection<SessionRow> Sessions { get; } = [];

    [ObservableProperty]
    private bool _isLoading;

    [ObservableProperty]
    private string? _lastError;

    public SessionsSettingsViewModel(ISender sender)
    {
        _sender = sender;
    }

    [RelayCommand]
    private async Task RefreshAsync()
    {
        IsLoading = true;
        LastError = null;
        try
        {
            Sessions.Clear();
            var result = await _sender.Send(new ListSessionsQuery(), CancellationToken.None);
            if (result.IsError)
            {
                LastError = result.FirstError.Description;
                return;
            }

            foreach (var row in result.Value.Rows)
                Sessions.Add(row);
        }
        finally
        {
            IsLoading = false;
        }
    }
}
