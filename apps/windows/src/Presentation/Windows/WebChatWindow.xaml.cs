using Microsoft.UI.Dispatching;
using Microsoft.UI.Windowing;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Media.Animation;
using Microsoft.UI.Xaml.Shapes;
using OpenClawWindows.Domain.Chat;
using OpenClawWindows.Presentation.Helpers;
using OpenClawWindows.Presentation.ViewModels;
using Windows.ApplicationModel.DataTransfer;
using Windows.Graphics.Imaging;
using Windows.Storage;
using Windows.Storage.Streams;

namespace OpenClawWindows.Presentation.Windows;

internal sealed partial class WebChatWindow : Window
{
    // Tunables
    private const int WindowLogicalWidth  = 500;
    private const int WindowLogicalHeight = 840;
    private const int WindowMinWidth      = 480;
    private const int WindowMinHeight     = 360;
    private const int PanelLogicalWidth   = 480;
    private const int PanelLogicalHeight  = 640;

    private readonly WebChatViewModel _vm;
    private readonly bool             _isPanel;
    private          Storyboard?      _typingStoryboard;
    private          bool             _isClosing;
    private          bool             _streamingUpdatePending;
    // Suppresses SizeChanged scroll until the first MessagesUpdated fires.
    // Prevents a storm of 100+ Low-priority ChangeView calls during initial render.
    private          bool             _initialLoadDone;
    private readonly global::Windows.UI.ViewManagement.UISettings _uiSettings = new();

    public WebChatWindow(WebChatViewModel vm, string sessionKey, bool isPanel)
    {
        _vm      = vm;
        _isPanel = isPanel;
        InitializeComponent();
        if (Content is FrameworkElement fe) fe.DataContext = vm;
        Title = "OpenClaw Chat";

        _vm.MessagesUpdated += OnMessagesUpdated;
        _vm.PropertyChanged += OnVmPropertyChanged;
        Closed += OnWindowClosed;

        _vm.Initialize(sessionKey, DispatcherQueue, this);
        ConfigureWindow();

        // WinUI3: RichTextBlock with IsTextSelectionEnabled=True marks PointerWheelChanged as
        // Handled before it reaches the ScrollViewer. Re-attach with handledEventsToo=true.
        MessageScroll.AddHandler(
            UIElement.PointerWheelChangedEvent,
            new Microsoft.UI.Xaml.Input.PointerEventHandler(OnMessageScrollPointerWheel),
            handledEventsToo: true);
    }

    private void OnWindowClosed(object sender, WindowEventArgs args)
    {
        _isClosing = true;
        _vm.MessagesUpdated -= OnMessagesUpdated;
        _vm.PropertyChanged -= OnVmPropertyChanged;
        StopTypingAnimation();
    }

    // Marshalled to UI thread — VM may fire from background (Task.Run in BootstrapAsync).
    private void OnMessagesUpdated()
    {
        DispatcherQueue.TryEnqueue(() =>
        {
            if (_isClosing) return;
            _initialLoadDone = true;
            ScrollToBottom();
        });
    }

    // Marshalled to UI thread. Coalescence for StreamingAssistantText to avoid flooding the queue.
    private void OnVmPropertyChanged(object? sender, System.ComponentModel.PropertyChangedEventArgs e)
    {
        if (e.PropertyName == nameof(WebChatViewModel.StreamingAssistantText))
        {
            if (_streamingUpdatePending) return;
            _streamingUpdatePending = true;
            DispatcherQueue.TryEnqueue(() =>
            {
                _streamingUpdatePending = false;
                if (_isClosing) return;
                UpdateStreamingTextFast(_vm.StreamingAssistantText ?? string.Empty);
                ScrollIfPinned();
            });
            return;
        }

        // Fast path: skip the TryEnqueue entirely for properties that drive no code-behind work.
        // During initial load, Messages.Add fires ~3 PropertyChanged per message (IsEmptyState etc.)
        // — without this guard that generates hundreds of no-op enqueues.
        if (e.PropertyName != nameof(WebChatViewModel.IsTyping) &&
            e.PropertyName != nameof(WebChatViewModel.SessionChoices) &&
            e.PropertyName != nameof(WebChatViewModel.CurrentSessionKey) &&
            e.PropertyName != nameof(WebChatViewModel.IsSending))
            return;

        DispatcherQueue.TryEnqueue(() =>
        {
            if (_isClosing) return;

            if (e.PropertyName == nameof(WebChatViewModel.IsTyping))
                UpdateTypingAnimation();

            if (e.PropertyName == nameof(WebChatViewModel.SessionChoices) ||
                e.PropertyName == nameof(WebChatViewModel.CurrentSessionKey))
            {
                SetPinned(true);
                SyncSessionPickerSelection();
            }

            if (e.PropertyName == nameof(WebChatViewModel.IsSending) && _vm.IsSending)
                ForceScrollToBottom();
        });
    }

