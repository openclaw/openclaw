using MediatR;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.UI.Dispatching;
using OpenClawWindows.Application.DeepLinks;
using OpenClawWindows.Application.Ports;
using OpenClawWindows.Application.TalkMode;
using OpenClawWindows.Application.VoiceWake;
using OpenClawWindows.Presentation.Canvas;
using OpenClawWindows.Presentation.Voice;
using OpenClawWindows.Presentation.DeepLinks;
using OpenClawWindows.Presentation.TalkMode;
using OpenClawWindows.Presentation.Tray;
using OpenClawWindows.Presentation.Tray.Components;
using OpenClawWindows.Presentation.ViewModels;
using OpenClawWindows.Presentation.WebChat;
using OpenClawWindows.Presentation.Windows;

namespace OpenClawWindows.Presentation;

public static class DependencyInjection
{
    public static IServiceCollection AddPresentation(this IServiceCollection services)
    {
        // Capture main-thread DispatcherQueue eagerly so background threads can dispatch to UI.
        // Must be called from the UI thread (App constructor).
        var mainQueue = DispatcherQueue.GetForCurrentThread();
        services.AddSingleton(mainQueue);

        // Tray
        services.AddSingleton<MenuSessionsInjector>();
        services.AddSingleton<MenuContextCardInjector>();
        services.AddSingleton<TrayIconPresenter>();
        services.AddSingleton<INotificationHandler<Domain.Events.TrayMenuStateChangedEvent>>(sp =>
            sp.GetRequiredService<TrayIconPresenter>());
        services.AddSingleton<SystemTrayViewModel>();
        services.AddSingleton<HoverHUDController>();
        services.AddSingleton<HoverHUDViewModel>();

        // Deep links
        services.AddSingleton<IDeepLinkConfirmation, Win32DeepLinkConfirmation>();
        services.AddSingleton<DeepLinkHandler>();

        // VoiceOverlaySessionController — implements IVoiceOverlayBridge so VoiceSessionCoordinator
        // can drive the overlay without importing Presentation from Application.
        // Also creates VoiceOverlayWindowController internally (not a DI singleton itself).
        services.AddSingleton<IVoiceOverlayBridge, VoiceOverlaySessionController>();

        // Overlay windows — transient so each show() creates a fresh instance
        services.AddTransient<VoiceOverlayViewModel>();
        services.AddTransient<TalkOverlayViewModel>();

        // TalkOverlay bridge — singleton adapter that manages TalkOverlayWindow lifecycle.
        services.AddSingleton<ITalkOverlayBridge, TalkOverlayBridgeAdapter>();

        // Dialog ViewModels — created on demand in presenters (not registered; pass constructor args)

        // Agent Events window — singleton so event log persists across show/hide
        services.AddSingleton<AgentEventsViewModel>();

        // Canvas — WebView2CanvasAdapter owns CanvasWindow + CanvasViewModel lifecycle
        // (recreates both after window.Closed).
        services.AddSingleton<IWebView2Host, WebView2CanvasAdapter>();

        // Web chat — WebChatManagerAdapter manages window + panel lifecycle.
        // WebChatViewModel is transient: each window/panel gets its own instance.
        services.AddSingleton<IWebChatManager, WebChatManagerAdapter>();
        services.AddTransient<WebChatViewModel>();

        // Settings ViewModel + all sub-page ViewModels
        services.AddTransient<TailscaleSettingsViewModel>();
        services.AddTransient<GeneralSettingsViewModel>();
        services.AddTransient<ChannelsSettingsViewModel>();
        services.AddTransient<SessionsSettingsViewModel>();
        services.AddTransient<PermissionsSettingsViewModel>();
        services.AddTransient<VoiceWakeSettingsViewModel>();
        services.AddTransient<SkillsSettingsViewModel>();
        services.AddTransient<InstancesSettingsViewModel>();
        services.AddTransient<CronSettingsViewModel>();
        services.AddTransient<ConfigSettingsViewModel>();
        services.AddTransient<SystemRunSettingsViewModel>();
        services.AddTransient<DebugSettingsViewModel>();
        services.AddTransient<AboutSettingsViewModel>();
        services.AddTransient<SettingsViewModel>();

        // Onboarding ViewModels — OnboardingViewModel singleton so wizard state persists;
        // OnboardingFlowViewModel transient so each first-run creates fresh flow state.
        services.AddSingleton<OnboardingViewModel>();
        services.AddTransient<OnboardingFlowViewModel>();

        return services;
    }
}
