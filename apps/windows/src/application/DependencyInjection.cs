using Microsoft.Extensions.DependencyInjection;
using OpenClawWindows.Application.Behaviors;
using OpenClawWindows.Application.TalkMode;
using OpenClawWindows.Application.VoiceWake;
using OpenClawWindows.Domain.Canvas;

namespace OpenClawWindows.Application;

// Registers MediatR handlers and application-layer behaviors.
public static class DependencyInjection
{
    public static IServiceCollection AddApplication(this IServiceCollection services)
    {
        services.AddMediatR(cfg =>
        {
            cfg.RegisterServicesFromAssembly(typeof(DependencyInjection).Assembly);
            cfg.AddOpenBehavior(typeof(ValidationBehavior<,>));
            cfg.AddOpenBehavior(typeof(TraceabilityBehavior<,>));
        });

        // Canvas aggregate root — singleton so all canvas handlers share the same domain state.
        services.AddSingleton(_ => CanvasWindow.Create());

        // TalkModeController — singleton coordinator that subscribes to runtime events on construction.
        services.AddSingleton<TalkModeController>();

        // VoiceWakeForwarder — routes voice transcripts to the gateway via user.message RPC.
        services.AddSingleton<VoiceWakeForwarder>();
        services.AddSingleton<IVoiceWakeForwarder>(sp => sp.GetRequiredService<VoiceWakeForwarder>());

        // VoiceSessionCoordinator — orchestrates the voice overlay session lifecycle (wake-word + PTT).
        // IVoiceOverlayBridge resolved from Presentation layer in the same container.
        services.AddSingleton<VoiceSessionCoordinator>();
        services.AddSingleton<IVoiceSessionNotifier>(sp => sp.GetRequiredService<VoiceSessionCoordinator>());

        return services;
    }
}