    // ── Scroll ──
    // _isPinnedToBottom: auto-scroll active (true by default).
    // UNPIN: wheel up, or ViewChanged detects not-at-bottom after scroll completes.
    // REPIN: ViewChanged detects at-bottom, or ScrollToBottom/ForceScrollToBottom called.
    private const double ScrollBottomThreshold = 80;
    private bool _isPinnedToBottom = true;

    private bool AtBottom() =>
        MessageScroll.ScrollableHeight - MessageScroll.VerticalOffset < ScrollBottomThreshold;

    private void SetPinned(bool pinned)
    {
        _isPinnedToBottom = pinned;
        UpdateScrollButton();
    }

    private void ScrollIfPinned()
    {
        if (!_isPinnedToBottom || _isClosing) return;
        ScrollToBottomCore();
    }

    private void ScrollToBottom()
    {
        SetPinned(true);
        ScrollToBottomCore();
    }

    private void ForceScrollToBottom()
    {
        if (_isClosing) return;
        SetPinned(true);
        ScrollToBottomCore();
    }

    private void ScrollToBottomCore()
    {
        var scrollable = MessageScroll.ScrollableHeight;
        if (scrollable <= 0) return; // layout not ready — SizeChanged will retry
        MessageScroll.ChangeView(null, scrollable, null, disableAnimation: true);
    }

    private void MessageContainer_SizeChanged(object sender, SizeChangedEventArgs e)
    {
        if (_isClosing || !_initialLoadDone) return;
        ScrollIfPinned();
        // Only recompute bubble width when the container width actually changed,
        // not when height changes due to new messages arriving.
        if (e.NewSize.Width != e.PreviousSize.Width)
            _vm.BubbleMaxWidth = Math.Max(200, (MessageContainer.ActualWidth - 24) * 0.72);
    }

    private void MessageScroll_ViewChanged(object? sender, ScrollViewerViewChangedEventArgs e)
    {
        if (_isClosing) return;
        // ViewChanged is used ONLY to re-pin when user scrolls back to bottom.
        // Unpinning is handled exclusively by OnMessageScrollPointerWheel (wheel up).
        // We cannot reliably distinguish user-drag from programmatic ChangeView here —
        // especially with multiple ChangeViews queued, where a flag-based approach
        // causes the second ViewChanged to incorrectly unpin.
        if (AtBottom())
            SetPinned(true);
    }

    private void UpdateScrollButton()
    {
        ScrollToBottomBtn.Visibility = (!AtBottom() && !_isPinnedToBottom)
            ? Microsoft.UI.Xaml.Visibility.Visible
            : Microsoft.UI.Xaml.Visibility.Collapsed;
    }

    private void ScrollToBottomBtn_Click(object sender, RoutedEventArgs e)
    {
        ForceScrollToBottom();
    }

