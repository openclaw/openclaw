import Testing
@testable import OpenClaw

@Suite(.serialized)
@MainActor
struct AmbientOverlaySettingsNormalizationTests {
    @Test func `settings initializer clamps intensity and timeout`() {
        let low = AmbientOverlaySettings(
            isEnabled: true,
            displayScope: .currentDisplay,
            intensity: 0.01,
            timeoutSeconds: 1)
        let high = AmbientOverlaySettings(
            isEnabled: true,
            displayScope: .allDisplays,
            intensity: 3,
            timeoutSeconds: 500)

        #expect(low.intensity == 0.1)
        #expect(low.timeoutSeconds == 5)
        #expect(high.intensity == 1.0)
        #expect(high.timeoutSeconds == 120)
    }

    @Test func `settings initializer replaces non finite numeric values`() {
        let settings = AmbientOverlaySettings(
            isEnabled: true,
            displayScope: .currentDisplay,
            intensity: .nan,
            timeoutSeconds: .infinity)

        #expect(settings.intensity == AmbientOverlaySettings.defaultIntensity)
        #expect(settings.timeoutSeconds == AmbientOverlaySettings.defaultTimeoutSeconds)
    }

    @Test func `app state clamps stored ambient overlay numeric defaults on load`() async {
        await TestIsolation.withUserDefaultsValues([
            ambientOverlayIntensityKey: 0.01,
            ambientOverlayTimeoutSecondsKey: 500.0,
        ]) {
            let state = AppState(preview: true)

            #expect(state.ambientOverlayIntensity == 0.1)
            #expect(state.ambientOverlayTimeoutSeconds == 120)
        }
    }

    @Test func `app state clamps ambient overlay numeric values when set`() {
        let state = AppState(preview: true)

        state.ambientOverlayIntensity = 2
        state.ambientOverlayTimeoutSeconds = 1

        #expect(state.ambientOverlayIntensity == 1.0)
        #expect(state.ambientOverlayTimeoutSeconds == 5)
    }
}