    // Wheel handler: unpin on scroll up, re-dispatch when RichTextBlock ate the event.
    private void OnMessageScrollPointerWheel(object sender, Microsoft.UI.Xaml.Input.PointerRoutedEventArgs e)
    {
        var delta = e.GetCurrentPoint(MessageScroll).Properties.MouseWheelDelta;

        if (delta > 0)
            SetPinned(false);

        if (e.Handled)
        {
            var pixels = (delta / 120.0) * 3.0 * 16.0;
            var newOffset = Math.Clamp(
                MessageScroll.VerticalOffset - pixels,
                0,
                MessageScroll.ScrollableHeight);
            MessageScroll.ChangeView(null, newOffset, null, disableAnimation: true);
        }
    }

    private async void MarkdownTextBlock_LinkClicked(object sender, CommunityToolkit.WinUI.UI.Controls.LinkClickedEventArgs e)
    {
        if (Uri.TryCreate(e.Link, UriKind.Absolute, out var uri))
            await global::Windows.System.Launcher.LaunchUriAsync(uri);
    }

    // Fast streaming text update: reuse a single Paragraph/Run instead of clear+rebuild.
    // Avoids the height oscillation that causes viewport dancing during streaming.
    private Microsoft.UI.Xaml.Documents.Paragraph? _streamingPara;
    private Microsoft.UI.Xaml.Documents.Run? _streamingRun;

    private void UpdateStreamingTextFast(string text)
    {
        if (string.IsNullOrEmpty(text))
        {
            StreamingRtb.Blocks.Clear();
            _streamingPara = null;
            _streamingRun = null;
            return;
        }

        text = Helpers.AssistantTextParser.StripThinking(text);
        text = Helpers.ChatMarkdownPreprocessor.Preprocess(text);
        if (string.IsNullOrEmpty(text))
        {
            StreamingRtb.Blocks.Clear();
            _streamingPara = null;
            _streamingRun = null;
            return;
        }

        if (_streamingRun is not null && _streamingPara is not null)
        {
            _streamingRun.Text = text;
        }
        else
        {
            _streamingRun = new Microsoft.UI.Xaml.Documents.Run { Text = text };
            _streamingPara = new Microsoft.UI.Xaml.Documents.Paragraph();
            _streamingPara.Inlines.Add(_streamingRun);
            StreamingRtb.Blocks.Clear();
            StreamingRtb.Blocks.Add(_streamingPara);
        }
    }

    private void ConfigureWindow()
    {
        var appWin = AppWindow;

        if (_isPanel)
        {
            // Borderless panel
            var presenter = OverlappedPresenter.CreateForDialog();
            presenter.IsAlwaysOnTop = false;
            presenter.IsResizable   = false;
            presenter.IsMaximizable = false;
            presenter.IsMinimizable = false;
            presenter.SetBorderAndTitleBar(hasBorder: true, hasTitleBar: false);
            appWin.SetPresenter(presenter);
            // Prevent taskbar button — panels are floating overlays, not taskbar entries.
            appWin.IsShownInSwitchers = false;
            appWin.Resize(ScaleToPhysical(PanelLogicalWidth, PanelLogicalHeight));
        }
        else
        {
            // Standard resizable window
            var presenter = OverlappedPresenter.Create();
            presenter.IsResizable   = true;
            presenter.IsMaximizable = true;
            appWin.SetPresenter(presenter);
            appWin.Resize(ScaleToPhysical(WindowLogicalWidth, WindowLogicalHeight));
            if (Content is FrameworkElement root)
            {
                root.MinWidth  = WindowMinWidth;
                root.MinHeight = WindowMinHeight;
            }
        }

        // SetIcon must come after SetPresenter — changing the presenter resets the icon.
        var iconPath = System.IO.Path.Combine(AppContext.BaseDirectory, "Assets", "openclaw.ico");
        if (System.IO.File.Exists(iconPath))
            appWin.SetIcon(iconPath);
    }

    // Position panel anchored above the given physical pixel cursor point (tray icon area).
    public void PositionNearPoint(global::Windows.Graphics.PointInt32 anchor)
    {
        var appWin = AppWindow;
        var size   = appWin.Size;
        var da     = DisplayArea.GetFromPoint(anchor, DisplayAreaFallback.Primary);
        var work   = da.WorkArea;

        int x = Math.Clamp(anchor.X - size.Width / 2, work.X + 8, work.X + work.Width  - size.Width  - 8);
        int y = Math.Clamp(anchor.Y - size.Height - 8, work.Y + 8, work.Y + work.Height - size.Height - 8);

        appWin.Move(new global::Windows.Graphics.PointInt32(x, y));
    }

    // Enter key (without Shift) submits; Ctrl+V intercepts clipboard images.
    private void ComposeBox_KeyDown(object sender, KeyRoutedEventArgs e)
    {
        if (e.Key == global::Windows.System.VirtualKey.V &&
            (Microsoft.UI.Input.InputKeyboardSource.GetKeyStateForCurrentThread(
                global::Windows.System.VirtualKey.Control) &
             global::Windows.UI.Core.CoreVirtualKeyStates.Down) != 0)
        {
            var data = Clipboard.GetContent();
            // Bitmap in clipboard (screenshot, copied image from browser/app).
            if (data.Contains(StandardDataFormats.Bitmap))
            {
                e.Handled = true;
                _ = PasteClipboardBitmapAsync(data);
                return;
            }
            // Image files copied from Explorer — side-channel; let TextBox paste be a no-op.
            if (data.Contains(StandardDataFormats.StorageItems))
                _ = PasteClipboardStorageItemsAsync(data);
        }

        if (e.Key == global::Windows.System.VirtualKey.Enter)
        {
            var shiftDown = (Microsoft.UI.Input.InputKeyboardSource.GetKeyStateForCurrentThread(
                global::Windows.System.VirtualKey.Shift) &
                global::Windows.UI.Core.CoreVirtualKeyStates.Down) != 0;

            if (!shiftDown)
            {
                // PreviewKeyDown: fires BEFORE TextBox processes the key.
                // Setting Handled=true prevents the newline from being inserted.
                e.Handled = true;
                if (_vm.SendMessageCommand.CanExecute(null))
                    _vm.SendMessageCommand.Execute(null);
            }
        }
    }

    // Reads clipboard bitmap, encodes to PNG, adds as attachment.
    private async Task PasteClipboardBitmapAsync(DataPackageView data)
    {
        try
        {
            var streamRef = await data.GetBitmapAsync();
            using var stream  = await streamRef.OpenReadAsync();
            var decoder = await BitmapDecoder.CreateAsync(stream);
            var soft    = await decoder.GetSoftwareBitmapAsync();

            var ms      = new InMemoryRandomAccessStream();
            var encoder = await BitmapEncoder.CreateAsync(BitmapEncoder.PngEncoderId, ms);
            encoder.SetSoftwareBitmap(soft);
            await encoder.FlushAsync();

            ms.Seek(0);
            var bytes = new byte[(int)ms.Size];
            using var reader = new DataReader(ms);
            await reader.LoadAsync((uint)ms.Size);
            reader.ReadBytes(bytes);

            _vm.AddImageBytes(bytes, $"pasted-{Guid.NewGuid():N}.png", "image/png");
        }
        catch { /* best-effort */ }
    }

    // Reads image files from clipboard StorageItems, adds each as attachment.
    private async Task PasteClipboardStorageItemsAsync(DataPackageView data)
    {
        try
        {
            var items = await data.GetStorageItemsAsync();
            var paths = items
                .OfType<StorageFile>()
                .Where(f => IsImageExtension(System.IO.Path.GetExtension(f.Name)))
                .Select(f => f.Path)
                .Where(p => !string.IsNullOrEmpty(p));
            await _vm.AddFilesFromPathsAsync(paths);
        }
        catch { /* best-effort */ }
    }

    private static bool IsImageExtension(string ext) =>
        ext.ToLowerInvariant() is ".png" or ".jpg" or ".jpeg" or ".gif"
            or ".bmp" or ".tiff" or ".tif" or ".heic" or ".heif" or ".webp";

    // Drag & drop
    private void Grid_DragOver(object sender, DragEventArgs e)
    {
        if (e.DataView.Contains(global::Windows.ApplicationModel.DataTransfer.StandardDataFormats.StorageItems))
        {
            e.AcceptedOperation = global::Windows.ApplicationModel.DataTransfer.DataPackageOperation.Copy;
            e.DragUIOverride.Caption = "Drop to attach";
            e.DragUIOverride.IsCaptionVisible = true;
        }
    }

    private async void Grid_Drop(object sender, DragEventArgs e)
    {
        try
        {
            if (!e.DataView.Contains(global::Windows.ApplicationModel.DataTransfer.StandardDataFormats.StorageItems))
                return;

            var items = await e.DataView.GetStorageItemsAsync();
            var paths = items
                .OfType<global::Windows.Storage.StorageFile>()
                .Select(f => f.Path)
                .Where(p => !string.IsNullOrEmpty(p));

            await _vm.AddFilesFromPathsAsync(paths);
        }
        catch { /* best-effort */ }
    }

    // Typing indicator animation
    // Three dots, opacity 0.30→0.95, easeInOut 0.55s, staggered delay 0/0.16/0.32s.
    private void UpdateTypingAnimation()
    {
        if (_vm.IsTyping)
            StartTypingAnimation();
        else
            StopTypingAnimation();
    }

    private void StartTypingAnimation()
    {
        if (_typingStoryboard != null) return;

        // Respect accessibility
        if (!_uiSettings.AnimationsEnabled) return;

        var sb = new Storyboard { RepeatBehavior = RepeatBehavior.Forever };

        AddTypingDotAnimation(sb, TypingDot0, 0.00);
        AddTypingDotAnimation(sb, TypingDot1, 0.16);
        AddTypingDotAnimation(sb, TypingDot2, 0.32);

        _typingStoryboard = sb;
        sb.Begin();
    }

    private static void AddTypingDotAnimation(Storyboard sb, Ellipse dot, double delaySecs)
    {
        var anim = new DoubleAnimation
        {
            From            = 0.30,
            To              = 0.95,
            Duration        = new Duration(TimeSpan.FromSeconds(0.55)),
            AutoReverse     = true,
            BeginTime       = TimeSpan.FromSeconds(delaySecs),
            EasingFunction  = new CubicEase { EasingMode = EasingMode.EaseInOut },
        };
        Storyboard.SetTarget(anim, dot);
        Storyboard.SetTargetProperty(anim, "Opacity");
        sb.Children.Add(anim);
    }

    private void StopTypingAnimation()
    {
        _typingStoryboard?.Stop();
        _typingStoryboard = null;
        TypingDot0.Opacity = 0.30;
        TypingDot1.Opacity = 0.30;
        TypingDot2.Opacity = 0.30;
    }

    // Sync the ComboBox selected item with the VM's current session key after the list updates.
    private void SyncSessionPickerSelection()
    {
        _sessionPickerChanging = true;
        var currentKey = _vm.CurrentSessionKey;
        var current = SessionPicker.Items
            .OfType<Application.Ports.ChatSessionEntry>()
            .FirstOrDefault(s => s.Key == currentKey);
        SessionPicker.SelectedItem = current;
        _sessionPickerChanging = false;
    }

    // Session picker
    private bool _sessionPickerChanging;

    private void SessionPicker_SelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        if (_sessionPickerChanging) return;
        if (sender is not ComboBox cb) return;
        if (cb.SelectedItem is not Application.Ports.ChatSessionEntry entry) return;
        _vm.SwitchSessionCommand.Execute(entry.Key);
    }

    [System.Runtime.InteropServices.DllImport("User32.dll")]
    private static extern uint GetDpiForWindow(IntPtr hwnd);

    private global::Windows.Graphics.SizeInt32 ScaleToPhysical(int logicalW, int logicalH)
    {
        var hwnd = WinRT.Interop.WindowNative.GetWindowHandle(this);
        var dpi = GetDpiForWindow(hwnd);
        float scale = dpi > 0 ? dpi / 96.0f : 1.25f;
        return new global::Windows.Graphics.SizeInt32(
            (int)(logicalW * scale),
            (int)(logicalH * scale));
    }
}
